// ADR-0158 §5 pt.4/§8.1/§8.2 (FASE 3 — "o CANAL do serviço") — TODO o egresso/ingresso
// do RUNNER pelo `channel:` do manifesto: o reporte de fechamento de turno (§8.2), o
// alerta de falha (§8.1) e a ASK-ESPERA (§5 pt.4 — o coração desta fase). REUSA, do
// ADR-0154 (conector Telegram), exatamente a malha de confiança já existente:
//
//   • `TelegramClient`   — I/O concreto (long-poll `getUpdates` + `sendMessage`).
//   • `EgressRateLimiter`— TC-6, teto anti-spam — TODO envio (reporte/alerta/pergunta/
//                          alerta-de-timeout) passa por UMA ÚNICA instância, injetada
//                          por `runServiceRunner` e viva pelo processo inteiro (uma
//                          instância NOVA por chamada zeraria o teto — TC-6 furado).
//   • `classifyTelegramIngress`/`parseGetUpdates` (via `TelegramClient.poll`) — a
//     MESMA malha TC-1/TC-2 da sessão interativa. A allowlist aqui é SEMPRE
//     `{ chat-id do manifesto }` — nunca a allowlist de `aluy telegram allow` da
//     sessão do dono (são universos DIFERENTES: um serviço só ouve o SEU canal).
//   • `KeychainConnectorSecretStore('telegram')` — MESMO token da sessão (TC-3,
//     CLI-SEC-2 — nunca em config/arquivo/log).
//
// TC-5 herdada (ADR-0154): o ALVO é sempre `parseServiceTelegramChatId(manifest.channel)`
// — o chat-id do MANIFESTO, nunca um argumento do modelo nem um chat que apareça
// durante a ASK-ESPERA (o `allowlist` de 1 elemento garante que só ESSE chat pode
// responder — uma msg de outro chat nem chega a ser classificada como resposta).
//
// FAIL-OPEN (missão FASE 3, item 1): sem token no keychain ⇒ loga aviso e SEGUE — o
// runner NUNCA trava um turno (nem a ask-espera) por falta de canal. Ver `sendChannelText`
// e o ramo `no-channel` de `waitForOwnerReply`.
//
// I/O concreto (keychain + rede) — mora no `cli` (ADR-0053 §8); toda a formatação
// (§8.1/§8.2/§5 pt.4) e a decisão de timeout são PURAS, em `@hiperplano/aluy-cli-core`
// (`service-channel.ts`/`service-messages.ts`).

import {
  EgressRateLimiter,
  classifyTelegramIngress,
  parseServiceTelegramChatId,
  formatServiceTurnReport,
  formatServiceFailureAlert,
  formatServiceAskMessage,
  formatServiceAskTimeoutAlert,
  DEFAULT_ASK_TIMEOUT_MS,
  hasAskTimedOut,
  type ServiceManifest,
  type ServiceTurnClosure,
  type ConnectorSecretStore,
  type TelegramUpdate,
} from '@hiperplano/aluy-cli-core';
import { KeychainConnectorSecretStore } from '../auth/connector-secret-store.js';
import { TelegramClient } from '../connector/telegram-client.js';
import { TELEGRAM_EGRESS_MAX, TELEGRAM_EGRESS_WINDOW_MS } from '../connector/telegram-bridge.js';

/**
 * Contrato mínimo que o canal do serviço precisa do client (send+poll+safeForLog) —
 * `TelegramClient` cumpre estruturalmente, sem adaptador. Testes injetam um FAKE com
 * este contrato — a suíte NUNCA toca a rede real (mesma disciplina de `telegram-bridge.test.ts`).
 */
export interface ServiceChannelClient {
  send(chatId: number, text: string, signal?: AbortSignal): Promise<boolean>;
  poll(signal?: AbortSignal): Promise<readonly TelegramUpdate[]>;
  safeForLog(text: string): string;
}

/** Variável TEST-ONLY (documentada, ver missão FASE 3): quando setada, `waitForOwnerReply`
 * devolve esta string como resposta do dono IMEDIATAMENTE, sem tocar keychain/rede. Existe
 * só para o smoke-test do BINÁRIO REAL rodar a ASK-ESPERA sem precisar de um bot/token de
 * verdade. Nenhum caminho de produção a define — não é uma feature, é um hook de teste. */
export const ASK_TEST_REPLY_ENV = 'ALUY_SERVICE_ASK_TEST_REPLY';

export interface ServiceChannelDeps {
  /** Store do token (keychain). Default: `KeychainConnectorSecretStore('telegram')`. */
  readonly secretStore?: ConnectorSecretStore;
  /** Fábrica do client injetável (teste — sem rede real). Default: `TelegramClient` real. */
  readonly clientFactory?: (token: string) => ServiceChannelClient;
  /** A ÚNICA catraca anti-spam (TC-6) — deve ser UMA instância por processo do runner,
   * passada pelo caller (nunca recriada por chamada, ou o teto vira sem efeito). */
  readonly egressLimiter: EgressRateLimiter;
  /** Relógio injetável (teste — timeout determinístico sem depender de tempo real). */
  readonly now?: () => number;
  readonly log: (line: string) => void;
  /** Teto da ASK-ESPERA (default 24h — ver `DEFAULT_ASK_TIMEOUT_MS`, TODO documentado lá). */
  readonly askTimeoutMs?: number;
}

/** Fábrica DEFAULT do `EgressRateLimiter` do canal do serviço — mesmos tetos do
 * `telegram_send` da sessão interativa (ADR-0154 TC-6): 20 envios/60s. O CALLER
 * (`runServiceRunner`) cria UMA instância e a reusa por todo o processo. */
export function newServiceEgressLimiter(): EgressRateLimiter {
  return new EgressRateLimiter(TELEGRAM_EGRESS_MAX, TELEGRAM_EGRESS_WINDOW_MS);
}

/** Resolve `{ chatId, client }` prontos p/ enviar/ouvir, OU `undefined` com o motivo
 * (fail-open: sem "channel:"/canal não-Telegram, ou sem token no keychain). Ponto
 * ÚNICO de leitura do keychain — report/alert/ask passam todos por aqui. */
async function resolveActiveChannel(
  manifest: ServiceManifest,
  deps: ServiceChannelDeps,
): Promise<{ readonly chatId: number; readonly client: ServiceChannelClient } | { readonly reason: string }> {
  const chatId = parseServiceTelegramChatId(manifest.channel);
  if (chatId === undefined) {
    return {
      reason:
        manifest.channel === undefined
          ? 'serviço sem "channel:" declarado'
          : `"channel: ${manifest.channel}" não é um canal Telegram suportado (única fase v1)`,
    };
  }
  const secretStore = deps.secretStore ?? new KeychainConnectorSecretStore('telegram');
  let token: string | null;
  try {
    token = await secretStore.get();
  } catch {
    token = null; // keychain indisponível ⇒ trata como sem token (fail-open, não lança).
  }
  if (token === null || token.trim() === '') {
    return { reason: 'sem token de Telegram no keychain — rode "aluy telegram login"' };
  }
  const client = deps.clientFactory ? deps.clientFactory(token) : new TelegramClient({ token });
  return { chatId, client };
}

/** Envia UM texto pro canal do serviço — TC-6 (catraca) + fail-open uniforme. Usado
 * por report/alert/timeout-alert (a pergunta em si tem seu próprio ponto em
 * `waitForOwnerReply`, que precisa do `client`/`chatId` vivos para o poll seguinte). */
async function sendChannelText(
  manifest: ServiceManifest,
  text: string,
  deps: ServiceChannelDeps,
): Promise<void> {
  const log = deps.log;
  const resolved = await resolveActiveChannel(manifest, deps);
  if (!('client' in resolved)) {
    log(`[service/channel] mensagem NÃO enviada (fail-open) — ${resolved.reason}.`);
    return;
  }
  const now = deps.now ?? Date.now;
  if (!deps.egressLimiter.tryConsume(now())) {
    log('[service/channel] teto anti-spam (TC-6) atingido — mensagem NÃO enviada.');
    return;
  }
  try {
    const ok = await resolved.client.send(resolved.chatId, text);
    if (!ok) log('[service/channel] falha ao enviar (Bot API recusou/erro de rede) — seguindo (fail-open).');
  } catch (err) {
    log(`[service/channel] erro ao enviar — ${resolved.client.safeForLog(String(err))}`);
  }
}

/** §8.2 — reporte de fechamento de turno. FAIL-OPEN: sem canal/token, loga e segue —
 * nunca bloqueia o runner (a missão explícita: "sem token ⇒ loga aviso e segue"). */
export async function sendServiceReport(
  manifest: ServiceManifest,
  closure: ServiceTurnClosure,
  deps: ServiceChannelDeps,
): Promise<void> {
  await sendChannelText(manifest, formatServiceTurnReport(closure), deps);
}

/** §8.1 — alerta de falha ("turno que não abriu... nunca silêncio"). Mesmo fail-open
 * do reporte — a AUSÊNCIA de canal não pode travar o runner, só reduz a visibilidade
 * (o `runner.log` sempre tem o motivo; o alerta é a camada extra quando há canal). */
export async function sendServiceAlert(
  manifest: ServiceManifest,
  reason: string,
  deps: ServiceChannelDeps,
): Promise<void> {
  await sendChannelText(manifest, formatServiceFailureAlert(manifest.name, reason), deps);
}

export type AskWaitResult =
  | { readonly kind: 'answered'; readonly text: string }
  | { readonly kind: 'timeout' }
  /** Sem canal/token utilizável — o CALLER decide o fallback (ADR-0158 fase 2: loga
   * e para o runner até `aluy service start` manual — nunca finge que perguntou). */
  | { readonly kind: 'no-channel'; readonly reason: string }
  /** `stop` (SIGTERM/`aluy service stop`) disparou durante a espera. */
  | { readonly kind: 'stopped' };

/**
 * §5 pt.4 (O CORAÇÃO DA FASE 3) — envia a PERGUNTA pendente ao canal do manifesto e
 * ENTRA EM MODO ESPERA: long-poll `getUpdates` (via `TelegramClient.poll`, cancelável
 * por `stop`), classificando CADA update pela MESMA malha da sessão interativa
 * (`classifyTelegramIngress`) contra uma allowlist de UM elemento — o chat-id do
 * MANIFESTO (nunca a allowlist de sessão). `kind:'instruction'` ⇒ é a resposta do
 * dono (retoma o turno); `kind:'data'`/`'discard'` ⇒ ignorado, a espera CONTINUA
 * (regra dura §3/§5 pt.4: nunca prossegue com suposição — só uma INSTRUÇÃO do dono
 * autorizado encerra a espera). Timeout (default 24h, `DEFAULT_ASK_TIMEOUT_MS`) ⇒
 * alerta no canal + `{kind:'timeout'}`, e o CALLER encerra o turno sem ação.
 */
export async function waitForOwnerReply(args: {
  readonly manifest: ServiceManifest;
  readonly question: string;
  readonly stop: AbortSignal;
  readonly deps: ServiceChannelDeps;
}): Promise<AskWaitResult> {
  const { manifest, question, stop, deps } = args;
  const log = deps.log;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;

  // TEST-ONLY — ver `ASK_TEST_REPLY_ENV` acima. Verificado ANTES de tocar
  // keychain/rede (o smoke-test roda com HOME falso, sem token real).
  const testReply = process.env[ASK_TEST_REPLY_ENV];
  if (testReply !== undefined) {
    log(`[service/channel] ${ASK_TEST_REPLY_ENV} setado — resposta mockada TEST-ONLY (sem rede real).`);
    return { kind: 'answered', text: testReply };
  }

  const resolved = await resolveActiveChannel(manifest, deps);
  if (!('client' in resolved)) {
    log(`[service/channel] ask-espera não enviada (fail-open) — ${resolved.reason}.`);
    return { kind: 'no-channel', reason: resolved.reason };
  }
  const { chatId, client } = resolved;

  const askText = formatServiceAskMessage(manifest.name, question);
  if (!deps.egressLimiter.tryConsume(now())) {
    log('[service/channel] ask-espera: teto anti-spam (TC-6) atingido — pergunta NÃO enviada; aguardando mesmo assim.');
  } else {
    try {
      const ok = await client.send(chatId, askText);
      log(
        ok
          ? `[service/channel] pergunta enviada ao canal (chat ${chatId}) — aguardando resposta do dono.`
          : '[service/channel] falha ao enviar a pergunta (Bot API recusou/erro de rede) — aguardando mesmo assim.',
      );
    } catch (err) {
      log(`[service/channel] erro ao enviar a pergunta — ${client.safeForLog(String(err))}`);
    }
  }

  const startedAtMs = now();
  // TC-5 — allowlist de UM elemento: SÓ o chat-id do manifesto pode responder. Uma
  // mensagem de qualquer outro chat nem chega a ser classificada como resposta.
  const allowlist = new Set<number>([chatId]);

  while (!stop.aborted) {
    if (hasAskTimedOut(startedAtMs, now(), timeoutMs)) {
      const waitedMs = now() - startedAtMs;
      const alertText = formatServiceAskTimeoutAlert(manifest.name, question, waitedMs);
      if (deps.egressLimiter.tryConsume(now())) {
        try {
          await client.send(chatId, alertText);
        } catch {
          /* fail-open — o alerta é best-effort; o log já registra o timeout abaixo. */
        }
      }
      log('[service/channel] ask-espera: TIMEOUT — sem resposta do dono; turno encerra sem ação (§5 pt.4).');
      return { kind: 'timeout' };
    }

    let updates: readonly TelegramUpdate[];
    try {
      updates = await client.poll(stop);
    } catch {
      updates = []; // fail-safe — uma rodada ruim não derruba a espera.
    }
    if (stop.aborted) break;

    for (const u of updates) {
      const decision = classifyTelegramIngress(u, allowlist);
      if (decision.kind === 'instruction') {
        log('[service/channel] dono respondeu no canal — retomando o turno de onde parou.');
        return { kind: 'answered', text: decision.text };
      }
      if (decision.kind === 'discard') {
        log(`[service/channel] ask-espera: ingresso descartado (${decision.reason}).`);
      } else {
        log('[service/channel] ask-espera: ingresso classificado como DADO (não-confiável) — ignorado.');
      }
    }
  }
  return { kind: 'stopped' };
}
