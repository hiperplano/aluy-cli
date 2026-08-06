// ADR-0158 §5 — O RUNNER: UM PROCESSO POR SERVIÇO. Este módulo É o corpo do
// "processo que É o serviço" (`aluy service run <nome> --runner`, spawnado
// DESTACADO por `aluy service start <nome>` — ver `commands/service.ts`). Ciclo:
//
//   1. lê `service.md` (via `UserServicesStore`, já validado — cron/workflow OK);
//   2. dorme até o `schedule` (§5 pt.2 — "fora do horário, o serviço nem acorda:
//      regra dura por construção" — `nextCronFire`, cli-core). EXCEÇÃO — só na
//      PRIMEIRA volta do laço, `immediate: true` fura esta regra de propósito: um
//      turno roda JÁ, ANTES desta primeira soneca (respeitando `until:` — ver
//      `canRunImmediateNow`, abaixo, e o comentário no laço principal). Cada
//      REINÍCIO do runner (crash-loop, `stop`/`start` manual, reboot) começa um
//      laço NOVO — a própria PRIMEIRA volta dele — então também dispara: risco
//      aceito e documentado (nenhuma proteção extra contra crash-loop aqui), não
//      "por descuido" — ver o manifesto visível, onde isto fica marcado com ⚠;
//   3. no início do expediente: sobe os daemons próprios (§6) + abre um TURNO
//      HEADLESS por atividade do `workflow:`, com wiring ESCOPADO (§2 — via a env
//      var interna `ALUY_SERVICE_HOME` que `run.tsx`/`wiring.ts` já respeitam);
//   4. `until:` atingido ⇒ encerra o turno (mata o processo-filho) — regra dura §3;
//   5. `budget:` ⇒ vira `--max-tokens` (reusa `resolveMaxTokens`/`limits.ts` via a
//      flag JÁ existente do `aluy -p`, sem duplicar o clamp anti-runaway);
//   6. fechamento de turno com pergunta pendente (`awaitsUserDecision`, ADR-0157) ⇒
//      loga "aguardando dono", ENVIA a pergunta ao `channel:` do manifesto e ENTRA
//      EM ASK-ESPERA (long-poll Telegram via `channel.ts`, FASE 3, §5 pt.4) — nunca
//      prossegue com suposição. Resposta do dono ⇒ RETOMA a MESMA atividade com
//      pergunta+resposta anexadas; timeout (24h default) ⇒ alerta e encerra o turno
//      sem ação; sem canal/token utilizável ⇒ fail-open, cai no comportamento da
//      fase 2 (loga e para o processo até `aluy service start` manual);
//   6b. fim de turno (ok/parado) ⇒ REPORTE de fechamento no canal (§8.2); turno que
//      não abriu/crashou ⇒ ALERTA (§8.1) — `channel.ts`, sempre fail-open sem token;
//   7. volta a dormir até o próximo `schedule`.
//
// Cada ATIVIDADE do workflow é UM turno headless `aluy -p` em processo FILHO
// separado (não in-process): teardown de recursos (MCP/broker) garantido pelo SO a
// cada turno — o runner pode viver dias/semanas sem acumular handle vazado de N
// turnos (o caminho `-p` do `aluy` foi desenhado para "roda e sai", não para ser
// chamado repetidamente num processo hospedeiro de vida longa).
//
// SIGTERM (`aluy service stop`) ⇒ derruba os daemons, mata o turno em andamento
// (gracioso: SIGTERM no filho, SIGKILL de timeout), remove o pidfile, sai.
//
// ADR-0158 §11 (FASE 4) — o ATTACH: o socket local (`attach-server.ts`) sobe JUNTO
// com o runner (o próprio processo do serviço o serve, §11 — "conecta ao processo do
// serviço") e publica TRÊS coisas: (a) toda linha de log ao vivo (o `log()` local
// abaixo é ENVOLVIDO p/ também `broadcastLog`); (b) toda transição de estado (o
// helper `setStatus` abaixo ENVOLVE `writeServiceStatus` do jeito que `log` envolve
// `appendLog`); (c) melhor esforço, os blocos NOVOS da sessão ativa do turno em
// andamento (`attach-blocks.ts`, tail periódico). Em troca, o socket aceita UM
// evento de entrada — `say` (a fala do dono digitado no `attach`) — tratado conforme
// a FASE corrente (`currentPhase`, abaixo): ASK-ESPERA ⇒ resposta LOCAL (corre
// contra o Telegram via `LocalAnswerChannel`/`waitForOwnerReply`); DORMINDO/TURNO EM
// ANDAMENTO ⇒ enfileirado (`pendingSay`) e entregue à PRÓXIMA atividade que abrir
// (degrade documentado — `formatOwnerSayInjection`, cli-core: mid-turno DE VERDADE
// exigiria plumbing no processo-filho que não existe).

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  nextCronFire,
  parseServiceBudget,
  parseServiceActivityTimeout,
  avisoActivityTimeout,
  msUntilDeadline,
  awaitsUserDecision,
  runWorkflow,
  parseWorkflow,
  isWorkflowError,
  formatServiceResumeInstruction,
  formatOwnerSayInjection,
  SERVICE_AUTONOMOUS_MODE,
  type WorkflowActivity,
  type WorkflowActivityOutcome,
  type WorkflowActivityRunner,
  type WorkflowRunResult,
} from '@hiperplano/aluy-cli-core';
import { UserServicesStore, isServiceEntryError, type ServiceEntry } from '../io/services-store.js';
import { runnerPidPath } from './paths.js';
import { writePidFile, removePidFile } from './pid.js';
import { appendLog } from './log.js';
import { runnerLogPath } from './paths.js';
import { writeServiceStatus, type ServiceTurnState, type ServiceStatusSnapshot } from './status.js';
import { startDaemons, stopDaemons } from './daemons.js';
// ADR-0158 §5 pt.4/§8.1/§8.2 (FASE 3) — o CANAL do serviço: reporte de fechamento,
// alerta de falha e a ASK-ESPERA (reusa TelegramClient/EgressRateLimiter/malha do
// ADR-0154 — ver `channel.ts`). Todo I/O de rede/keychain fica confinado ali.
import {
  sendServiceReport,
  sendServiceAlert,
  waitForOwnerReply,
  newServiceEgressLimiter,
  type ServiceChannelDeps,
} from './channel.js';
// ADR-0158 §11 (FASE 4) — o ATTACH: socket local (servido POR este processo) + o
// tail de blocos da sessão ativa. Ver o comentário do topo do arquivo.
import { startAttachServer, type AttachServer } from './attach-server.js';
import { pollNewServiceBlocks, newAttachBlockTailState } from './attach-blocks.js';
import { LocalAnswerChannel } from './attach-say.js';

/** Teto duro por ATIVIDADE, mesmo sem `until:` declarado — anti-runaway (CLI-SEC-8):
 * um serviço sem `until:` não pode travar o runner p/ sempre num turno preso. */
const MAX_ACTIVITY_MS = 30 * 60_000; // 30 minutos

/** Timeout de graça entre SIGTERM e SIGKILL de um processo-filho (turno ou daemon). */
const GRACE_KILL_MS = 8_000;

export interface RunServiceRunnerDeps {
  /** Raiz do `~/.aluy/` (default: home real). Injetável p/ teste (tmpdir) — NUNCA o
   * HOME real em teste (a mesma trava do smoke-test manual pedida na missão). */
  readonly aluyBaseDir?: string;
  readonly log?: (line: string) => void;
  /** Caminho do entrypoint `aluy` a re-invocar por turno (default: o mesmo script
   * deste processo, `process.argv[1]`) — injetável p/ teste. */
  readonly aluyEntrypoint?: string;
  readonly execPath?: string;
  /** Sinal externo de parada (teste) — além do SIGTERM/SIGINT reais do processo. */
  readonly externalStop?: AbortSignal;
  /** ADR-0158 §5 pt.4 (FASE 3) — overrides do CANAL (keychain/client/relógio/timeout
   * da ask-espera), INJETÁVEIS p/ teste — a suíte NUNCA toca keychain/rede reais. O
   * `egressLimiter` (TC-6), quando omitido, é criado UMA vez por processo (abaixo) —
   * nunca por chamada, senão o teto anti-spam perderia o efeito. */
  readonly channelDeps?: Partial<ServiceChannelDeps>;
  /**
   * CHAVE-REVOGADA — resolvedor da credencial local do BOOT do runner. INJETÁVEL p/
   * teste (a suíte NUNCA toca o keychain real). Ausente em produção ⇒ usa o resolvedor
   * de verdade, e qualquer falha dele é engolida (best-effort: os filhos seguem
   * resolvendo sozinhos, como antes).
   */
  readonly resolverCredencial?: () => Promise<string | undefined>;
}

/**
 * CHAVE-REVOGADA — lê a credencial local UMA vez, p/ o runner segurá-la pelo expediente.
 * NUNCA lança e NUNCA loga a chave (nem o tamanho): em caso de falha, avisa em UMA linha
 * sem segredo e devolve `undefined` — o comportamento antigo, byte a byte.
 */
async function resolverCredencialDoRunner(
  injetado: (() => Promise<string | undefined>) | undefined,
  log: (line: string) => void,
): Promise<string | undefined> {
  try {
    if (injetado !== undefined) return await injetado();
    const { UserConfigStore } = await import('../io/user-config.js');
    const cfg = new UserConfigStore().load();
    // Só faz sentido no backend LOCAL/BYO — no broker a credencial é outra história.
    const backend = cfg.backend ?? 'local';
    if (backend !== 'local') return undefined;
    const provider = cfg.localProvider;
    if (provider === undefined) return undefined;
    const { createLocalCredentialProvider } = await import('../model/local/credential-resolver.js');
    const cred = await createLocalCredentialProvider({
      provider: provider as Parameters<typeof createLocalCredentialProvider>[0]['provider'],
    })();
    return cred.kind === 'apikey' && cred.secret !== '' ? cred.secret : undefined;
  } catch (e) {
    log(
      '[credencial] o runner não conseguiu ler a credencial local no boot — cada atividade ' +
        `vai resolver sozinha (motivo: ${e instanceof Error ? e.message : String(e)}).`,
    );
    return undefined;
  }
}

function killGracefully(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* já morreu */
  }
  const t = setTimeout(() => {
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch {
      /* já morreu */
    }
  }, GRACE_KILL_MS);
  t.unref();
}

// FIX (bug pré-existente da FASE 2, achado na FASE 4) — `setTimeout(ms)` do Node
// CLAMPA silenciosamente qualquer `ms` > 2^31-1 (~24,8 dias — overflow do int32
// interno do timer) para ~1ms. Um serviço com `schedule:` apontando bem longe no
// futuro (cron mensal/anual, ou o dono corrigindo o relógio do sistema pra trás)
// faria o `setTimeout` de UM TIRO da versão anterior acordar quase instantaneamente
// e o runner ENTRAR EM LOOP DE TURNOS — reabrindo o turno a cada ~1ms até o
// `schedule` de verdade chegar. O fix: dormir em FATIAS com teto por fatia
// (`MAX_SLEEP_SLICE_MS`, bem abaixo do limite do Node), RE-CHECANDO o alvo a cada
// fatia — nenhuma fatia individual jamais chega perto do overflow.
const MAX_SLEEP_SLICE_MS = 24 * 60 * 60_000; // 1 dia — teto por fatia.

/**
 * Calcula quanto dormir NESTA fatia — PURA (sem I/O/timer), testável direto sem
 * mockar relógio/timer. O menor entre o tempo restante até `targetMs` e o teto
 * `capMs`; nunca negativo (alvo já passado ⇒ 0, "dormir zero" = acordar já).
 */
export function sleepSliceMs(nowMs: number, targetMs: number, capMs: number = MAX_SLEEP_SLICE_MS): number {
  const remaining = Math.max(0, targetMs - nowMs);
  return Math.min(remaining, capMs);
}

/** Uma ÚNICA espera de `ms` (< teto por fatia, nunca clampa) OU até `stop` disparar. */
function sleepOnce(ms: number, stop: AbortSignal): Promise<'woke' | 'stopped'> {
  return new Promise((resolve) => {
    if (stop.aborted) {
      resolve('stopped');
      return;
    }
    const timer = setTimeout(() => {
      stop.removeEventListener('abort', onAbort);
      resolve('woke');
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve('stopped');
    };
    stop.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Espera até `date` OU até `stop` disparar — o que vier primeiro. Dorme em FATIAS
 * (teto `MAX_SLEEP_SLICE_MS`, ver comentário acima) — nunca um único
 * `setTimeout` com `ms` grande o bastante pra clampar no Node. A cada fatia,
 * RE-CHECA o alvo contra o relógio atual (`Date.now()`), então também se recupera
 * corretamente se o relógio do sistema mudar durante a espera.
 */
export async function sleepUntil(date: Date, stop: AbortSignal): Promise<'woke' | 'stopped'> {
  const targetMs = date.getTime();
  for (;;) {
    if (stop.aborted) return 'stopped';
    const ms = sleepSliceMs(Date.now(), targetMs);
    if (ms <= 0) return 'woke';
    const outcome = await sleepOnce(ms, stop);
    if (outcome === 'stopped') return 'stopped';
    // fatia terminou sem atingir o alvo ainda ⇒ volta ao topo, recalcula o restante.
  }
}

/**
 * `immediate: true` decide se o turno JÁ pode rodar (PRIMEIRA volta do laço,
 * antes de qualquer soneca de cron) — PURA (usa `msUntilDeadline`, cli-core; sem
 * I/O). Decisão de projeto: `until:` continua valendo — a regra de fim de
 * expediente é mais forte que a conveniência de rodar já. Sem `until:` declarado
 * (`undefined`) ⇒ sem teto, sempre pode. Com `until:` já vencido HOJE (`<= 0` ms
 * restantes) ⇒ não pode — o runner pula o imediato e cai direto no ciclo normal
 * de cron (o CALLER loga o motivo). Testável direto, sem subir o runner inteiro.
 */
export function canRunImmediateNow(now: Date, until: string | undefined): boolean {
  const remainingMs = msUntilDeadline(now, until);
  return remainingMs === undefined || remainingMs > 0;
}

/**
 * ADR-0158 §4.1 (FUNIL) — monta o `goal` de UMA atividade do workflow. PURA (sem
 * I/O) — testável direto, sem spawnar processo nenhum.
 *
 * Fecha o DEGRADE #3 da rc.113: antes, TODA atividade recebia o preâmbulo do
 * orquestrador + (se `[agente]`) uma DICA TEXTUAL ("execute como o agente X via
 * spawn_agent") que o modelo podia simplesmente ignorar — rodando como
 * orquestrador, com o toolset COMPLETO do serviço. Agora:
 *   · atividade COM `activity.agent` ([agente]) ⇒ o preâmbulo do orquestrador NÃO
 *     entra — a atividade É da persona, não do orquestrador (anatomia do
 *     `service.md`, ADR-0158 §1: "atividades SEM [agente] executam COMO O
 *     ORQUESTRADOR; passos com [agente] delegam"). A dica textual de `spawn_agent`
 *     SAI do prompt — não é mais dica, é TRAVA: o turno filho nasce JÁ TRAVADO
 *     naquela persona via `ALUY_SERVICE_PERSONA` (`buildActivityEnv` abaixo),
 *     consumida por `run.tsx`/`controller.lockPersonaForTurn` ANTES do primeiro
 *     tool-call — a persona não escolhe obedecer, o boot decide por construção.
 *   · atividade SEM `activity.agent` ⇒ comportamento IDÊNTICO ao de antes (o
 *     preâmbulo entra — a atividade roda COMO O ORQUESTRADOR, toolset completo).
 */
export function buildActivityGoal(args: {
  readonly orchestratorPreamble: string;
  readonly activity: Pick<WorkflowActivity, 'id' | 'goal' | 'agent'>;
  readonly index: number;
  readonly total: number;
  /** ADR-0158 §5 pt.4 (FASE 3) — RETOMADA pós ASK-ESPERA (pergunta+resposta do dono). */
  readonly resumeContext?: string;
  /** ADR-0158 §11 (FASE 4) — fala(s) do dono via `aluy service attach`. */
  readonly ownerSayContext?: string;
}): string {
  const resumePrefix = args.resumeContext !== undefined ? `${args.resumeContext}\n\n` : '';
  const sayPrefix = args.ownerSayContext !== undefined ? `${args.ownerSayContext}\n\n` : '';
  const activityHeader =
    `[Atividade ${args.index + 1}/${args.total} do workflow — id "${args.activity.id}"]\n` +
    args.activity.goal;
  return args.activity.agent !== undefined
    ? `${resumePrefix}${sayPrefix}${activityHeader}`
    : `${args.orchestratorPreamble}\n\n${resumePrefix}${sayPrefix}${activityHeader}`;
}

/**
 * ADR-0158 §4.1 (FUNIL) — monta o `env` do turno-filho de UMA atividade. PURA (sem
 * I/O) — testável direto. `ALUY_SERVICE_HOME` sempre entra (§2, wiring escopado);
 * `ALUY_SERVICE_PERSONA` SÓ quando a atividade declara `[agente]` — a env INTERNA
 * (mesmo padrão de `ALUY_SERVICE_HOME`, nunca flag pública) que `run.tsx` consome
 * no BOOT do turno filho para travá-lo na persona ANTES do primeiro tool-call
 * (fail-closed lá: nome desconhecido ⇒ o filho nem abre sessão).
 *
 * ADR-0158 — `autonomy` (o `service.manifest.autonomy` cru) vira a env
 * `ALUY_SERVICE_AUTONOMY`, MESMO padrão: só INTERNA (nunca flag pública, nunca
 * alcançável pela sessão interativa do dono — `run.tsx` só a lê quando
 * `ALUY_SERVICE_HOME` TAMBÉM está presente). SÓ entra quando o manifesto
 * declarou `autonomy: yolo-scoped` — `ask`/ausente ⇒ a CHAVE nem existe no
 * objeto (o default, "sem `autonomy:` ou com `ask`", fica byte-a-byte igual
 * a antes: nem uma chave nova aparece no `env`).
 *
 * ADR-0158 — `workspaceRoots` (`ServiceEntry.resolvedWorkspaceRoots`, JÁ
 * canonicalizado/validado por `resolveServiceWorkspaceRoots` — `io/services-store.ts`)
 * vira a env `ALUY_SERVICE_WORKSPACE_ROOTS` (JSON de um array de paths absolutos),
 * MESMO padrão: só INTERNA, só quando NÃO-VAZIA. `wiring.ts` (`buildSession`) é
 * quem lê e chama `workspace.addRoot(...)` p/ cada uma — este parser só monta o
 * `env`, não autoriza nada ele mesmo. Ausente/vazia ⇒ a CHAVE nem existe no objeto
 * (comportamento IDÊNTICO ao de hoje — só a raiz primária do turno).
 */
/**
 * RELATÓRIO-VIRA-PERGUNTA (dogfooding real) — o serviço do dono ficou `AGUARDANDO DONO`
 * sobre um turno que tinha CONCLUÍDO. A "pergunta pendente" no `service status` era a
 * saída INTEIRA da atividade: 4 mil caracteres de análise quantitativa (setups de
 * USDBRL/IBOV/BTC com entrada, stop, alvo e R:R) abertos por
 * `"status": "completed", "exitCode": 0`. Ninguém perguntou nada — e o expediente parou.
 *
 * A causa é reúso de heurística ENTRE CONTEXTOS COM CUSTOS DIFERENTES.
 * `awaitsUserDecision` nasceu p/ o gate do SELF-CHECK, e o comentário dela é explícito:
 * "a heurística pode ser generosa" porque "um falso POSITIVO só faz o loop aceitar a
 * resposta como final" — inofensivo LÁ. Aqui o mesmo falso positivo PARA UM SERVIÇO
 * 24/7 por tempo indeterminado; e, num serviço sem `channel:`, para em silêncio.
 *
 * Então o serviço ganha o SEU critério, mais estrito, sem tocar no do self-check:
 *
 *   • a pergunta tem que estar na ÚLTIMA linha — não "em algum lugar das últimas três".
 *     Um relatório longo quase sempre TERMINA em conclusão, não em pergunta;
 *   • e o texto todo precisa ter TAMANHO de pergunta. Um dossiê de 4 mil caracteres não
 *     é um pedido de decisão, por mais que a cauda diga "confirme".
 *
 * A direção do erro também inverte de propósito: aqui preferimos SEGUIR o workflow a
 * travá-lo. Se o modelo realmente precisa de decisão, ele tem a tool `perguntar` — que é
 * sinal EXPLÍCITO, não adivinhação sobre prosa.
 *
 * PURO/exportado p/ teste.
 */
export function servicoAguardaDono(resultText: string): boolean {
  const texto = (resultText ?? '').trim();
  if (texto === '') return false;
  // Teto de tamanho: uma pergunta ao dono cabe folgadamente aqui. O relatório que
  // travou o serviço tinha ~4000 caracteres.
  if (texto.length > MAX_PERGUNTA_CHARS) return false;
  const linhas = texto
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const ultima = linhas[linhas.length - 1];
  if (ultima === undefined) return false;
  // Reusa o heurístico de sempre (FONTE ÚNICA do "isto é uma pergunta"), mas aplicado
  // SÓ à última linha — é a estreiteza que falta no contexto do serviço.
  return awaitsUserDecision(ultima);
}

/**
 * Teto de caracteres p/ um texto ainda ser tratado como PERGUNTA ao dono. Acima disso é
 * relatório — ver `servicoAguardaDono`.
 */
const MAX_PERGUNTA_CHARS = 1500;

/**
 * LOG-MUDO — reduz a fala do agente a UMA linha de log. O `runner.log` é lido com
 * `tail`/`aluy service logs`: um turno inteiro despejado quebra a leitura de quem está
 * procurando o que aconteceu. Junta as quebras, colapsa espaço e corta com reticência.
 * PURO.
 */
export function clampLinhaDeLog(texto: string, max = 220): string {
  const uma = texto.replace(/\s+/g, ' ').trim();
  if (uma.length <= max) return uma;
  return `${uma.slice(0, max - 1)}…`;
}

export function buildActivityEnv(
  serviceDir: string,
  agent: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  autonomy?: 'ask' | typeof SERVICE_AUTONOMOUS_MODE,
  workspaceRoots?: readonly string[],
  credencialLocal?: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    // CHAVE-REVOGADA (dogfooding real) — a credencial que o RUNNER resolveu no boot,
    // repassada aos filhos. Sem isto, o serviço do dono morria assim:
    //
    //   atividade 1/6 "scan": ok.
    //   atividade 2/6 "traduzir": … o keychain do SO NÃO respondeu
    //     (Couldn't access platform storage: KeyRevoked)
    //
    // Um segundo entre as duas. Na máquina dele o backend do keychain é o keyring do
    // KERNEL — volátil e REVOGADO junto com a sessão que o criou. Cada atividade é um
    // processo NOVO que relê a chave do zero, então o serviço vivia à mercê de qual
    // sessão ainda estava viva: a atividade 1 lia, a 2 pegava `KeyRevoked`. Um cache
    // em memória não resolve (morre com o processo); o RUNNER é o único que dura o
    // expediente inteiro — ele lê UMA vez e sustenta os filhos.
    //
    // Só é usado como ÚLTIMO degrau: o filho tenta keychain e env próprias antes
    // (`ALUY_LOCAL_API_KEY` é o catch-all já existente do resolvedor). Se o dono
    // exportou a chave, a dele vence; se o keychain está sadio, ele vence.
    //
    // TRADE-OFF EXPLÍCITO: env de processo é legível por `/proc/<pid>/environ` — modo
    // 0400, MESMO usuário. O keychain protege contra OUTRO usuário e contra roubo em
    // repouso, e isso continua valendo: nada é escrito em disco nem em log. A chave já
    // precisa estar na memória do filho de qualquer forma (é ele quem chama o modelo).
    // Vazia NÃO é credencial: injetar `''` faria o resolvedor do filho ACHAR que tem
    // chave (o catch-all é consultado antes do erro) e falhar mais adiante, com uma
    // mensagem pior — a do provider recusando, em vez da que aponta o keychain.
    ...(credencialLocal !== undefined &&
    credencialLocal !== '' &&
    baseEnv.ALUY_LOCAL_API_KEY === undefined
      ? { ALUY_LOCAL_API_KEY: credencialLocal }
      : {}),
    ALUY_SERVICE_HOME: serviceDir,
    ...(agent !== undefined ? { ALUY_SERVICE_PERSONA: agent } : {}),
    ...(autonomy === SERVICE_AUTONOMOUS_MODE ? { ALUY_SERVICE_AUTONOMY: autonomy } : {}),
    ...(workspaceRoots !== undefined && workspaceRoots.length > 0
      ? { ALUY_SERVICE_WORKSPACE_ROOTS: JSON.stringify(workspaceRoots) }
      : {}),
  };
}

export type ActivityTimeDecision =
  | { readonly hasTime: false }
  | { readonly hasTime: true; readonly timeoutMs: number }
  | { readonly hasTime: true; readonly unlimited: true };

/**
 * ADR-0158 §5 pt.4 — decide se uma atividade AINDA tem tempo e, se sim, o TETO real
 * do turno-filho. `untilRemainingMs` é o restante até o `until:` do service.md
 * (`undefined` ⇒ sem `until` declarado, sem teto de expediente). `cap` é o teto
 * anti-runaway POR ATIVIDADE — `MAX_ACTIVITY_MS` por padrão, ou o valor declarado
 * em `activity-timeout:` no service.md, incluindo a opção explícita `'unlimited'`
 * (achado em dogfooding: o dono quer serviços 24/7 sem corte de 30min por
 * atividade). PURA — sem I/O, testável direto.
 *
 * `untilRemainingMs <= 0` ⇒ sem tempo (expediente já encerrado — nunca negativo
 * "sobra" pro `Math.min`, zero ou menos é "pulada", não "timeout de 0ms").
 * `cap === 'unlimited'` E sem `until` declarado ⇒ SEM TETO NENHUM (`unlimited:true`
 * — o caller NÃO cria `setTimeout` nenhum; um `setTimeout` com um número gigante
 * pra simular "infinito" reintroduziria o MESMO overflow de 32-bit já corrigido
 * pro sleep entre ciclos — `unlimited` é tratado como um caso PRÓPRIO, nunca como
 * um número grande). `cap === 'unlimited'` COM `until` declarado ainda respeita o
 * `until` — "sem teto por atividade" não é "sem fim de expediente", são regras
 * independentes.
 */
export function resolveActivityTimeout(
  untilRemainingMs: number | undefined,
  cap: number | 'unlimited' = MAX_ACTIVITY_MS,
): ActivityTimeDecision {
  if (untilRemainingMs !== undefined && untilRemainingMs <= 0) return { hasTime: false };
  if (cap === 'unlimited') {
    if (untilRemainingMs === undefined) return { hasTime: true, unlimited: true };
    return { hasTime: true, timeoutMs: untilRemainingMs };
  }
  if (untilRemainingMs === undefined) return { hasTime: true, timeoutMs: cap };
  return { hasTime: true, timeoutMs: Math.min(untilRemainingMs, cap) };
}

export type ActivityExitClassification = 'cancelled' | 'deadline' | 'continue';

/**
 * Classifica o desfecho do processo-filho de UMA atividade, DEPOIS que ele já
 * fechou — PURA (dado só o que já observamos: se o `stop` do runner disparou e o
 * `signal` com que o filho morreu). `stopAborted` tem PRIORIDADE (fomos NÓS que
 * pedimos pra parar — mesmo que o timer do deadline TAMBÉM tenha disparado numa
 * corrida); senão, qualquer SINAL (SIGTERM/SIGKILL) só pode ter vindo do
 * `killGracefully` do timer do deadline (`until:`/teto duro) — `stopAborted` já
 * foi descartado. `signal === null` ⇒ o filho terminou sozinho (saída normal) —
 * segue pra ler/validar o `stdout`.
 */
export function classifyActivityExit(args: {
  readonly stopAborted: boolean;
  readonly signal: NodeJS.Signals | null;
  /**
   * TETO-DISFARÇADO (dogfooding real) — o timer do teto DISPAROU (fomos nós que
   * derrubamos o filho). É FATO, não inferência.
   *
   * Sem isto, a detecção dependia de `signal !== null` — e o filho é um `aluy`, que
   * TRATA o SIGTERM e sai graciosamente com CÓDIGO 143 em vez de morrer pelo sinal.
   * Resultado no log do dono: uma atividade morta pelo teto de 30 min aparecia como
   * `saída ilegível (exit 143)`, acusando o filho de produzir lixo quando quem o matou
   * fomos nós, na hora marcada. Ele leria isso como bug do agente e procuraria no lugar
   * errado — quando a ação certa é declarar um `activity-timeout:` maior.
   */
  readonly deadlineFired?: boolean;
}): ActivityExitClassification {
  if (args.stopAborted) return 'cancelled';
  if (args.deadlineFired === true) return 'deadline';
  if (args.signal !== null) return 'deadline';
  return 'continue';
}

export interface ActivityTurnOutput {
  readonly result: string;
  readonly ok: boolean;
}

/**
 * Extrai e valida a ÚLTIMA linha de `stdout` do turno-filho como o JSON de saída
 * do `aluy -p --output-format json` — PURA. `undefined` ⇒ saída ILEGÍVEL (JSON
 * inválido na última linha, ou faltando/com tipo errado os campos `result`
 * string/`ok` boolean do formato esperado); o CALLER decide o log/outcome
 * (`stop:'error'`) — aqui só a extração+validação de forma, sem I/O.
 */
export function parseActivityTurnOutput(stdout: string): ActivityTurnOutput | undefined {
  const line = stdout.trim().split('\n').pop() ?? '';
  let parsed: { result?: unknown; ok?: unknown } | undefined;
  try {
    parsed = JSON.parse(line) as { result?: unknown; ok?: unknown };
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || typeof parsed.result !== 'string' || typeof parsed.ok !== 'boolean') {
    return undefined;
  }
  return { result: parsed.result, ok: parsed.ok };
}

export type SayRoutingDecision =
  | { readonly action: 'ignore' }
  | { readonly action: 'answer-local'; readonly text: string; readonly logLine: string }
  | { readonly action: 'queue'; readonly text: string; readonly logLine: string };

/**
 * ADR-0158 §11 (FASE 4) — decide o que fazer com UM evento `say` recebido pelo
 * socket de attach, dado o `currentPhase` do runner NO MOMENTO em que chegou —
 * PURA (nenhum I/O; o CALLER é quem de fato loga/empilha/submete). Extraída do
 * handler `onSay` de `runServiceRunner` (fechava sobre `currentPhase`/`pendingSay`/
 * `localAnswers` — nada disso testável sem subir o runner inteiro; a DECISÃO em
 * si não precisa de nenhum desses). Texto vazio (só whitespace) ⇒ ignorado (nunca
 * vira instrução vazia nem resposta vazia). ASK-ESPERA ⇒ é a resposta LOCAL do
 * dono à pergunta pendente. Qualquer OUTRA fase (dormindo/turno em andamento) ⇒
 * enfileirado p/ a PRÓXIMA atividade que abrir (degrade documentado — sem
 * plumbing de mid-turno de verdade no processo-filho).
 */
export function decideSayRouting(currentPhase: ServiceTurnState, rawText: string): SayRoutingDecision {
  const trimmed = rawText.trim();
  if (trimmed === '') return { action: 'ignore' };
  if (currentPhase === 'awaiting-owner') {
    return {
      action: 'answer-local',
      text: trimmed,
      logLine: '[attach] "say" recebido durante ASK-ESPERA — tratado como resposta LOCAL do dono.',
    };
  }
  return {
    action: 'queue',
    text: trimmed,
    logLine:
      currentPhase === 'sleeping'
        ? '[attach] "say" recebido com o serviço DORMINDO — vira instrução do PRÓXIMO despertar.'
        : '[attach] "say" recebido com turno EM ANDAMENTO — entregue à PRÓXIMA atividade do ' +
          'workflow (degrade documentado — sem plumbing de mid-turno de verdade ' +
          'no processo-filho).',
  };
}

/**
 * Roda UMA atividade como um turno headless `aluy -p` em processo FILHO, com wiring
 * ESCOPADO ao serviço (§2, via `ALUY_SERVICE_HOME`). Mata o filho se `stop` disparar
 * OU se o `deadlineMs` (restante até o `until:`, ou o teto duro) vencer PRIMEIRO.
 *
 * ADR-0158 §4.1 (FUNIL) — quando `activity.agent` está presente, o turno filho nasce
 * TRAVADO naquela persona (`ALUY_SERVICE_PERSONA`, consumida por `run.tsx`/
 * `controller.lockPersonaForTurn`: toolset ⊆ `tools:` da persona + corpo dela no
 * canal `system`, no lugar do preâmbulo do orquestrador). Fecha o DEGRADE #3 da
 * rc.113 (antes: só uma dica textual no `goal`, ignorável pelo modelo).
 */
async function runActivityTurn(args: {
  readonly serviceDir: string;
  readonly serviceName: string;
  readonly orchestratorPreamble: string;
  readonly activity: WorkflowActivity;
  readonly index: number;
  readonly total: number;
  readonly budgetTokens?: number;
  /**
   * Descoberta entre serviços (`group:`) — o `model:` do manifesto (SLUG cru, ex.:
   * `xiaomi/mimo-v2.5-pro`) fixa o modelo do TURNO deste serviço, para não depender
   * do default global de `~/.aluy/config.json` (que trocaria o modelo de TODOS os
   * serviços de uma mesa de uma vez). Ausente ⇒ SEM `--model` no argv do filho —
   * comportamento IDÊNTICO ao de hoje (default da config). PRECEDÊNCIA: um agente
   * invocado dentro do turno com seu PRÓPRIO `model:` (via `spawn_agent`) continua
   * vencendo este default — a resolução de tier (`resolveModelTier`, cli-core) só
   * herda o caller do pai quando o agente NÃO declara `model:` próprio; este campo
   * só troca QUAL É o caller do pai, nunca desliga essa herança.
   */
  readonly model?: string;
  /** Restante até o `until:` do service.md — `undefined` ⇒ sem `until` declarado. */
  readonly untilRemainingMs: number | undefined;
  /** ADR-0158 §5 pt.4 (emenda) — teto anti-runaway POR ATIVIDADE: `MAX_ACTIVITY_MS`
   * por padrão, ou o `activity-timeout:` declarado no service.md (incluindo
   * `'unlimited'`). Ver `resolveActivityTimeout`. */
  readonly activityTimeoutCap: number | 'unlimited';
  readonly stop: AbortSignal;
  readonly execPath: string;
  readonly aluyEntrypoint: string;
  readonly log: (line: string) => void;
  /** ADR-0158 — `service.manifest.autonomy` cru, propagado ao turno-filho via
   * `buildActivityEnv` (env interna `ALUY_SERVICE_AUTONOMY`). `undefined`/`'ask'`
   * ⇒ comportamento de hoje, byte a byte (nenhuma env nova). */
  readonly autonomy?: 'ask' | typeof SERVICE_AUTONOMOUS_MODE;
  /** ADR-0158 — `ServiceEntry.resolvedWorkspaceRoots` (JÁ resolvido/validado por
   * `resolveServiceWorkspaceRoots`), propagado ao turno-filho via `buildActivityEnv`
   * (env interna `ALUY_SERVICE_WORKSPACE_ROOTS`). Ausente/vazio ⇒ comportamento de
   * hoje (só a pasta do serviço é raiz). */
  readonly workspaceRoots?: readonly string[];
  /**
   * CHAVE-REVOGADA — credencial local que o RUNNER resolveu UMA vez no boot, repassada
   * aos filhos como último degrau (`ALUY_LOCAL_API_KEY`). Ausente ⇒ nada muda: o filho
   * resolve sozinho, como sempre.
   */
  readonly credencialLocal?: string;
  /** Preenchido com o texto da pergunta pendente quando o outcome é `awaiting-owner`. */
  readonly pendingQuestionRef: { current?: string };
  /** ADR-0158 §5 pt.4 (FASE 3) — RETOMADA: quando presente, é a atividade que HAVIA
   * perguntado, reexecutando com pergunta+resposta do dono anexadas ao `goal`
   * (`formatServiceResumeInstruction`, cli-core). `undefined` = turno normal. */
  readonly resumeContext?: string;
  /** ADR-0158 §11 (FASE 4) — fala(s) do dono via `aluy service attach` (`say`),
   * já formatadas (`formatOwnerSayInjection`, cli-core), a entregar NESTA atividade
   * (a PRÓXIMA a abrir desde que chegaram — degrade documentado, ver topo do
   * arquivo). `undefined` = nenhuma pendente. */
  readonly ownerSayContext?: string;
}): Promise<WorkflowActivityOutcome> {
  const { activity, index, total, untilRemainingMs, activityTimeoutCap, stop, log } = args;

  if (stop.aborted) return { ok: false, stop: 'cancelled' };
  const timeDecision = resolveActivityTimeout(untilRemainingMs, activityTimeoutCap);
  if (!timeDecision.hasTime) {
    log(`atividade ${index + 1}/${total} "${activity.id}": expediente já encerrado (until) — pulada.`);
    return { ok: false, stop: 'limit' };
  }

  if (args.ownerSayContext !== undefined) {
    log(`atividade ${index + 1}/${total} "${activity.id}": entregando fala(s) do dono via attach.`);
  }
  const goal = buildActivityGoal({
    orchestratorPreamble: args.orchestratorPreamble,
    activity,
    index,
    total,
    ...(args.resumeContext !== undefined ? { resumeContext: args.resumeContext } : {}),
    ...(args.ownerSayContext !== undefined ? { ownerSayContext: args.ownerSayContext } : {}),
  });

  const argv = [args.aluyEntrypoint, '-p', goal, '--output-format', 'json', '--quiet'];
  if (args.budgetTokens !== undefined) argv.push('--max-tokens', String(args.budgetTokens));
  if (args.model !== undefined) argv.push('--model', args.model);

  // `unlimited` (emenda: activity-timeout:sem-teto) ⇒ SEM setTimeout nenhum — ver
  // doc de `resolveActivityTimeout` (um número gigante pra simular "infinito"
  // reintroduziria o overflow de 32-bit já corrigido pro sleep entre ciclos).
  const timeoutMs = 'unlimited' in timeDecision ? undefined : timeDecision.timeoutMs;
  const tetoLabel = timeoutMs === undefined ? 'sem teto' : `teto ${Math.round(timeoutMs / 1000)}s`;
  log(
    activity.agent !== undefined
      ? `atividade ${index + 1}/${total} "${activity.id}": iniciando turno TRAVADO na persona ` +
          `"${activity.agent}" (${tetoLabel})…`
      : `atividade ${index + 1}/${total} "${activity.id}": iniciando turno (${tetoLabel})…`,
  );

  const child = spawn(args.execPath, argv, {
    cwd: args.serviceDir,
    env: buildActivityEnv(
      args.serviceDir,
      activity.agent,
      process.env,
      args.autonomy,
      args.workspaceRoots,
      args.credencialLocal,
    ),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => {
    stdout += c.toString('utf8');
  });
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });

  const onStopAbort = (): void => killGracefully(child);
  stop.addEventListener('abort', onStopAbort, { once: true });
  // `timeoutMs === undefined` (sem-teto) ⇒ sem deadlineTimer — só `stop` (SIGTERM
  // do runner) encerra a atividade. A atividade em si ainda respeita o `until:`
  // quando declarado (ver `resolveActivityTimeout`) — "sem teto por atividade" e
  // "sem fim de expediente" são regras independentes.
  // TETO-DISFARÇADO — registra o DISPARO do teto: é o único fato que distingue "nós o
  // matamos na hora marcada" de "o filho produziu lixo". O `aluy` filho trata SIGTERM e
  // sai com código 143, então `signal` chega `null` e a inferência antiga falhava.
  let deadlineFired = false;
  const deadlineTimer =
    timeoutMs !== undefined
      ? setTimeout(() => {
          deadlineFired = true;
          killGracefully(child);
        }, timeoutMs)
      : undefined;
  deadlineTimer?.unref();

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', () => resolve({ code: null, signal: null }));
  });
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  stop.removeEventListener('abort', onStopAbort);

  const exitClass = classifyActivityExit({ stopAborted: stop.aborted, signal: exit.signal, deadlineFired });
  if (exitClass === 'cancelled') {
    log(`atividade ${index + 1}/${total} "${activity.id}": interrompida (stop do runner).`);
    return { ok: false, stop: 'cancelled' };
  }
  // O filho morreu por SINAL (SIGTERM/SIGKILL) ⇒ fomos NÓS que o derrubamos — via
  // `killGracefully` no timer do deadline (`until:`/teto duro). `stop.aborted` já
  // foi descartado acima, então um sinal aqui só pode ser o deadline.
  if (exitClass === 'deadline') {
    log(
      `atividade ${index + 1}/${total} "${activity.id}": ATINGIU O TETO` +
        (timeoutMs !== undefined ? ` de ${Math.round(timeoutMs / 1000)}s` : ' (until/teto duro)') +
        ' — encerrada pelo runner. Declare `activity-timeout:` no service.md se esta' +
        ' atividade precisa de mais tempo.',
    );
    return { ok: false, stop: 'limit' };
  }

  const parsed = parseActivityTurnOutput(stdout);
  if (parsed === undefined) {
    log(
      `atividade ${index + 1}/${total} "${activity.id}": saída ilegível (exit ${exit.code}) — ` +
        `${stderr.trim().slice(0, 500) || '(sem stderr)'}`,
    );
    return { ok: false, stop: 'error' };
  }

  if (!parsed.ok) {
    // O turno-filho terminou com `ok:false` MAS ainda assim produziu JSON válido
    // (o caso ilegível, acima, já cobre o stderr NESSE ramo) — antes, o STDERR
    // capturado era descartado aqui, então um diagnóstico de BOOT do filho (ex.:
    // agente `.md` rejeitado, RES-MD-3 — ver `session/run.tsx`,
    // `agentBootWarningLines`) nunca chegava ao `runner.log`, deixando o `aluy
    // service attach` CEGO bem no momento em que o dono mais precisa (achado
    // reproduzido: serviço com agentes malformados travando "0 chars/err" sem
    // pista nenhuma). Mesmo padrão de corte da saída ilegível acima (500
    // caracteres) — omitido por completo quando vazio (zero ruído no caso comum
    // sem diagnóstico nenhum, ZERO regressão de texto de log).
    const stderrTail = stderr.trim().slice(0, 500);
    log(
      `atividade ${index + 1}/${total} "${activity.id}": turno terminou com erro.` +
        (stderrTail !== '' ? ` — ${stderrTail}` : ''),
    );
    return { ok: false, stop: 'error' };
  }

  const resultText = parsed.result;
  if (servicoAguardaDono(resultText)) {
    // ADR-0158 §5 pt.4/§3 — regra dura: NUNCA prossegue com suposição. O CALLER
    // (`runServiceRunner`) é quem envia a pergunta ao canal e entra em ASK-ESPERA
    // (`channel.ts`, FASE 3) — aqui só sinalizamos "parou aqui, com esta pergunta".
    const tail = resultText.trim().split('\n').slice(-3).join(' ');
    args.pendingQuestionRef.current = tail;
    log(`atividade ${index + 1}/${total} "${activity.id}": AGUARDANDO DONO — "${tail}"`);
    return { ok: false, stop: 'awaiting-owner' };
  }

  log(`atividade ${index + 1}/${total} "${activity.id}": ok.`);
  return { ok: true };
}

/**
 * Roda o processo do serviço (o corpo de `aluy service run <nome> --runner`). NUNCA
 * lança — devolve o exit code. `deps.externalStop` permite teste determinístico sem
 * depender de sinal real de SO.
 */
export async function runServiceRunner(name: string, deps: RunServiceRunnerDeps = {}): Promise<number> {
  const store = new UserServicesStore(deps.aluyBaseDir !== undefined ? { baseDir: deps.aluyBaseDir } : {});
  const entry = store.get(name);
  if (entry === undefined || isServiceEntryError(entry)) {
    process.stderr.write(
      `aluy: serviço "${name}" inválido/não encontrado — não é possível iniciar o runner.\n`,
    );
    return 1;
  }
  const service: ServiceEntry = entry;
  const serviceDir = service.dir;
  const logPath = deps.log ? undefined : runnerLogPath(serviceDir);
  const baseLog = deps.log ?? ((line: string) => appendLog(logPath!, line));
  // ADR-0158 §11 (FASE 4) — `attachServerRef.current` nasce `undefined` e é
  // atribuído logo abaixo; `log` fecha sobre o HOLDER (`const`, nunca reatribuído —
  // só a propriedade `.current` muda), então já pode ser definido AQUI e usado por
  // tudo (inclusive `startAttachServer`, que recebe este MESMO `log` — nesse
  // instante `attachServerRef.current` ainda é `undefined`, então essas linhas só
  // vão pro arquivo, não pro socket; nenhum cliente estaria conectado àquela altura
  // mesmo). Publica no socket TODA linha que já ia pro `runner.log`.
  const attachServerRef: { current?: AttachServer } = {};
  const log = (line: string): void => {
    baseLog(line);
    attachServerRef.current?.broadcastLog(line);
  };

  // ADR-0158 §5 pt.4/§8.1/§8.2 (FASE 3) — o CANAL: UMA base de deps por PROCESSO
  // (o `egressLimiter`/TC-6 tem que persistir por todo o runner — nunca recriado por
  // chamada, ou o teto anti-spam perde o efeito). Overrides SÓ de teste (`channelDeps`).
  const channelBaseDeps: ServiceChannelDeps = {
    egressLimiter: deps.channelDeps?.egressLimiter ?? newServiceEgressLimiter(),
    log,
    ...(deps.channelDeps?.secretStore !== undefined ? { secretStore: deps.channelDeps.secretStore } : {}),
    ...(deps.channelDeps?.clientFactory !== undefined ? { clientFactory: deps.channelDeps.clientFactory } : {}),
    ...(deps.channelDeps?.now !== undefined ? { now: deps.channelDeps.now } : {}),
    ...(deps.channelDeps?.askTimeoutMs !== undefined ? { askTimeoutMs: deps.channelDeps.askTimeoutMs } : {}),
  };

  if (service.manifest.schedule === undefined) {
    const reason = 'serviço sem "schedule:" declarado — o runner não sabe quando acordar.';
    log(`FATAL: ${reason} Abortando.`);
    // §8.1 — turno que NUNCA abre (nem vai abrir) ⇒ alerta no canal, nunca silêncio.
    await sendServiceAlert(service.manifest, reason, channelBaseDeps);
    return 1;
  }

  const pidPath = runnerPidPath(serviceDir);
  writePidFile(pidPath, process.pid);
  log(`runner iniciado (pid ${process.pid}) — serviço "${service.manifest.name}".`);

  // CHAVE-REVOGADA — a credencial local que o runner segura pelo expediente inteiro.
  // Ver o racional longo em `buildActivityEnv`: cada atividade é um processo NOVO, e o
  // keyring do KERNEL (backend do keychain quando não há Secret Service) é revogado
  // junto com a sessão que o criou — o serviço do dono fazia "atividade 1 ok / atividade
  // 2 KeyRevoked" com DOIS segundos entre elas. O runner é o único processo que dura o
  // suficiente p/ atravessar isso.
  //
  // PREGUIÇOSA e memoizada, resolvida no PRIMEIRO turno — NÃO aqui. Um `await` entre o
  // "runner iniciado" e o registro do `onSignal` abre uma janela real em que um SIGTERM
  // chega e NÃO tem handler; foi um teste de sinal que me mostrou isso. Como bônus, um
  // runner que nunca abre turno nunca toca o keychain.
  //
  // BEST-EFFORT e SILENCIOSA no sucesso: nunca loga a chave (nem o tamanho dela). Se
  // falhar, NÃO aborta — os filhos seguem resolvendo sozinhos exatamente como antes, e
  // o erro deles já vem com o motivo certo.
  let credencialDoRunner: string | undefined;
  let credencialResolvida = false;
  const garantirCredencial = async (): Promise<void> => {
    if (credencialResolvida) return;
    credencialResolvida = true;
    credencialDoRunner = await resolverCredencialDoRunner(deps.resolverCredencial, log);
  };

  // ADR-0158 §11 (FASE 4) — estado do ATTACH, vivo pelo processo INTEIRO (não por
  // turno): `currentPhase` espelha o `turnState` corrente (o `setStatus` abaixo é o
  // ÚNICO escritor); `pendingSay`/`localAnswers` são as DUAS metades do "dono pode
  // DIGITAR" — ver o comentário do topo do arquivo p/ o racional completo.
  let currentPhase: ServiceTurnState = 'sleeping';
  const pendingSay: string[] = [];
  const localAnswers = new LocalAnswerChannel();
  attachServerRef.current = startAttachServer(
    serviceDir,
    {
      onSay: (text) => {
        const decision = decideSayRouting(currentPhase, text);
        if (decision.action === 'ignore') return;
        if (decision.action === 'answer-local') {
          log(decision.logLine);
          localAnswers.submit(decision.text);
          return;
        }
        pendingSay.push(decision.text);
        log(decision.logLine);
      },
    },
    log,
  );
  // §11, item 2 (melhor esforço) — tail periódico dos blocos NOVOS da sessão ativa
  // do serviço (`attach-blocks.ts`). Frequência modesta (1.5s): não é streaming
  // token-a-token, é "o attach que acabou de conectar vê o que mudou desde a
  // última rodada" — suficiente p/ observar sem virar um segundo hot-path de I/O.
  const blockTailState = newAttachBlockTailState();
  const blockTailTimer = setInterval(() => {
    for (const b of pollNewServiceBlocks(serviceDir, blockTailState)) {
      attachServerRef.current?.broadcastBlock(b.role, b.text);
      // ATTACH-CEGO — o attach é EFÊMERO: quem não estava conectado no instante do
      // erro nunca o vê, e a transcrição da sessão morre com o turno. Por isso o que
      // acontece no turno também vai para o `runner.log`, que PERSISTE e é o que
      // `aluy service logs` mostra.
      //
      // LOG-MUDO — antes daqui só ERRO era registrado, "para não afogar o diagnóstico
      // no ruído". Errei o alvo: otimizei para DIAGNOSTICAR FALHA quando o que um
      // serviço autônomo precisa é AUDITORIA. O dono olhou o log de um pregão inteiro
      // e viu 83 linhas — só fronteiras de atividade e daemon. As 17 tools POR
      // ATIVIDADE que de fato fizeram o trabalho estavam na transcrição
      // (`.state/sessions/*.json`) e em lugar nenhum legível. Palavras dele: "não
      // consigo ver efetivamente o que aconteceu em cada atividade".
      //
      // Agora TODA tool entra, e a fala final do turno também — é ela que diz o que o
      // agente concluiu. O volume é modesto de propósito: ~17 tools × 10 atividades
      // dá algumas centenas de linhas por pregão, que é um REGISTRO, não ruído. Quem
      // quiser só o essencial tem `aluy service logs -n`.
      if (b.role === 'tool') log(`[tool] ${b.text}`);
      else if (b.role === 'aluy') log(`[aluy] ${clampLinhaDeLog(b.text)}`);
    }
  }, 1500);
  blockTailTimer.unref();

  const stopController = new AbortController();
  const onSignal = (sig: NodeJS.Signals): void => {
    log(`sinal ${sig} recebido — encerrando graciosamente…`);
    stopController.abort();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  deps.externalStop?.addEventListener('abort', () => stopController.abort(), { once: true });

  // ADR-0158 §11 — TODA transição de `turnState` passa por aqui (nunca mais
  // `writeServiceStatus` direto): grava o `status.json` (como antes) E publica o
  // evento `state` pro attach, E mantém `currentPhase` em dia p/ o `onSay` acima
  // decidir o que fazer com uma fala recebida.
  const setStatus = (snapshot: Omit<ServiceStatusSnapshot, 'updatedAtIso'>): void => {
    writeServiceStatus(serviceDir, snapshot);
    currentPhase = snapshot.turnState;
    attachServerRef.current?.broadcastState(
      snapshot.turnState,
      snapshot.pendingQuestion ?? snapshot.lastReportSummary,
    );
  };

  const shutdown = (): void => {
    stopDaemons(serviceDir, log);
    setStatus({ turnState: 'sleeping' });
    clearInterval(blockTailTimer);
    attachServerRef.current?.close();
    removePidFile(pidPath);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    log('runner encerrado.');
  };

  const execPath = deps.execPath ?? process.execPath;
  const aluyEntrypoint = deps.aluyEntrypoint ?? process.argv[1] ?? '';

  // `immediate: true` — só pode furar a soneca de cron na PRIMEIRA volta deste
  // laço. Consumida (`= false`) logo na primeira checagem, sucesso ou não (`until:`
  // vencido também consome — não fica "tentando de novo" na volta seguinte). Cada
  // REINÍCIO do PROCESSO do runner (crash-loop, `stop`/`start` manual, máquina
  // reiniciando) recria este `let` do zero — o laço recomeça, `isFirstIteration`
  // volta a `true`, e o turno imediato dispara DE NOVO. Risco ACEITO e
  // DOCUMENTADO (crash-loop com `immediate: true` vira turno repetido a cada
  // relançamento) — sem proteção adicional aqui; ver o comentário no topo do
  // arquivo e o `⚠` correspondente no manifesto visível (`service-manifest-
  // visible.ts`), que existe exatamente para o dono ver este risco ANTES de
  // instalar.
  let isFirstIteration = true;

  try {
    while (!stopController.signal.aborted) {
      const now = new Date();
      const next = nextCronFire(service.manifest.schedule, now);
      if (next === undefined) {
        const reason = `"schedule: ${service.manifest.schedule}" nunca dispara (ou é inválido).`;
        log(`FATAL: ${reason} Abortando.`);
        // §8.1 — idem: o serviço NUNCA mais vai abrir turno sozinho ⇒ alerta.
        await sendServiceAlert(service.manifest, reason, channelBaseDeps);
        // FATAL fora do `stopController.abort()` — o `finally` abaixo só limpa em
        // shutdown GRACIOSO (sinal); aqui precisamos limpar manualmente p/ nunca
        // deixar um pidfile órfão apontando pra um processo que já morreu.
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        clearInterval(blockTailTimer);
        attachServerRef.current?.close();
        removePidFile(pidPath);
        return 1;
      }

      // `immediate: true` — decide ANTES de dormir, só nesta volta (consumida
      // logo abaixo). `until:` continua valendo (decisão de projeto): se o
      // expediente já encerrou hoje, o imediato é PULADO — a regra de expediente
      // vence a conveniência de rodar já — e o runner cai no ciclo normal de cron,
      // exatamente como se `immediate:` não estivesse declarado.
      const wantsImmediate = isFirstIteration && service.manifest.immediate === true;
      const runImmediateNow = wantsImmediate && canRunImmediateNow(now, service.manifest.until);
      if (wantsImmediate && !runImmediateNow) {
        log(
          `"immediate: true" declarado, mas o expediente ("until: ${service.manifest.until}") já ` +
            `encerrou — turno imediato pulado; segue para o ciclo normal de cron.`,
        );
      }
      isFirstIteration = false;

      if (runImmediateNow) {
        log('"immediate: true" declarado — turno IMEDIATO antes do primeiro ciclo de cron…');
      } else {
        setStatus({ turnState: 'sleeping', nextFireIso: next.toISOString() });
        log(`dormindo até ${next.toISOString()} (próximo turno).`);

        // MESA-MORRE-COM-O-SUPERVISOR (a outra metade) — agora que os daemons
        // SOBREVIVEM ao fim de um turno enquanto o expediente está aberto, alguém
        // precisa derrubá-los quando ele FECHA. Sem isto, um turno que termina cedo
        // (todas as atividades concluídas às 18h, `until: 20:40`) deixaria a mesa de
        // pé a noite inteira, até o cron do dia seguinte.
        //
        // Então a soneca acorda no que vier PRIMEIRO: o próximo turno, ou o fim do
        // expediente. Acordando no fim do expediente, derruba e volta a dormir.
        const fimExpediente = msUntilDeadline(new Date(), service.manifest.until);
        const acordaNoFimDoExpediente =
          fimExpediente !== undefined &&
          fimExpediente > 0 &&
          Date.now() + fimExpediente < next.getTime();
        const alvoSoneca = acordaNoFimDoExpediente
          ? new Date(Date.now() + fimExpediente)
          : next;

        const wake = await sleepUntil(alvoSoneca, stopController.signal);
        if (wake === 'stopped') break;

        if (acordaNoFimDoExpediente) {
          log(`fim do expediente ("until: ${service.manifest.until}") — derrubando daemons próprios…`);
          stopDaemons(serviceDir, log);
          continue; // volta ao topo: recalcula o próximo cron e dorme de verdade.
        }
      }

      // ADR-0158 §8.1 (FASE 3) — "manifesto inválido pós-edição" é um dos motivos
      // explícitos de ALERTA: o dono pode ter editado `service.md` DEPOIS do
      // `start` (o processo só releu uma vez, no boot). Reler+revalidar A CADA
      // despertar detecta isso ANTES de abrir o turno — em vez de travar o runner
      // inteiro, PULA este turno (alerta pelo ÚLTIMO canal válido conhecido,
      // `service.manifest`) e volta a dormir até o próximo `schedule` (calculado
      // com o schedule ANTIGO — é a melhor aproximação sem um manifesto novo válido).
      const revalidated = store.get(name);
      if (revalidated === undefined || isServiceEntryError(revalidated)) {
        const reason =
          revalidated === undefined
            ? 'o diretório do serviço sumiu do disco entre um despertar e outro — turno pulado.'
            : `manifesto inválido pós-edição — ${revalidated.reason} — turno pulado.`;
        log(`FALHA ao abrir o turno: ${reason}`);
        await sendServiceAlert(service.manifest, reason, channelBaseDeps);
        continue; // volta ao topo do while — dorme até o PRÓXIMO schedule (o antigo).
      }

      // ── início do expediente (§5 pt.3/§6) ──────────────────────────────────
      log('acordou — início do expediente: subindo daemons próprios (se houver)…');
      startDaemons(serviceDir, log);
      setStatus({ turnState: 'running-turn' });

      // CHAVE-REVOGADA — resolve a credencial no PRIMEIRO turno e a segura daí em diante
      // (memoizada). Aqui já não há janela de sinal: o `onSignal` está registrado desde
      // o boot.
      await garantirCredencial();

      const baseWorkflowArgs = {
        serviceDir,
        serviceName: service.manifest.name,
        workflowName: service.manifest.workflow,
        orchestratorBody: service.manifest.orchestrator,
        budgetRaw: service.manifest.budget,
        modelRaw: service.manifest.model,
        untilRaw: service.manifest.until,
        activityTimeoutRaw: service.manifest.activityTimeout,
        stop: stopController.signal,
        execPath,
        aluyEntrypoint,
        log,
        // ADR-0158 §11 (FASE 4) — a MESMA fila `pendingSay` do processo inteiro,
        // passada por referência: `runOneWorkflow` a drena na PRÓXIMA atividade que
        // abrir, mesmo através de uma retomada pós-ask-espera (`{...baseWorkflowArgs,
        // resume: ...}` abaixo reusa este MESMO array).
        ownerSay: pendingSay,
        // ADR-0158 — o modo declarado no manifesto vira o modo do turno-filho
        // (propagado até `buildActivityEnv` → env `ALUY_SERVICE_AUTONOMY`). Ausente/
        // `ask` ⇒ comportamento de hoje, byte a byte.
        ...(service.manifest.autonomy !== undefined
          ? { autonomy: service.manifest.autonomy }
          : {}),
        // ADR-0158 — raízes `workspace:` JÁ resolvidas/validadas (`resolvedWorkspaceRoots`,
        // `io/services-store.ts` — o piso "~/.aluy/ nunca vira raiz" já foi aplicado
        // ali). Propagado até `buildActivityEnv` → env `ALUY_SERVICE_WORKSPACE_ROOTS`.
        // Vazio (sem `workspace:` declarado) ⇒ comportamento de hoje, byte a byte.
        ...(service.resolvedWorkspaceRoots.length > 0
          ? { workspaceRoots: service.resolvedWorkspaceRoots }
          : {}),
        // CHAVE-REVOGADA — a credencial que o RUNNER segura pelo expediente (resolvida
        // no 1º turno, logo acima). Só entra se ele conseguiu lê-la UMA vez.
        ...(credencialDoRunner !== undefined ? { credencialLocal: credencialDoRunner } : {}),
      };

      let outcome = await runOneWorkflow(baseWorkflowArgs);

      // ADR-0158 §5 pt.4 (FASE 3 — O CORAÇÃO DESTA FASE) — ASK-ESPERA: turno fechou
      // "aguardando dono" ⇒ envia a pergunta ao CANAL do manifesto e ESPERA a
      // resposta (nunca prossegue com suposição). Resposta chegou ⇒ RETOMA a MESMA
      // atividade com pergunta+resposta anexadas, e o workflow CONTINUA de onde
      // parou. A nova execução pode, ela mesma, terminar "aguardando dono" de novo
      // (outra pergunta) — o `while` cobre isso naturalmente.
      while (outcome.kind === 'awaiting-owner') {
        setStatus({
          turnState: 'awaiting-owner',
          pendingQuestion: outcome.question,
          lastReportSummary: `aguardando dono: ${outcome.question}`,
        });
        log('turno pausado — AGUARDANDO DONO — enviando a pergunta ao canal e entrando em modo espera…');

        const ask = await waitForOwnerReply({
          manifest: service.manifest,
          question: outcome.question,
          stop: stopController.signal,
          deps: channelBaseDeps,
          // ADR-0158 §11 (FASE 4) — corre a resposta REMOTA (Telegram) contra uma
          // resposta LOCAL via `aluy service attach` — quem chegar primeiro decide
          // (mesma autoridade dos dois canais, §11).
          localAnswer: localAnswers,
        });

        if (ask.kind === 'stopped') {
          log('ask-espera interrompida (stop do runner).');
          break; // `outcome` continua "awaiting-owner" — o guard abaixo pula report/alert.
        }

        if (ask.kind === 'no-channel') {
          // Só chega aqui quando NEM canal remoto NEM attach existem — o que em
          // produção não acontece (o `attachServerRef`/`localAnswers` é sempre fiado
          // logo acima). Sem canal mas COM attach, `waitForOwnerReply` já espera em
          // silêncio pelo `aluy service attach` e nunca devolve `no-channel`.
          // Restando este caso, mantém o fail-open antigo: encerra o runner e o dono
          // religa quando resolver (nunca finge que perguntou, nunca prossegue só).
          log(
            `ask-espera não pôde ser feita (${ask.reason}) — encerrando o runner ` +
              `(religue com "aluy service start" quando resolver o canal/decisão).`,
          );
          stopDaemons(serviceDir, log);
          clearInterval(blockTailTimer);
          attachServerRef.current?.close();
          removePidFile(pidPath);
          process.off('SIGTERM', onSignal);
          process.off('SIGINT', onSignal);
          log('runner encerrado (aguardando dono, sem canal disponível).');
          return 0;
        }

        if (ask.kind === 'timeout') {
          outcome = {
            kind: 'stopped',
            critical: false,
            summary:
              'aguardando dono — SEM RESPOSTA a tempo (ask-espera expirou); turno encerrado sem ação.',
          };
          break;
        }

        // ask.kind === 'answered' — retoma a atividade que perguntou.
        log(`dono respondeu pelo canal — retomando a atividade ${outcome.activityIndex + 1} do workflow.`);
        outcome = await runOneWorkflow({
          ...baseWorkflowArgs,
          resume: { activityIndex: outcome.activityIndex, question: outcome.question, answer: ask.text },
        });
      }

      // `outcome.kind === 'awaiting-owner'` só sobra aqui quando o `break` acima foi
      // por `ask.kind === 'stopped'` (SIGTERM durante a ask-espera) — nesse caso
      // NÃO reportamos/alertamos (o `finally` do shutdown gracioso já cobre; o
      // `while` externo termina, `stopController.signal.aborted` já é `true`) e
      // TAMBÉM não derrubamos os daemons aqui (o `shutdown()` já o faz).
      if (outcome.kind !== 'awaiting-owner') {
        // §8.2 (turno concluiu/parou por motivo neutro) × §8.1 (falha que MERECE
        // alerta) — a mesma disciplina "nunca silêncio" do resto do runner.
        log(`turno encerrado — ${outcome.summary}`);
        if (outcome.kind === 'ok') {
          await sendServiceReport(
            service.manifest,
            { serviceName: service.manifest.name, ok: true, critical: false, summary: outcome.summary },
            channelBaseDeps,
          );
        } else if (outcome.critical) {
          await sendServiceAlert(service.manifest, outcome.summary, channelBaseDeps);
        } else {
          await sendServiceReport(
            service.manifest,
            { serviceName: service.manifest.name, ok: false, critical: false, summary: outcome.summary },
            channelBaseDeps,
          );
        }

        // MESA-MORRE-COM-O-SUPERVISOR (dogfooding real, custou meio pregão) — esta
        // derrubada acontecia no fim de TODO turno, embora a linha dissesse "fim do
        // expediente". Não era só texto errado: era o comportamento.
        //
        // O que aconteceu: uma vigília do serviço de execução estourou o teto de
        // atividade, o turno encerrou em `limit`, e o runner matou os 7 daemons que
        // sustentavam a mesa — bridge MT5, 5 estratégias e o guarda de posição, todos
        // saudáveis. A mesa fechou às 14:21 num pregão que ia até 17:40, e ninguém
        // percebeu por 25 minutos. O MOTOR morreu porque o ACESSÓRIO adoeceu, que é a
        // inversão exata de prioridade para um serviço que opera dinheiro.
        //
        // `until:` é o que define EXPEDIENTE. Enquanto a janela está aberta, o próximo
        // turno vai acontecer e os daemons têm que estar de pé para ele — `startDaemons`
        // é idempotente (pula o que já vive pelo pidfile), então manter é seguro.
        //
        // Sem `until:` declarado, nada muda: cada turno É o expediente inteiro e a
        // derrubada segue no fim dele, byte a byte como antes.
        const restanteExpediente = msUntilDeadline(new Date(), service.manifest.until);
        if (restanteExpediente !== undefined && restanteExpediente > 0) {
          log(
            `turno encerrado — daemons MANTIDOS: o expediente segue aberto até ` +
              `"${service.manifest.until}" (${Math.round(restanteExpediente / 60_000)}min). ` +
              `Falha de turno não derruba a mesa.`,
          );
        } else {
          log('fim do expediente — derrubando daemons próprios…');
          stopDaemons(serviceDir, log);
        }
      }
    }
  } finally {
    if (stopController.signal.aborted) shutdown();
  }
  return 0;
}

type WorkflowOutcome =
  | { readonly kind: 'ok'; readonly summary: string }
  /**
   * `critical` distingue, p/ o CALLER decidir reporte (§8.2) × alerta (§8.1): `true`
   * p/ o que impediu o turno de sequer completar de um jeito normal (workflow
   * ausente/inválido, atividade que terminou em `stop:'error'` — erro de
   * spawn/crash); `false` p/ parada NEUTRA (`until:`/teto atingido, `stop` do
   * runner, conclusão antecipada do agente) — essas viram reporte, não alerta.
   */
  | { readonly kind: 'stopped'; readonly summary: string; readonly critical: boolean }
  | { readonly kind: 'awaiting-owner'; readonly question: string; readonly activityIndex: number };

export type ResumeSliceDecision =
  | { readonly ok: true; readonly startOffset: number }
  | { readonly ok: false; readonly startOffset: number };

/**
 * ADR-0158 §5 pt.4 — decide o `startOffset` de uma RETOMADA pós-ask-espera: a
 * atividade em `resumeActivityIndex` ainda precisa EXISTIR no workflow (o dono
 * pode ter editado `service.md`/o workflow ENTRE a pergunta e a resposta) — PURA.
 * `resumeActivityIndex === undefined` (turno normal, não é retomada) ⇒ sempre
 * `startOffset: 0` e `ok:true` (nada a validar — a fatia é o workflow inteiro).
 */
export function resolveResumeSlice(
  totalActivities: number,
  resumeActivityIndex: number | undefined,
): ResumeSliceDecision {
  const startOffset = resumeActivityIndex ?? 0;
  return startOffset >= totalActivities ? { ok: false, startOffset } : { ok: true, startOffset };
}

/**
 * ADR-0158 §5 pt.4/§8.1/§8.2 — monta o `WorkflowOutcome` FINAL de um turno, a
 * partir do `WorkflowRunResult` puro do `runWorkflow` (cli-core) + o que só o
 * CALLER sabe (o `startOffset` da fatia rodada, o total REAL de atividades do
 * workflow inteiro, e — só no caso "aguardando dono" — a pergunta pendente e o
 * índice da atividade que perguntou). PURA — nenhum I/O, testável direto sem
 * rodar um workflow de verdade. `res.lastStop === 'awaiting-owner'` tem
 * PRIORIDADE sobre `res.stopped` (o mesmo motivo também deixa `stopped:true`,
 * mas "aguardando dono" NÃO é reporte/alerta — é o CALLER que entra em ask-espera).
 */
export function buildWorkflowOutcome(args: {
  readonly res: WorkflowRunResult;
  readonly startOffset: number;
  readonly totalActivities: number;
  readonly pendingQuestionText: string | undefined;
  readonly pendingActivityIndex: number | undefined;
}): WorkflowOutcome {
  const { res, startOffset, totalActivities, pendingQuestionText, pendingActivityIndex } = args;
  if (res.lastStop === 'awaiting-owner') {
    return {
      kind: 'awaiting-owner',
      question: pendingQuestionText ?? '(ver runner.log)',
      activityIndex: pendingActivityIndex ?? startOffset,
    };
  }
  if (res.stopped) {
    return {
      kind: 'stopped',
      critical: res.lastStop === 'error',
      summary: `parou em ${startOffset + res.activitiesRun}/${totalActivities} atividades (${res.lastStop ?? 'motivo desconhecido'}).`,
    };
  }
  return {
    kind: 'ok',
    summary: `${startOffset + res.activitiesRun}/${totalActivities} atividades concluídas.`,
  };
}

async function runOneWorkflow(args: {
  readonly serviceDir: string;
  readonly serviceName: string;
  readonly workflowName: string | undefined;
  readonly orchestratorBody: string;
  readonly budgetRaw: string | undefined;
  /** `model:` cru do manifesto — repassado a CADA `runActivityTurn` desta fatia
   * (ver o campo homônimo lá; ausente ⇒ sem mudança no argv do filho). */
  readonly modelRaw: string | undefined;
  readonly untilRaw: string | undefined;
  /** ADR-0158 §5 pt.4 (emenda) — `activity-timeout:` cru do manifesto (`45m`/`2h`/
   * `sem-teto`). Ausente/malformado ⇒ `MAX_ACTIVITY_MS` (default, ver `resolveActivityTimeout`). */
  readonly activityTimeoutRaw: string | undefined;
  readonly stop: AbortSignal;
  readonly execPath: string;
  readonly aluyEntrypoint: string;
  readonly log: (line: string) => void;
  /** ADR-0158 §5 pt.4 (FASE 3) — RETOMADA pós ASK-ESPERA: a atividade em
   * `activityIndex` reexecuta com pergunta+resposta anexadas ao `goal` (as
   * atividades ANTERIORES já concluíram no turno original — não rodam de novo). */
  readonly resume?: { readonly activityIndex: number; readonly question: string; readonly answer: string };
  /** ADR-0158 §11 (FASE 4) — fila MUTÁVEL (array compartilhado, o mesmo em todo o
   * processo do runner) de falas do dono via `aluy service attach` ainda não
   * entregues. DRENADA (splice) na PRÓXIMA atividade que abrir — ver `runner.
   * runActivity` abaixo. `undefined` ⇒ attach não fiado (nunca acontece em produção;
   * só testes que chamem `runOneWorkflow` isoladamente sem essa peça). */
  readonly ownerSay?: string[];
  /** ADR-0158 — `service.manifest.autonomy` cru, repassado a CADA `runActivityTurn`
   * desta fatia (ver o campo homônimo lá). `undefined`/`'ask'` ⇒ sem mudança. */
  readonly autonomy?: 'ask' | typeof SERVICE_AUTONOMOUS_MODE;
  /** ADR-0158 — `ServiceEntry.resolvedWorkspaceRoots`, repassado a CADA
   * `runActivityTurn` desta fatia (ver o campo homônimo lá). Ausente/vazio ⇒
   * comportamento de hoje (só a pasta do serviço é raiz). */
  readonly workspaceRoots?: readonly string[];
  /**
   * CHAVE-REVOGADA — credencial local que o RUNNER resolveu UMA vez no boot, repassada
   * aos filhos como último degrau (`ALUY_LOCAL_API_KEY`). Ausente ⇒ nada muda: o filho
   * resolve sozinho, como sempre.
   */
  readonly credencialLocal?: string;
}): Promise<WorkflowOutcome> {
  const { serviceDir, workflowName, log } = args;
  if (workflowName === undefined) {
    log('sem "workflow:" declarado — nada a executar neste turno.');
    return { kind: 'ok', summary: 'sem workflow declarado (no-op).' };
  }
  // Confinamento do `workflow:` — 3ª camada (parser recusa a FORMA; o registry recusa
  // o caminho resolvido; aqui o RUNNER reconfere antes de LER). Redundante de
  // propósito: o runner é o único que de fato executa o conteúdo, e um manifesto pode
  // ter sido editado no disco DEPOIS de validado (o runner relê a cada despertar).
  const wfRoot = resolve(serviceDir, 'workflows');
  const wfPath = resolve(wfRoot, `${workflowName}.md`);
  if (wfPath !== wfRoot && !wfPath.startsWith(wfRoot + sep)) {
    log(`FATAL do turno: "workflow: ${workflowName}" aponta para fora de workflows/ — recusado.`);
    return { kind: 'stopped', critical: true, summary: 'workflow fora do diretório do serviço.' };
  }
  if (!existsSync(wfPath)) {
    log(`FATAL do turno: workflows/${workflowName}.md não encontrado.`);
    return { kind: 'stopped', critical: true, summary: `workflow "${workflowName}" não encontrado.` };
  }
  const raw = readFileSync(wfPath, 'utf8');
  const parsed = parseWorkflow(`${workflowName}.md`, raw, 'project');
  if (isWorkflowError(parsed)) {
    log(`FATAL do turno: workflow "${workflowName}" inválido — ${parsed.reason}`);
    return { kind: 'stopped', critical: true, summary: `workflow inválido — ${parsed.reason}` };
  }

  const resumeSlice = resolveResumeSlice(parsed.activities.length, args.resume?.activityIndex);
  if (!resumeSlice.ok) {
    log('retomada: a atividade pendente não existe mais no workflow (editado entre a pergunta e a resposta) — turno encerrado.');
    return {
      kind: 'stopped',
      critical: true,
      summary: 'a atividade da retomada não existe mais no workflow (editado entre a pergunta e a resposta).',
    };
  }
  const startOffset = resumeSlice.startOffset;
  const activitiesToRun = parsed.activities.slice(startOffset);

  const budgetTokens = parseServiceBudget(args.budgetRaw);
  // SEM-TETO-EM-INGLÊS — valor não entendido cai no default de 30min; sem este aviso o
  // dono só descobre quando o teto MATA uma atividade e o turno leva os daemons junto.
  const avisoTeto = avisoActivityTimeout(args.activityTimeoutRaw);
  if (avisoTeto !== undefined) args.log(`[manifesto] ${avisoTeto}`);
  const activityTimeoutCap = parseServiceActivityTimeout(args.activityTimeoutRaw) ?? MAX_ACTIVITY_MS;
  const orchestratorPreamble =
    `Você coordena o serviço "${args.serviceName}" — rege, não opera:\n${args.orchestratorBody}`;

  const pendingQuestionRef: { current?: string } = {};
  let pendingActivityIndex: number | undefined;
  const runner: WorkflowActivityRunner = {
    async runActivity({ index, id, goal, signal: _rootSignal }) {
      void _rootSignal; // o `runWorkflow` já checa entre atividades; usamos `args.stop`.
      // `index`/`total` que `runWorkflow` passa são relativos a `activitiesToRun`
      // (o array FATIADO a partir de `startOffset`) — convertidos aqui pro índice/
      // total REAIS do workflow inteiro, p/ o log e o `goal` ("Atividade X/Y")
      // continuarem corretos mesmo numa retomada parcial.
      const realIndex = index + startOffset;
      const now = new Date();
      const remaining = msUntilDeadline(now, args.untilRaw);
      // A primeira atividade da FATIA (`index === 0`) é a que estava pendente —
      // só ELA leva o contexto de retomada (as seguintes são turno normal).
      const resumeContext =
        args.resume !== undefined && index === 0
          ? formatServiceResumeInstruction(args.resume.question, args.resume.answer)
          : undefined;
      // ADR-0158 §11 (FASE 4) — DRENA a fila de "say" pendentes AGORA (esta é a
      // PRÓXIMA atividade a abrir desde que chegaram, seja o serviço estivesse
      // dormindo ou outra atividade estivesse em voo — degrade documentado, ver
      // `formatOwnerSayInjection`). Drenar aqui (não antes) evita duplicar a
      // entrega numa retomada pós-ask-espera (`runOneWorkflow` chamado de novo com
      // `resume` — a fila só é preenchida por `onSay`, nunca por este loop).
      const drainedSay = args.ownerSay?.splice(0, args.ownerSay.length) ?? [];
      const ownerSayContext = drainedSay.length > 0 ? formatOwnerSayInjection(drainedSay) : undefined;
      const outcome = await runActivityTurn({
        serviceDir,
        serviceName: args.serviceName,
        orchestratorPreamble,
        activity: { id, goal, agent: parsed.activities[realIndex]?.agent } as WorkflowActivity,
        index: realIndex,
        total: parsed.activities.length,
        ...(budgetTokens !== undefined ? { budgetTokens } : {}),
        ...(args.modelRaw !== undefined ? { model: args.modelRaw } : {}),
        untilRemainingMs: remaining,
        activityTimeoutCap,
        stop: args.stop,
        execPath: args.execPath,
        aluyEntrypoint: args.aluyEntrypoint,
        log: args.log,
        ...(ownerSayContext !== undefined ? { ownerSayContext } : {}),
        pendingQuestionRef,
        ...(resumeContext !== undefined ? { resumeContext } : {}),
        ...(args.autonomy !== undefined ? { autonomy: args.autonomy } : {}),
        ...(args.workspaceRoots !== undefined ? { workspaceRoots: args.workspaceRoots } : {}),
        ...(args.credencialLocal !== undefined ? { credencialLocal: args.credencialLocal } : {}),
      });
      if (!outcome.ok && outcome.stop === 'awaiting-owner') pendingActivityIndex = realIndex;
      return outcome;
    },
  };

  const res = await runWorkflow(activitiesToRun, runner, args.stop);
  return buildWorkflowOutcome({
    res,
    startOffset,
    totalActivities: parsed.activities.length,
    pendingQuestionText: pendingQuestionRef.current,
    pendingActivityIndex,
  });
}
