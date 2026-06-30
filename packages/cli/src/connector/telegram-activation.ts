// Ativação da bridge Telegram no BOOT (ADR-0134 / ADR-0135) — a peça concreta que junta o
// KEYCHAIN (token) + a CONFIG (allowlist) + o I/O (client/connector) e devolve a `TelegramBridge`
// pronta, OU sinaliza por que NÃO ativou. É o ponto que o `--telegram` chama em run.tsx.
//
// C6 (DORMENTE até credencial) — a regra de OURO desta peça:
//   • SEM token no keychain ⇒ a bridge NÃO sobe. O boot NÃO falha: devolvemos `active:false`
//     com um motivo. NENHUM client é instanciado ⇒ ZERO egress (nada chega a api.telegram.org).
//   • Com `--telegram` mas SEM token ⇒ `reason` claro mandando rodar `aluy telegram login`.
//   • NUNCA embutimos token: ele só vem do keychain (sem fallback em claro — CLI-SEC-2/TC-3).
//
// PURO de UI: aqui não há Ink; só composição. O sink (injeção na sessão) e o teardown são do
// caller (run.tsx), que conhece o `SessionController` vivo.

import { TelegramClient } from './telegram-client.js';
import { TelegramConnector } from './telegram-connector.js';
import {
  TelegramBridge,
  type IngressSink,
  type TelegramBridgeOptions,
} from './telegram-bridge.js';
import {
  parseAllowlist,
  type ConnectorSecretStore,
  type ConversationRef,
} from '@hiperplano/aluy-cli-core';
import { KeychainConnectorSecretStore } from '../auth/connector-secret-store.js';
import { UserConfigStore, telegramAllowlist } from '../io/user-config.js';

export interface ActivateTelegramOptions {
  /** Para onde o ingresso classificado vai (instrução × dado) — o `SessionController` vivo. */
  readonly sink: IngressSink;
  /** Store do token (keychain). Injetável p/ teste. Default: keychain real do conector. */
  readonly secretStore?: ConnectorSecretStore;
  /** Store da config (allowlist). Injetável p/ teste. Default: `~/.aluy/config.json`. */
  readonly configStore?: UserConfigStore;
  /**
   * `fetch` injetável (teste — a suíte NUNCA toca a rede real). Default: o global. SÓ é usado
   * quando há token (caminho ativo). Sem token, nada é construído ⇒ nem o fetch é referenciado.
   */
  readonly fetchFn?: typeof fetch;
  /** Overrides repassados à `TelegramBridge` (catraca/relógio/log) — teste. */
  readonly bridgeOverrides?: Pick<TelegramBridgeOptions, 'egressLimiter' | 'now' | 'log'>;
}

/** O resultado da ativação: ou subiu (bridge ativa) ou não (com o motivo p/ a UI explicar). */
export type ActivateTelegramResult =
  | {
      readonly active: true;
      /** A bridge pronta — o caller chama `pump()` e registra `sendTool()` no toolset. */
      readonly bridge: TelegramBridge;
      /** Nº de chats na allowlist (p/ um aviso "fechada" quando 0, sem vazar os ids). */
      readonly allowlistSize: number;
    }
  | {
      readonly active: false;
      /** Por que NÃO ativou (C6) — mensagem pronta p/ o stderr/aviso da TUI. */
      readonly reason: string;
    };

/**
 * Tenta ativar a bridge Telegram. NÃO lança (o boot é robusto): qualquer falha de leitura do
 * keychain/config ⇒ `active:false` com motivo, NUNCA uma exceção que derrube a sessão.
 *
 * C6 — a ordem importa: PRIMEIRO o token (presença), e SÓ com token construímos o client (o
 * único que abre egress). Sem token ⇒ retornamos cedo, sem instanciar NADA de rede.
 */
export async function activateTelegram(
  opts: ActivateTelegramOptions,
): Promise<ActivateTelegramResult> {
  const secretStore = opts.secretStore ?? new KeychainConnectorSecretStore('telegram');
  const configStore = opts.configStore ?? new UserConfigStore();

  // C6 — PRESENÇA do token primeiro. Leitura fail-safe: o store devolve null em ausência/erro
  // (nunca lança aqui), mas embrulhamos por garantia (boot robusto).
  let token: string | null;
  try {
    token = await secretStore.get();
  } catch {
    // Keychain indisponível ⇒ trata como SEM token (não ativa). O boot segue.
    token = null;
  }
  if (token === null || token.trim() === '') {
    // C6 — DORMENTE: sem token, a bridge NÃO sobe e NENHUM client é construído ⇒ zero egress.
    return {
      active: false,
      reason:
        'Telegram pedido (--telegram) mas sem token no keychain — rode `aluy telegram login`. ' +
        'A bridge segue desativada (nenhuma conexão é aberta).',
    };
  }

  // A allowlist (DADO de config). VAZIA é VÁLIDO: a malha descarta tudo (default fechado, C2)
  // — a bridge sobe e fica "fechada" até `aluy telegram allow <chat-id>`. Não é erro de boot.
  let allowlist: ReadonlySet<ConversationRef>;
  try {
    const ids = telegramAllowlist(configStore.load());
    // `parseAllowlist` valida os ids (numéricos inteiros); a malha casa por string (chat-id).
    const numeric = parseAllowlist(ids);
    allowlist = new Set<ConversationRef>(Array.from(numeric, (n) => String(n)));
  } catch {
    allowlist = new Set<ConversationRef>(); // config ilegível ⇒ FECHADA (fail-closed, C2).
  }

  // SÓ AGORA (com token) construímos o I/O. O client TRAVA o egress em api.telegram.org
  // (allowNonDefaultApiBase NÃO é passado ⇒ host forçado — config/env não redireciona).
  const client = new TelegramClient({
    token,
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
  // A bridge cria seu próprio AbortController e passa o `signal` à FÁBRICA do connector, p/ o
  // long-poll ser cancelável no teardown (bridge.stop() → connector.incoming() encerra).
  const bridge = new TelegramBridge({
    connectorFactory: (signal) => new TelegramConnector(client, { signal }),
    allowlist,
    sink: opts.sink,
    redactor: client,
    ...(opts.bridgeOverrides ?? {}),
  });
  return { active: true, bridge, allowlistSize: allowlist.size };
}
