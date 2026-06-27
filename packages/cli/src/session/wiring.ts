// EST-0948 — WIRING da sessão: liga login + broker + loop + catraca + I/O concreto.
//
// É o ponto onde TUDO se conecta no binário `aluy` (ADR-0053 §8: entrega
// monolítica, `@hiperplano/aluy-cli` consome `@hiperplano/aluy-cli-core`):
//   LoginService (0942) ─┐
//                        ├→ createBrokerModelClient (0943) → StreamingModelCaller
//   ALUY_BROKER_URL ─────┘
//   PolicyPermissionEngine (0945) ── catraca (allow/ask/deny + sempre-ask)
//   NodeWorkspace/FS/Shell/Search (0948) ── I/O concreto confinado + timeout
//   EgressAllowlist (0948) ── CLI-SEC-5 default-deny
//   TuiAskResolver (0948) ── renderiza o ask, fail-safe deny
//
// Tudo injetável (testes). NÃO toca Ink aqui — o render é em run.tsx.

import {
  AgentMemory,
  BrokerModelCaller,
  NativeToolsCapability,
  DEFAULT_LIMITS,
  DEFAULT_SUMMARY_MAX_TOKENS,
  MAX_ITERATIONS_CEILING,
  resolveMaxTokens,
  resolveMaxIterations,
  resolveMaxOutputTokens,
  resolveMaxObservationChars,
  resolveSelfCheck,
  LoginService,
  PolicyPermissionEngine,
  SnapshotJournal,
  CheckpointRegistry,
  createBrokerModelClient,
  createTierCatalogClient,
  createCustomModelClient,
  createProvidersClient,
  createQuotaClient,
  newSessionId,
  unifiedDiff,
  MemoryRoomStore,
  resolveRoomBackend,
  ContextGraph,
  type ModelClient,
  type TierCatalogClient,
  type CustomModelClient,
  type ProvidersClient,
  type QuotaClient,
  type CredentialStore,
  type FetchLike,
  type StreamFetch,
  type SessionMode,
  type SessionLimits,
  type ToolPorts,
  type NativeTool,
  type AgentRegistry,
  type RoomStore,
} from '@hiperplano/aluy-cli-core';
import { loadAuthConfig, CLI_CLIENT_ID } from '../auth/config.js';
import { loadBrokerConfig } from '../model/config.js';
import { headroomUrlFromEnv } from '../model/headroom.js';
import { makeHeadroomRetrieveTool } from '../model/headroom-retrieve.js';
import { KeychainCredentialStore } from '../auth/keychain-store.js';
import { createSandbox } from '../sandbox/index.js';
import {
  NodeWorkspace,
  NodeFileSystemPort,
  NodeShellPort,
  NodeSearchPort,
  NodeFileIndexPort,
  EgressAllowlist,
  NodeJournalStore,
  NodeMemoryStore,
  NodeTodoStore,
  NodeRestoreWriter,
  NodeCurrentReader,
  createWebPort,
  type FileIndexPort,
  type WorkspacePort,
} from '../io/index.js';
import { AttachReader } from '../attach/index.js';
import { TuiAskResolver } from '../ask/ask-resolver.js';
import { TuiQuestionResolver } from '../ask/question-resolver.js';
import { StreamingModelCaller } from './streaming-caller.js';
import { SessionController } from './controller.js';
import { HooksConfigStore } from '../io/index.js';
import { FileRoomStore } from './rooms/file-room-store.js';
import { makePreToolGate } from './pre-tool-gate.js';
import { HookRunner, selectHooks, type HooksConfig } from '@hiperplano/aluy-cli-core';
import { resolveContextWindow } from '../model/catalog.js';
import { resolveMaestro, resolveContinuationCfg, resolveMemory } from '../maestro/wiring.js';
import type { SessionMeta } from './model.js';

/** Tier default da sessão (HG-2: só o tier sai do cliente; o broker resolve). */
export const DEFAULT_TIER = 'aluy-flux';

/** Timeout default do exec (ms) — anti-hang (CLI-SEC). */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

export interface BuildSessionOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Raiz do workspace (cwd preso). Default: process.cwd(). */
  readonly workspaceRoot?: string;
  /**
   * EST-0959 · ADR-0055 — MODO de sessão inicial (`plan | normal | unsafe`).
   * Default `normal`. `plan` = teto read-only; `unsafe` = BYPASS TOTAL. `mode`
   * VENCE o legado `unsafe` se ambos vierem (Plan/normal zeram o unsafe).
   */
  readonly mode?: SessionMode;
  /**
   * LEGADO — `--unsafe` como booleano. Equivale a `mode='unsafe'` se `mode`
   * ausente. ⚠ desliga CLI-SEC-3 — revisar com `seguranca`. Default false.
   */
  readonly unsafe?: boolean;
  /** Timeout do diálogo de ask (ms) ⇒ deny. Default: sem timeout por tempo. */
  readonly askTimeoutMs?: number;
  /** Hosts extra liberados no egress (DADO de config). */
  readonly egressAllow?: readonly string[];
  /**
   * EST-0974/0980 — store da config de hooks (`~/.aluy/hooks.json` + settings do
   * Claude). Injetável p/ teste. Default: o real. A partir desta config, o wiring
   * monta o `HookRunner` (atrás da catraca) e o GATE de pre-tool (EST-0980).
   */
  readonly hooksConfigStore?: HooksConfigStore;
  /** Stores/fetch injetáveis (testes). */
  readonly store?: CredentialStore;
  readonly identityFetch?: FetchLike;
  readonly brokerFetch?: StreamFetch;
  /**
   * Override do cliente de modelo (testes — broker/local mockado). ADR-0120: aceita
   * QUALQUER `ModelClient` (broker OU local). Quando presente, VENCE a seleção de
   * backend (`opts.backend`/env/config) — o teste injeta o que quiser.
   */
  readonly brokerClient?: ModelClient;
  /** EST-0962 — override do cliente de catálogo de tiers (testes — broker mockado). */
  readonly catalogClient?: TierCatalogClient;
  /** EST-0962 — override do cliente de modelos custom (testes — broker mockado). */
  readonly customModelClient?: CustomModelClient;
  /** EST-0962 · ADR-0076 — override do cliente de providers (testes — broker mockado). */
  readonly providersClient?: ProvidersClient;
  /** EST-0948 · ADR-0069 — override do cliente de quota (testes — broker mockado). */
  readonly quotaClient?: QuotaClient;
  /** Override do tier. */
  readonly tier?: string;
  /** ADR-0120 — backend EFETIVO já RESOLVIDO (broker|local) p/ espelhar no `meta` (display do modo). */
  readonly effectiveBackend?: 'broker' | 'local';

  /**
   * EST-1112 · ADR-0119 — orçamento local da sessão. `true` = budget ON (gate de
   * maxTokens + anti-runaway), `false` = budget OFF (ilimitado no local). No broker
   * é SEMPRE ON. Resolvido em run.tsx: flag `--budget`/`--no-budget` > env `ALUY_BUDGET`
   * > config `localBudget` > default (OFF local, ON broker).
   */
  readonly localBudget?: boolean;
  /**
   * EST-0972 (BUG Custom) — slug do modelo da via Custom no BOOT (só sob `tier:'custom'`).
   * Vem de uma sessão RETOMADA cujo tier era `custom` (run.tsx). O caller de stream o
   * envia junto do tier; o `buildChatBody` re-trava em `tier === 'custom'`. Sem isto,
   * retomar uma sessão Custom perdia o slug ⇒ `tier:custom` SEM model ⇒ 422. É a chave
   * de catálogo (HG-2), NÃO credencial. Ausente/fora de Custom ⇒ sem slug.
   */
  readonly model?: string;
  /**
   * EST-0962 (`--provider`) — NOME do provider em par com o `model` da via Custom
   * (`--provider deepseek --model <slug>`). Só sob `tier:'custom'` e com `model`; o
   * caller de stream o envia junto, e o `buildChatBody` re-trava em `tier === 'custom'`.
   * É só o NOME (DADO, não credencial — HG-2/CLI-SEC-7); o broker resolve
   * `(provider, model)` → credencial server-side. Ausente/fora de Custom ⇒ não sai.
   */
  readonly provider?: string;
  /**
   * EST-0962 (--effort) — `reasoning_effort` PASSTHROUGH (qualquer string não-vazia
   * ≤32 chars; low/medium/high são comuns mas CUSTOM é aceito). SEM tier-gate: vale em
   * qualquer tier. Vai no corpo do request. `undefined` ⇒ NÃO é enviado (o provider
   * usa o default).
   */
  readonly effort?: string;
  /**
   * EST-0948 — TETO de tokens da sessão (CLI-SEC-8) vindo de `--max-tokens N` (cru,
   * string). Precedência: esta flag > env `ALUY_MAX_TOKENS` > default (1M). Validado e
   * CLAMPADO num teto-teto (anti-runaway) por `resolveMaxTokens` do core. Ausente em
   * ambos ⇒ o default. Injetável p/ teste.
   */
  readonly maxTokens?: string;
  /**
   * EST-0948 — TETO de ITERAÇÕES do loop (CLI-SEC-8) vindo de `--max-iterations N`
   * (cru, string). Precedência: esta flag > env `ALUY_MAX_ITERATIONS` > default (300).
   * Validado e CLAMPADO num teto-teto (anti-runaway) por `resolveMaxIterations` do
   * core. Ausente em ambos ⇒ o default. Injetável p/ teste.
   */
  readonly maxIterations?: string;
  /**
   * EST-0948 — `max_tokens` de OUTPUT POR CHAMADA ao modelo (anti-TRUNCAMENTO) vindo
   * de `--max-output-tokens N` (cru, string). ⚠ CONCEITO DISTINTO de `maxTokens`
   * acima: aquele é o BUDGET LOCAL ACUMULADO da sessão (anti-runaway, default 1M);
   * ESTE é o teto de OUTPUT de UMA chamada ao modelo (vai no corpo do request → broker
   * → provider). Precedência: esta flag > env `ALUY_MAX_OUTPUT_TOKENS` > UNSET. DEFAULT
   * UNSET (`undefined`): por padrão o CLI NÃO manda `max_tokens` ⇒ o BROKER decide o
   * teto de output (HG-2/CLI-SEC-7). Só manda quando o usuário configura. Validado e
   * CLAMPADO (`resolveMaxOutputTokens` do core); inválido ⇒ UNSET + aviso. Injetável p/ teste.
   */
  readonly maxOutputTokens?: string;
  /**
   * EST-0944 — SELF-CHECK de atenção vindo de `--self-check`/`--no-self-check` (cru:
   * `'1'`/`'true'` liga, `'0'`/`'false'` desliga). Precedência: esta flag >
   * env `ALUY_SELF_CHECK` > AUTO por tier fraco (`custom` liga sozinho; o default flux NÃO). A
   * flag SEMPRE vence o tier (o usuário pode forçar ON/OFF). Ausente em todos ⇒ OFF
   * em tier forte, ON em tier fraco. Validado em `resolveSelfCheck` do core. Injetável p/ teste.
   */
  readonly selfCheck?: string;
  /**
   * EST-0973 — AUTO-COMPACTAÇÃO da janela vinda de `--autocompact-at` (cru: razão
   * `0..1`, % `>1`, ou `off`/`0`). Precedência: esta flag > env `ALUY_AUTOCOMPACT_AT` >
   * default 0.85. Repassada ao controller, que resolve com a `contextWindow` + anti-loop
   * (`resolveAutoCompact` do core). Ausente ⇒ default (ligada a 85%). Injetável p/ teste.
   */
  readonly autoCompactAt?: string;
  /**
   * EST-0948 — sink de AVISOS de config (stderr no binário; capturado nos testes). O
   * `resolveMaxOutputTokens` o usa p/ avisar de valor inválido/clampado sem quebrar.
   * Ausente ⇒ sem aviso (silencioso). Injetável p/ teste.
   */
  readonly onConfigWarn?: (msg: string) => void;
  /**
   * EST-0960a — id da sessão (subdir do journal `~/.aluy/undo/<session>/`).
   * Default: um novo id. Injetável p/ teste determinístico.
   */
  readonly sessionId?: string;
  /**
   * EST-0960a — raiz do `~/.aluy/` (default `<home>/.aluy`). Injetável p/ teste
   * (tmpdir), p/ a suíte nunca tocar o journal real do dev.
   */
  readonly journalBaseDir?: string;
  /**
   * EST-0983 · ADR-0064 · CLI-SEC-15 — raiz do `~/.aluy/` p/ a MEMÓRIA global
   * (default `<home>/.aluy`). Injetável p/ teste (tmpdir), p/ a suíte nunca tocar a
   * memória real do dev. A memória de PROJETO vai em `<workspace>/.aluy/memory/`.
   */
  readonly memoryBaseDir?: string;
  /**
   * EST-1108 — raiz do `~/.aluy/` p/ o BACKLOG/TODO (default `<home>/.aluy`).
   * Injetável p/ teste (tmpdir), p/ a suíte nunca tocar o backlog real do dev.
   */
  readonly todoBaseDir?: string;
  /**
   * EST-0983 — teto de gravações de memória (`remember`) por sessão (GS-M2/RES-M-2).
   * Default `DEFAULT_MAX_MEMORY_WRITES_PER_SESSION` (na engine). Injetável p/ teste.
   */
  readonly maxMemoryWritesPerSession?: number;
  /**
   * EST-0964 — INSTRUÇÕES DE PROJETO (AGENT.md) JÁ LIDAS/CLAMPADAS pelo startup
   * (run.tsx → loadAgentMd, confinado ao workspace). `buildSession` é síncrono e
   * NÃO faz I/O de arquivo aqui — só recebe a string confiável e a fia no
   * controller/loop (canal `system`). Ausente ⇒ prompt baseline (sem regressão).
   * O confinamento/path-deny/teto já foram aplicados no leitor — esta string é a
   * config confiável do dono do repo, não um `@arquivo` (dado).
   */
  readonly projectInstructions?: string;
  /**
   * EST-1109 — AGENTES DISPONÍVEIS: nota COMPACTA (já formatada por
   * `buildAvailableAgentsNote` no core) que lista os sub-agentes nomeados p/ o
   * modelo delegar via `spawn_agent` (campo `agent: <nome>`). CONFIG CONFIÁVEL
   * do dono (como o AGENT.md). Entra SÓ no canal `system`. Montada em run.tsx com
   * `agentRegistry.list()`. Ausente ⇒ prompt baseline (não-regressão).
   */
  readonly availableAgents?: string;
  /**
   * EST-1149 · ADR-0127 — COMANDOS DA SESSÃO: nota (camada cli, do registro `commands.ts`)
   * com os `/comandos` que o HUMANO digita. Entra SÓ no canal `system` (auto-conhecimento).
   * Montada em run.tsx. Ausente ⇒ baseline.
   */
  readonly sessionCommands?: string;
  /**
   * EST-0970 · ADR-0058 · CLI-SEC-12 — tools de SERVERS MCP locais JÁ DESCOBERTAS
   * pelo startup (run.tsx → setupMcp: lê `~/.aluy/mcp.json` confinado, lança os
   * servers, handshake, lista). Como `buildSession` é síncrono (sem I/O de processo
   * aqui — espelha o AGENT.md), o handshake roda ANTES e o resultado entra como
   * estas tools já adaptadas (efeito por padrão). Ausente ⇒ sem MCP. O `mcpClose`
   * (fechar os transports no fim da sessão) é responsabilidade do caller.
   */
  readonly mcpTools?: readonly NativeTool<ToolPorts>[];
  /**
   * EST-0969 · ADR-0057 — habilita SUB-AGENTES locais PARALELOS (tool `spawn_agent`).
   * Default: DESLIGADO (mono-agente, não-regressão). Quando `enabled`, o controller
   * monta o spawner com a MESMA engine/ports/budget/ask do pai (não-bypass, escopo
   * ⊆ pai, E-A1/E-A2/E-A3). `maxConcurrency` é teto anti-runaway; `timeoutMs` é o
   * timeout de INATIVIDADE/heartbeat (EST-0969): mata só o filho TRAVADO (sem
   * progresso por N), nunca quem trabalha. O TOTAL é cercado por budget+iterações.
   */
  readonly subAgents?: {
    readonly enabled: boolean;
    readonly maxConcurrency?: number;
    /** EST-0969 — timeout de INATIVIDADE por filho (ms), não de relógio total. */
    readonly timeoutMs?: number;
  };
  /**
   * EST-0977/0978 · ADR-0061 — REGISTRO de agentes-`.md` nomeados (globais + projeto,
   * já carregados/confinados no startup pelo caller). Só tem efeito com sub-agentes
   * habilitados: `spawn_agent({ agent: "<nome>" })` resolve o perfil nomeado pelo
   * registro (persona/toolset⊆pai/tier). Ausente ⇒ só sub-agentes genéricos (EST-0969).
   */
  readonly agentRegistry?: AgentRegistry;
  /**
   * EST-1012 — ROBUSTEZ DE MEMÓRIA · MONITOR DE PRESSÃO de heap (backstop de OOM).
   * Quando presente, o controller liga um monitor LEVE que DEGRADA com graça antes do
   * "Killed" cego do kernel (compactar → avisar → encerrar-limpo salvando a sessão). O
   * `heapLimitMb` é o MESMO `--max-old-space-size` que o launcher aplicou; o
   * `sampleHeapUsed` lê o heap (`process.memoryUsage().heapUsed`). A PORTA de
   * encerramento (`shutdown`, com `saveNow`+unmount) é injetada DEPOIS pelo run.tsx
   * (`setMemoryShutdown` + `startMemoryMonitor`). Ausente ⇒ monitor DESLIGADO.
   */
  readonly memoryMonitor?: {
    readonly heapLimitMb: number;
    readonly sampleHeapUsed: () => number;
    readonly sampleIntervalMs?: number;
  };
  /**
   * EST-1119 · ADR-0121 §5 — backend de salas (rooms). Valor CRU (string)
   * lido do campo `rooms.backend` em `~/.aluy/config.json`. Passado ao
   * `resolveRoomBackend` (core) junto com `ALUY_ROOM_BACKEND` (env).
   * `undefined` ⇒ cai em env > default `memory`.
   */
  readonly roomsBackend?: string;
}

/** Tudo que a sessão precisa, já fiado. */
export interface BuiltSession {
  readonly controller: SessionController;
  readonly login: LoginService;
  readonly engine: PolicyPermissionEngine;
  readonly egress: EgressAllowlist;
  readonly workspace: WorkspacePort;
  readonly askResolver: TuiAskResolver;
  /** EST-1110 · ADR-0114 — resolver de PERGUNTA (`perguntar`) da TUI (controlador). */
  readonly questionResolver: TuiQuestionResolver;
  /**
   * EST-0960a — journal de snapshot-do-antes da sessão. A captura roda por baixo
   * da `edit_file`; a EST-0960b (`/undo`/`/redo`) consome a pilha/restauração.
   */
  readonly journal: SnapshotJournal;
  /** O store concreto (`~/.aluy/undo/<session>/`) — p/ cleanup no fim da sessão. */
  readonly journalStore: NodeJournalStore;
  /**
   * EST-XXXX — registro de CHECKPOINTS (1 por prompt). Orquestra o journal p/ o
   * `/rewind`/Esc-Esc: restaura código (reverte edições pós-ponto) e expõe a
   * fronteira da conversa (blockCount) que o run.tsx usa p/ truncar a transcrição.
   */
  readonly checkpoints: CheckpointRegistry;
  /** EST-0957 — índice de arquivos do workspace p/ o picker `@`. */
  readonly fileIndex: FileIndexPort;
  /** EST-0957 — leitor confinado/path-deny dos anexos `@arquivo`. */
  readonly attachReader: AttachReader;
  /** EST-0962 — cliente do catálogo de tiers p/ o seletor `/model` (mesma credencial). */
  readonly catalogClient: TierCatalogClient;
  /**
   * EST-0962 — cliente da lista de modelos CUSTOM (`GET /v1/models/custom`, mesma
   * credencial do chat). A fonte DEDICADA do autocomplete do modo Custom do `/model`,
   * SEPARADA do `catalogClient` (tiers).
   */
  readonly customModelClient: CustomModelClient;
  /**
   * EST-0962 · ADR-0076 — cliente da lista de providers CADASTRADOS (`GET /v1/providers`,
   * mesma credencial do chat). A fonte VIVA do seletor `/provider` (NOMES dos providers,
   * par da via Custom), SEPARADA do catálogo de tiers/modelos.
   */
  readonly providersClient: ProvidersClient;
  /** EST-0948 · ADR-0069 — cliente da quota da PRÓPRIA conta (`GET /v1/quota`). */
  readonly quotaClient: QuotaClient;
  /**
   * EST-0964 — as portas de I/O confinadas (fs/shell/search/journal). Expostas p/
   * o `/init` analisar o repo e escrever o AGENT.md PELA CATRACA (mesma engine).
   * São as MESMAS portas que o loop usa — `/init` não tem um caminho privilegiado.
   */
  readonly ports: ToolPorts;
  /**
   * EST-0983 · ADR-0064 · CLI-SEC-15 — a memória de agente da sessão (mecânica
   * interna). O `/memory` (ver/editar/esquecer/fixar) a consome pela engine, NUNCA
   * por `cat` (read-deny mantido). O RECALL inicial (fatos como DADO envelopado) é
   * semeado no controller no boot via `memory.recall()`.
   */
  readonly memory: AgentMemory;
  /**
   * EST-1108 — o store do backlog/TODO da sessão (NodeTodoStore concreto).
   * O `/todo` (ver/adicionar/concluir/limpar) o consome pela engine, NUNCA
   * por `cat` (read-deny mantido). As tools add_todo/list_todos/done_todo
   * alcançam o store via `ports.todo`.
   */
  readonly todoStore: NodeTodoStore;
  /**
   * EST-0974/0980 — o `HookRunner` da sessão (executa hooks ATRÁS da catraca) e a
   * config de hooks lida. Expostos p/ o locus concreto (run.tsx) disparar os hooks
   * OBSERVE-ONLY (session-start/turn-end/pre-tool/post-tool/...) pelos observadores —
   * o GATE de pre-tool (EST-0980) já está plugado no loop via `preToolGate`. Reusar o
   * MESMO runner/config evita um segundo motor de hooks.
   */
  readonly hookRunner: HookRunner;
  readonly hooksConfig: HooksConfig;
}

/**
 * Monta a sessão completa. Não faz I/O de rede ainda — só fia os objetos. A 1ª
 * chamada de modelo (no submit) é que aciona o broker (e o login, se preciso).
 */
export function buildSession(opts: BuildSessionOptions = {}): BuiltSession {
  const env = opts.env ?? process.env;

  // ── auth (0942) ────────────────────────────────────────────────────────────
  const authConfig = loadAuthConfig(env);
  const store = opts.store ?? new KeychainCredentialStore();
  const login = new LoginService(
    {
      baseUrl: authConfig.identityBaseUrl,
      clientId: CLI_CLIENT_ID,
      store,
      ...(opts.identityFetch ? { fetch: opts.identityFetch } : {}),
    },
    // FALLBACK do `ALUY_TOKEN` do ambiente p/ as chamadas ao broker quando o
    // keychain está vazio (headless/CI sem `aluy login`). Espelha o `isLoggedOut`
    // do boot, que já trata `ALUY_TOKEN` presente como "logado". Sem isto, esse
    // usuário passava o check mas a 1ª chamada estourava `SessionExpiredError`.
    { envToken: () => env.ALUY_TOKEN },
  );

  // ── broker model client (0943) ─────────────────────────────────────────────
  const brokerConfig = loadBrokerConfig(env);
  const brokerClient =
    opts.brokerClient ??
    createBrokerModelClient({
      brokerBaseUrl: brokerConfig.brokerBaseUrl,
      login,
      ...(opts.brokerFetch ? { fetch: opts.brokerFetch } : {}),
    });

  // ── catálogo de tiers p/ o seletor `/model` (0962 — MESMA credencial do chat) ─
  const catalogClient =
    opts.catalogClient ??
    createTierCatalogClient({
      brokerBaseUrl: brokerConfig.brokerBaseUrl,
      login,
      ...(opts.brokerFetch ? { fetch: opts.brokerFetch } : {}),
    });

  // ── lista de modelos CUSTOM p/ o autocomplete do modo Custom (0962 — DEDICADA,
  //    `GET /v1/models/custom`, MESMA credencial do chat) ───────────────────────
  const customModelClient =
    opts.customModelClient ??
    createCustomModelClient({
      brokerBaseUrl: brokerConfig.brokerBaseUrl,
      login,
      ...(opts.brokerFetch ? { fetch: opts.brokerFetch } : {}),
    });

  // ── lista de PROVIDERS cadastrados p/ o seletor `/provider` (0962 · ADR-0076 —
  //    `GET /v1/providers`, MESMA credencial do chat) ────────────────────────────
  const providersClient =
    opts.providersClient ??
    createProvidersClient({
      brokerBaseUrl: brokerConfig.brokerBaseUrl,
      login,
      ...(opts.brokerFetch ? { fetch: opts.brokerFetch } : {}),
    });

  // ── quota da PRÓPRIA conta p/ o footer (0948 · ADR-0069 — `GET /v1/quota`, MESMA
  //    credencial do chat) — saldo de CRÉDITO (dimensão primária) + janelas ──────────
  const quotaClient =
    opts.quotaClient ??
    createQuotaClient({
      brokerBaseUrl: brokerConfig.brokerBaseUrl,
      login,
      ...(opts.brokerFetch ? { fetch: opts.brokerFetch } : {}),
    });

  // ── EIXO DE MODO (0959 · ADR-0055) — resolvido CEDO: o YOLO derruba a cerca de FS
  //    (workspace) e o anti-SSRF (web), além da catraca. `mode` VENCE o legado
  //    `unsafe`. Sem nenhum ⇒ `normal` (default seguro). EST-0991 · ADR-0072.
  const initialMode: SessionMode = opts.mode ?? (opts.unsafe ? 'unsafe' : 'normal');
  const yolo = initialMode === 'unsafe';

  // ── I/O concreto confinado (0948 — cravas do seguranca) ─────────────────────
  // EST-0991 · ADR-0072 — sob YOLO a cerca é DERRUBADA (root-set `{ '/' }`, disco
  // inteiro); a canonicalização do `resolveInside` PERMANECE. Em normal/plan a cerca
  // de 1 raiz (EST-0948) fica intacta. `unconfined` deriva SÓ do modo da sessão.
  const workspace = new NodeWorkspace({
    ...(opts.workspaceRoot !== undefined ? { root: opts.workspaceRoot } : {}),
    ...(yolo ? { unconfined: true } : {}),
  });

  // ── journal de snapshot-do-antes (0960a · ADR-0056) ─────────────────────────
  // A captura roda por baixo da `edit_file` (reusa o `before` do diff). O store
  // vive em `~/.aluy/undo/<session>/` (FORA do workspace), blobs 0600 / dirs 0700
  // atômicos. GC de sessões órfãs no start (R6, pós-crash). A restauração que a
  // 0960b consome é confinada ao workspace no momento da escrita (R8).
  const sessionId = opts.sessionId ?? newSessionId();
  const journalStore = new NodeJournalStore({
    sessionId,
    ...(opts.journalBaseDir !== undefined ? { baseDir: opts.journalBaseDir } : {}),
  });
  // GC pós-crash de sessões órfãs no start (R6) — best-effort, não bloqueia.
  void journalStore.gcOrphans();
  const journal = new SnapshotJournal({
    store: journalStore,
    workspace,
    restoreWriter: new NodeRestoreWriter({ workspace }),
    currentReader: new NodeCurrentReader({ workspace }),
  });

  // ── checkpoints / rewind (EST-XXXX) ─────────────────────────────────────────
  // Registro de 1 ponto por PROMPT. ORQUESTRA o journal (acima): grava a fronteira
  // de seq (código) + a contagem de blocos (conversa) no início de cada turno e
  // restaura o código revertendo as edições posteriores ao ponto. Mecânica PORTÁVEL
  // (core); a UI do `/rewind` e a rebobinada de conversa moram no @hiperplano/aluy-cli.
  const checkpoints = new CheckpointRegistry({ journal });

  const fs = new NodeFileSystemPort({ workspace });

  // ── egress allowlist default-deny (0948 · CLI-SEC-5) ────────────────────────
  // Construída ANTES das `ports`: a WebPort (EST-0971) precisa dela p/ a guarda de
  // egress das tools web_fetch/web_search.
  const egress = new EgressAllowlist(
    opts.egressAllow !== undefined ? { allow: opts.egressAllow } : {},
  );

  // ── WebPort (EST-0971 · CLI-SEC-13) — resolver DNS + fetcher PINADO anti-SSRF +
  // guarda de egress. As tools web_fetch/web_search só funcionam com isto injetado.
  // EST-0991 · ADR-0072 — sob YOLO a denylist anti-SSRF de faixa interna é SUSPENSA
  // (`allowInternalHosts`): o agente alcança localhost/metadata/serviços internos. O
  // PIN/anti-rebind PERMANECE. Em normal/plan o anti-SSRF DURO de CLI-SEC-13 fica
  // intacto. Deriva SÓ do modo da sessão (opt-in `--yolo`).
  // EST-0970 (fix OOM) — teto de CARACTERES da observação do web_fetch (o blob que
  // entra no contexto). flag/env (`ALUY_WEB_FETCH_MAX_CHARS`) > default, clampado em
  // [MIN, CEILING] (anti-OOM duro: config errada NÃO desliga o teto). SEMPRE na policy.
  const maxObservationChars = resolveMaxObservationChars(env.ALUY_WEB_FETCH_MAX_CHARS);
  const web = createWebPort({
    egress,
    policy: { maxObservationChars, ...(yolo ? { allowInternalHosts: true } : {}) },
  });

  // ── memória de agente (EST-0983 · ADR-0064 · CLI-SEC-15) ────────────────────
  // Store concreto: GLOBAL em `~/.aluy/memory/` (0600/0700 atômico, FORA do
  // workspace — read/write-deny do agente, só esta mecânica interna alcança) +
  // PROJETO em `<workspace>/.aluy/memory/` (confinado pelo WorkspacePort). A
  // `AgentMemory` é a mecânica PORTÁVEL (recall-como-dado/proveniência/pin); a porta
  // de ESCRITA injetada na tool `remember` é ESTREITA (append por escopo, sem path).
  const memoryStore = new NodeMemoryStore({
    workspace,
    ...(opts.memoryBaseDir !== undefined ? { baseDir: opts.memoryBaseDir } : {}),
  });
  const memory = new AgentMemory({ store: memoryStore });

  // EST-1108 — store concreto do backlog/TODO: `~/.aluy/todos.json` (0600 atômico,
  // fail-safe). A mecânica PORTÁVEL (contract.ts) é do core; este é o I/O real.
  const todoStore = new NodeTodoStore({
    ...(opts.todoBaseDir !== undefined ? { baseDir: opts.todoBaseDir } : {}),
    sessionId, // BUG-0029 — backlog ESCOPADO por conversa (não vaza entre sessões)
  });

  // EST-1010 · ADR-0065 — sandbox de SO do bash. OPT-IN nesta fase (`ALUY_SANDBOX_BASH`):
  // o MECANISMO (confinar via bwrap) está pronto e provado, mas confinar por default
  // exige a integração da abertura de rede sob `ask` da catraca (senão `network:false`
  // quebraria npm/git/curl) — isso + o flip default-on são decisão de design do gate
  // de segurança. Ligado ⇒ todo `run_command` roda confinado (degrade-com-aviso onde
  // não há piso; refuse em prod sem piso). Desligado (default) ⇒ comportamento atual.
  const sandboxLauncher = process.env.ALUY_SANDBOX_BASH ? createSandbox() : undefined;

  // ── EST-1110 · ADR-0114 — resolver de PERGUNTA (`perguntar`) da TUI ──────────
  // Criado ANTES das ports p/ injetar `question` nelas. Padrão CONTROLADOR (como o
  // TuiAskResolver): publica a pergunta pendente, a UI a renderiza, a Promise resolve
  // na resposta. Fail-safe não-pendura (sem TTY ⇒ `setNonInteractive` no run.tsx).
  const questionResolver = new TuiQuestionResolver();

  // ── EST-1126 · ADR-0123 §4 — grafo de caixas de contexto POR SESSÃO ─────────
  // O ContextGraph é DADO+heurística PORTÁVEL (cli-core, ADR-0053 §8): o @hiperplano/aluy-cli
  // só o INSTANCIA e o injeta como porta. Com ele presente, `update_plan` sincroniza
  // os passos → caixas (syncPlanToGraph) e renderiza com HORIZONTE + ANINHAMENTO
  // (renderPlanChecklistFromGraph) em vez da lista FLAT — o plano vira hierárquico.
  // Ausente ⇒ a tool cai no render flat (não-regressão EST-1015). Uma instância por
  // sessão: o estado do plano (caixas abertas/fechadas) vive enquanto a sessão vive.
  const contextGraph = new ContextGraph();

  const ports: ToolPorts = {
    fs,
    shell: new NodeShellPort({
      workspace,
      timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
      ...(sandboxLauncher ? { sandboxLauncher } : {}),
      // EST-1020 · P1 · ADR-0065 §8.2 (APR-0087) · ADR-0060 (CLI-SEC-5) — a REDE do
      // sandbox abre SÓ via a política de egress REAL (o MESMO `EgressAllowlist` da
      // catraca, default-deny). `inspect()` extrai o destino e diz se está dentro;
      // network só quando HÁ host E ele está DENTRO da allowlist. Sem host ou host
      // fora ⇒ false (network:false; o connect falha confinado). NÃO reimplementa a
      // política — consulta a mesma instância. (Só tem efeito sob `sandboxLauncher`.)
      egressAllows: (command: string): boolean => {
        const inspection = egress.inspect(command);
        return inspection.hasNetwork && !inspection.outsideAllowlist;
      },
    }),
    search: new NodeSearchPort({ workspace }),
    journal: journal.toolPort,
    web,
    // EST-0982 — porta do DIRETÓRIO DE TRABALHO DE SESSÃO p/ a tool `change_dir`. É o
    // PRÓPRIO `workspace` (NodeWorkspace implementa CwdPort): assim o `change_dir`, o
    // shell-port (cwd) e o fs/search (resolveInside relativo) compartilham UMA fonte de
    // verdade do `sessionCwd` — mexer no cwd via tool reflete instantaneamente em TODOS.
    cwd: workspace,
    // A face de ESCRITA (subset) que a tool `remember` enxerga — só `remember(...)`,
    // sem leitura/path. EST-0983 (extensão · recall): a face de LEITURA (subset) que a
    // tool `recall` enxerga — só `searchFacts(query?)`, sem path. Ambas pela mecânica
    // interna confinada a `memory/` (read-deny de `~/.aluy/memory/` p/ o agente mantido).
    memory: {
      remember: (text, scope, provenance) => memory.remember(text, scope, provenance),
      searchFacts: (query, limit) => memory.searchFacts(query, limit),
    },
    // EST-1108 — porta do BACKLOG/TODO que as tools add_todo/list_todos/done_todo
    // enxergam. É o PRÓPRIO NodeTodoStore (implementa TodoStorePort). Porta estreita:
    // add(text)/list()/done(id)/clearDone() — NUNCA `write(path, bytes)`.
    todo: todoStore,
    // EST-1110 · ADR-0114 — porta de PERGUNTA que a tool `perguntar` enxerga. É o
    // PRÓPRIO TuiQuestionResolver (implementa QuestionPort). Sem efeito externo; em
    // sessão não-interativa resolve `unavailable` (fail-safe não-pendura).
    question: questionResolver,
    // EST-1126 — grafo de caixas da sessão. Quando presente, `update_plan` projeta
    // os passos como caixas e renderiza o checklist com horizonte + aninhamento.
    graph: contextGraph,
  };

  // ── canal `@arquivo` (EST-0957) — índice + leitor confinado/path-deny ────────
  const fileIndex = new NodeFileIndexPort({ workspace });
  const attachReader = new AttachReader({ workspace, fs });

  // ── catraca concreta (0945/0959) — diff EXATO p/ confirmação de edit (CLI-SEC-9) ─
  // EST-0959 · ADR-0055: o eixo de MODO inicial (`initialMode`, resolvido acima).
  // `plan` = teto read-only; `unsafe`/YOLO = PERMISSÃO COMPLETA (ADR-0072); `normal`
  // = catraca intacta.
  const engine = new PolicyPermissionEngine({
    mode: initialMode,
    // EST-0944 — write_file: (path, content) ⇒ diff de adição (arquivo novo/rewrite).
    // edit_file (str_replace): (path, new_string, old_string) ⇒ diff do TRECHO trocado
    // (old→new), o efeito EXATO; o resto do arquivo fica intacto por construção.
    diffPreview: (path, newText, oldText) =>
      oldText !== undefined
        ? unifiedDiff(path, oldText, newText, true)
        : unifiedDiff(path, '', newText, false),
    // EST-0983 · CLI-SEC-15 (GS-M2) — teto de gravações de memória por sessão.
    ...(opts.maxMemoryWritesPerSession !== undefined
      ? { maxMemoryWritesPerSession: opts.maxMemoryWritesPerSession }
      : {}),
  });

  // ── ask resolver da TUI (0948 — fail-safe deny em timeout/abort) ────────────
  const askResolver = new TuiAskResolver(
    opts.askTimeoutMs !== undefined ? { timeoutMs: opts.askTimeoutMs } : {},
  );

  // ── HOOKS de ciclo-de-vida (EST-0974/0980) ──────────────────────────────────
  // Lê o DADO (`~/.aluy/hooks.json` + settings do Claude) — fail-safe ⇒ vazio. O
  // `HookRunner` executa CADA comando ATRÁS da MESMA catraca (`decide`) + shell
  // confinado do agente — NÃO é caminho de shell paralelo. O GATE de pre-tool
  // (EST-0980) compõe MONOTONICAMENTE com a catraca (só REFORÇA o deny, nunca relaxa):
  // a tool só roda se `decide()==allow` E nenhum hook de gate vetou. Ausência de hooks
  // de gate ⇒ `undefined` (o loop nem consulta a porta — zero overhead).
  // O store default descobre TAMBÉM o `.claude/settings.json` do projeto (compat,
  // EST-0980) sob a raiz do workspace — hooks de projeto são DADO não-confiável e
  // atravessam a MESMA catraca. Um store injetado (teste) vence o default.
  const hooksConfig: HooksConfig = (
    opts.hooksConfigStore ??
    new HooksConfigStore({ workspaceRoot: opts.workspaceRoot ?? process.cwd() })
  ).load();
  const hookRunner = new HookRunner({ permission: engine, ports, askResolver });
  const preToolGate = makePreToolGate({ runner: hookRunner, config: hooksConfig });

  // ── caller de streaming (emite tokens à TUI) ────────────────────────────────
  const tier = opts.tier ?? DEFAULT_TIER;
  // EST-0973 (fix) — JANELA DE CONTEXTO do tier ativo (denominador REAL da % janela +
  // trigger da auto-compactação). Resolvida do catálogo (principal model's context);
  // `custom` ⇒ 0 (inerte). F64 (fix) — quando o tier não conhece a janela (`custom`/
  // `--backend local`), `resolveContextWindow` cai no override `ALUY_CONTEXT_WINDOW`
  // (opt-in): habilita a auto-compactação no modo local. Sem o env, segue 0 (inerte).
  // Passada ao controller e RE-RESOLVIDA na troca de tier (`/model`).
  const contextWindow = resolveContextWindow(tier, env);
  // EST-0972 (BUG Custom) — slug Custom do BOOT: só vale sob `tier:'custom'`. Vem de
  // uma sessão retomada (run.tsx); fora de Custom é ignorado (não vaza Custom em tier
  // canônico). String opaca / chave de catálogo (HG-2), nunca credencial.
  const bootModel = tier === 'custom' ? opts.model : undefined;
  // EST-0962 (`--provider`) — NOME do provider do BOOT: só vale em par com o slug Custom
  // (sob `tier:'custom'` E com `bootModel`). Fora disso é ignorado (não atribui provider
  // a um tier canônico nem a um Custom sem slug). É só o NOME (DADO, não credencial — HG-2).
  const bootProvider = bootModel !== undefined ? opts.provider : undefined;
  // EST-0962 (--effort) — reasoning_effort PASSTHROUGH (qualquer string ≤32 chars).
  // SEM tier-gate: vale em qualquer tier. undefined ⇒ não enviado.
  const effort = opts.effort;
  // EST-0948 — TETOS EFETIVOS da sessão (CLI-SEC-8), MESMA disciplina flag>env>default,
  // validados e CLAMPADOS num teto-teto pelo core (anti-runaway não-relaxável):
  //  - TOKENS: `--max-tokens` > `ALUY_MAX_TOKENS` > default (1M).
  //  - ITERAÇÕES: `--max-iterations` > `ALUY_MAX_ITERATIONS` > default (300). O
  //    `maxToolCalls` segue derivado do default (2× iterações) — não vira gargalo.
  // O controller os owna no `SessionBudget`/`SharedBudget` e os usa nos indicadores
  // em % e no `[c] continuar` (que ESTENDE +50 iterações, não relaxa o clamp).
  //
  // ADR-0119 — BUDGET LOCAL: ligado por `--budget`/`--no-budget` > `ALUY_BUDGET` >
  // config `localBudget`. No backend LOCAL é ON/OFF; no broker é SEMPRE ON (se o
  // usuário tentar OFF no broker, avisamos e mantemos ON).
  const budgetOn = (() => {
    if (opts.effectiveBackend !== 'local') {
      if (opts.localBudget === false) {
        opts.onConfigWarn?.(
          'aluy: budget OFF não se aplica ao backend broker — ' +
            'o orçamento de sessão está SEMPRE ativo no broker. Use --backend local ' +
            'para desligá-lo (BYO).',
        );
      }
      return true;
    }
    return opts.localBudget !== false;
  })();
  const limits: SessionLimits = budgetOn
    ? {
        ...DEFAULT_LIMITS,
        maxIterations: resolveMaxIterations(opts.maxIterations, env.ALUY_MAX_ITERATIONS),
        maxTokens: resolveMaxTokens(opts.maxTokens, env.ALUY_MAX_TOKENS),
      }
    : {
        maxIterations: MAX_ITERATIONS_CEILING,
        maxToolCalls: MAX_ITERATIONS_CEILING * 2,
        // maxTokens undefined = sem budget de tokens
      };

  // EST-0948 — `max_tokens` de OUTPUT POR CHAMADA (anti-TRUNCAMENTO), DISTINTO do
  // budget local acima. Precedência `--max-output-tokens` > `ALUY_MAX_OUTPUT_TOKENS` >
  // UNSET. DEFAULT UNSET (`undefined`): por padrão NÃO mandamos `max_tokens` ⇒ o broker
  // decide (HG-2/CLI-SEC-7). Só vira número quando o usuário configura; inválido ⇒ UNSET
  // + aviso (não quebra). Quando definido, é fiado no caller de stream do loop E no caller
  // dos sub-agentes (filhos também geram arquivos) — vai no corpo do request ao broker.
  const maxOutputTokens = resolveMaxOutputTokens(
    opts.maxOutputTokens,
    env.ALUY_MAX_OUTPUT_TOKENS,
    opts.onConfigWarn,
  );
  // EST-0944 — SELF-CHECK de atenção (re-âncora + auto-verificação): gating FLAG
  // (`--self-check`/`--no-self-check`) > ENV (`ALUY_SELF_CHECK`) > AUTO por tier fraco
  // (só `custom`; o default flux NÃO é fraco). OFF por default global (não onera quem não quer); LIGA
  // sozinho onde compensa. O K da re-âncora e o cap de verificações são overrides
  // OPCIONAIS por env (clampados). O tier aqui é o do BOOT — base de atenção da sessão.
  const selfCheck = resolveSelfCheck({
    flag: opts.selfCheck,
    env: env.ALUY_SELF_CHECK,
    tier,
    everyKEnv: env.ALUY_SELF_CHECK_EVERY,
    maxVerificationsEnv: env.ALUY_SELF_CHECK_MAX,
  });
  const meta: SessionMeta = {
    // EST-0982 — arranca no `sessionCwd` (= raiz no boot). O controller o RE-ESPELHA
    // após cada tool (via `ports.cwd`), então um `change_dir` atualiza o StatusBar.
    cwd: workspace.cwd,
    tier,
    // EST-0972 (BUG Custom) — espelha o slug Custom retomado p/ a StatusBar/Header já
    // no boot (`custom · <slug>`). Só sob `tier:'custom'` (bootModel); undefined fora.
    ...(bootModel !== undefined ? { model: bootModel } : {}),
    // ADR-0120 — backend EFETIVO espelhado p/ a StatusBar indicar o modo (broker/local).
    ...(opts.effectiveBackend !== undefined ? { backend: opts.effectiveBackend } : {}),
    tokens: 0,
    windowPct: 0,
  };

  // O sink precisa do controller; resolvemos a referência circular criando o
  // caller com um sink-proxy que delega ao controller após construído.
  let controllerRef: SessionController | null = null;
  const caller = new StreamingModelCaller({
    client: brokerClient,
    tier,
    // EST-0972 (BUG Custom) — slug Custom retomado: só sob `tier:'custom'` (bootModel).
    // Sem isto, a 1ª chamada após retomar uma sessão Custom ia SEM model ⇒ 422.
    ...(bootModel !== undefined ? { model: bootModel } : {}),
    // EST-0962 (`--provider`) — NOME do provider em par com o slug Custom do boot. Só
    // entra com `bootProvider` (já travado em custom+model). Só o NOME (HG-2, não credencial).
    ...(bootProvider !== undefined ? { provider: bootProvider } : {}),
    // EST-0962 (--effort) — reasoning_effort PASSTHROUGH (SEM tier-gate). undefined ⇒ não enviado.
    ...(effort !== undefined ? { effort } : {}),
    // EST-0948 — teto de OUTPUT por chamada (anti-truncamento): só entra quando o
    // usuário configurou (`--max-output-tokens`/`ALUY_MAX_OUTPUT_TOKENS`). UNSET ⇒ o
    // request não leva `max_tokens` e o broker decide (comportamento de hoje, default).
    ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
    sink: {
      onStart: () => controllerRef?.sink.onStart?.(),
      onDelta: (c) => controllerRef?.sink.onDelta(c),
      onUsage: (u) => controllerRef?.sink.onUsage?.(u),
      onQuota: (q) => controllerRef?.sink.onQuota?.(q),
      onDone: () => controllerRef?.sink.onDone?.(),
    },
  });

  // EST-0973 — caller DEDICADO da compactação (`/compact`): NÃO-streaming (o resumo
  // é interno, não vaza tokens na UI como turno) e com TETO próprio (CLI-SEC-8). Vai
  // pelo MESMO broker (CLI-SEC-7) — só não usa o sink de stream.
  // EST-0962 (Custom) · HG-2 — `tierSource: caller` faz a compactação SEGUIR o tier /
  // slug Custom CORRENTE do pai (StreamingModelCaller), igual ao `/ask` e aos sub-
  // agentes. Sem isto, sob `tier:'custom'` o model slug não viajava ⇒ broker 422
  // ("Custom exige model"); e ao trocar de tier via `/model` a compactação ficava
  // presa no tier de boot (não seguia o novo). O `model` só viaja sob tier custom.
  const compactionCaller = new BrokerModelCaller({
    client: brokerClient,
    tier,
    tierSource: caller,
    maxTokens: DEFAULT_SUMMARY_MAX_TOKENS,
  });

  // EST-ASK · ADR-0080 — caller DEDICADO do `/ask` (pergunta paralela read-only):
  // NÃO-streaming (a resposta vai num NOTE, não vaza tokens como turno) e SEM nativeTools
  // anexadas ⇒ read-only POR CONSTRUÇÃO (o modelo não tem o que chamar; a catraca nem é
  // tocada). Mesmo broker (CLI-SEC-7); `tierSource: caller` faz seguir o tier/modelo
  // CORRENTE do pai (o usuário pergunta com o mesmo modelo que escolheu via `/model`).
  // NÃO recebe `attachNativeTools` — é o que o mantém read-only (≠ o caller do loop).
  const sideQueryCaller = new BrokerModelCaller({
    client: brokerClient,
    tier,
    tierSource: caller,
    maxTokens: 2048,
  });

  // EST-0969 (display) · CLI-SEC-7 — caller DEDICADO dos SUB-AGENTES (filhos):
  // NÃO-streaming. Vai pelo MESMO broker/credencial do pai (sem 2ª rota de modelo), só
  // NÃO usa o sink de stream ao vivo. Sem isto, os N filhos paralelos usariam o caller
  // de streaming do pai e seus tokens INTERLEAVARIAM na região viva (lixo ilegível);
  // com este, a resposta de cada filho é AGREGADA internamente e só o resultado
  // consolidado volta ao pai (a UI mostra status por filho, não os tokens crus).
  // Só entra quando sub-agentes estão habilitados (mono-agente não o usa).
  // EST-0948 — o `max_tokens` de OUTPUT vale TAMBÉM p/ os filhos (sub-agentes geram
  // arquivos também ⇒ truncar a saída deles é o mesmo bug). Propagado quando configurado;
  // UNSET ⇒ o broker decide (igual ao pai). NÃO confundir com o budget local da sessão,
  // que os filhos compartilham via SharedBudget (agregado) — são eixos distintos.
  // EST-0962 (Custom) · HG-2 — a pista de modelo dos FILHOS ACOMPANHA a do PAI em
  // RUNTIME. `tierSource: caller` faz o caller dos sub-agentes ler o tier + slug
  // Custom CORRENTE do `StreamingModelCaller` do pai (getters `tier`/`model`) a cada
  // chamada — NÃO o `tier` fixo de construção. Sem isto, o pai em `tier:'custom'`
  // gerava um filho com `tier:'custom'` SEM `model` ⇒ broker 422 ("Custom exige
  // model"); ou um filho preso no tier default (não no que o usuário escolheu via
  // `/model`). O `model` só viaja sob `tier:'custom'` (trava dupla no caller +
  // `buildChatBody`) — HG-2 intocado: é a CHAVE de catálogo, não credencial; o
  // broker a revalida e resolve provider/credencial server-side. NUNCA sai
  // provider/api_key/base_url (não existem no cliente).
  const subAgentCaller = opts.subAgents?.enabled
    ? new BrokerModelCaller({
        client: brokerClient,
        tier,
        tierSource: caller,
        ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
      })
    : undefined;

  // EST-SUBAGENT-MODEL · ADR-0073 (tier por-request) · CLI-SEC-7 — FÁBRICA de caller
  // POR TIER dos sub-agentes. Quando o `.md` de um filho declara `model:` que resolve
  // num tier, o spawner pede AQUI o caller daquele tier; ele manda o tier FIXO no
  // request (NÃO o `tierSource` do pai — o filho roteado por `.md` NÃO segue o `/model`
  // do pai: o `.md` é a capacidade declarada que decide o tier dele). MESMO broker/
  // credencial (CLI-SEC-7): só varia a pista de tier (HG-2) — o broker resolve
  // provider/credencial/quota e VALIDA (422 se inservível, degrade honesto). Não há
  // `model`/`tierSource` Custom aqui: tiers do `.md` são chaves de catálogo `aluy-*`
  // (não a via Custom slug+provider, que é só do PAI). CACHE por tier ⇒ 1 caller por
  // tier (o `attachNativeTools` se aplica a TODOS os cacheados, incl. os criados após
  // o `onToolsReady`, via `latestToolsCap`). Só existe com sub-agentes habilitados.
  const tierCallers = new Map<string, BrokerModelCaller>();
  let latestToolsCap: NativeToolsCapability | undefined;
  const callerForTier = opts.subAgents?.enabled
    ? (t: string): BrokerModelCaller => {
        const cached = tierCallers.get(t);
        if (cached) return cached;
        const c = new BrokerModelCaller({
          client: brokerClient,
          // tier FIXO do `.md` do filho — NÃO o `tierSource` do pai (o filho roteado
          // por `.md` decide o próprio tier; o broker valida — 422 se inservível).
          tier: t,
          ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
        });
        // EST-0996 — se o catálogo de tools já chegou (onToolsReady), anexa-o ao caller
        // recém-criado (mesmo degrade no 422 p/ toda a árvore). Os criados ANTES do
        // catálogo o recebem pelo loop do `onToolsReady` abaixo (que itera o cache).
        if (latestToolsCap) c.attachNativeTools(latestToolsCap);
        tierCallers.set(t, c);
        return c;
      }
    : undefined;

  // ── room store (EST-1119 · ADR-0121 §5) ────────────────────────────────────
  const roomBackendRes = resolveRoomBackend(env.ALUY_ROOM_BACKEND, opts.roomsBackend);
  if (roomBackendRes.warning && opts.onConfigWarn) {
    opts.onConfigWarn(roomBackendRes.warning);
  }
  const roomStore: RoomStore = (() => {
    switch (roomBackendRes.backend) {
      case 'memory':
        return new MemoryRoomStore();
      case 'file':
        return new FileRoomStore();
      case 'loopback':
      case 'broker':
        // Seam ausente — erro LOUD (responsabilidade do wiring).
        throw new Error(
          `Room backend "${roomBackendRes.backend}" não implementado ainda. ` +
            `Use "memory" ou "file", ou deixe o default.`,
        );
      default:
        // fail-safe: nunca chega (resolveRoomBackend garante valores válidos).
        return new MemoryRoomStore();
    }
  })();

  const controller = new SessionController({
    model: caller,
    compactionModel: compactionCaller,
    sideQueryModel: sideQueryCaller,
    permission: engine,
    // EST-1119 · ADR-0121 §5 — backend de salas configurável
    roomStore,
    ports,
    askResolver,
    // EST-1110 · ADR-0114 — resolver de PERGUNTA (TUI): o controller observa o pendente
    // p/ publicar a fase `questioning` + o `pendingQuestion` e devolve a resposta.
    questionResolver,
    // EST-0980 — GATE de pre-tool (hooks `gate:true`). Só passa quando HÁ hooks de gate
    // (senão `undefined` ⇒ o loop roda idêntico ao baseline). Composição MONOTÔNICA com
    // a catraca: a tool só roda se a catraca permitiu E nenhum hook vetou (AND lógico).
    ...(preToolGate ? { preToolGate } : {}),
    // EST-0980 — `user-prompt-submit` (Claude: UserPromptSubmit): dispara os hooks no
    // TOPO de cada `submit()` (observe-only, atrás da catraca, best-effort). Só pluga
    // quando HÁ hooks desse evento (senão no-op — zero overhead).
    ...(selectHooks(hooksConfig, 'user-prompt-submit').length > 0
      ? {
          onUserPromptSubmit: (): void => {
            void hookRunner.runAll(selectHooks(hooksConfig, 'user-prompt-submit'));
          },
        }
      : {}),
    meta,
    // EST-0948 — tetos EFETIVOS da sessão (teto de tokens resolvido flag>env>default,
    // clampado). O controller os owna no budget e os usa nos indicadores % + no `[c]`.
    limits,
    // EST-0944 — SELF-CHECK de atenção resolvido (flag>env>tier fraco). Só repassado
    // quando ENABLED (`SELF_CHECK_OFF` ⇒ baseline, nem passa — o loop ignora de todo jeito).
    ...(selfCheck.enabled ? { selfCheck } : {}),
    // EST-0973 — AUTO-COMPACTAÇÃO da janela: repassa o limiar CRU de `--autocompact-at`
    // (a flag vence o env). O controller resolve flag>env>default 0.85 com a janela do
    // modelo (`contextWindow`). Sem a flag, cai no env/default (ligada por padrão).
    ...(opts.autoCompactAt !== undefined ? { autoCompactAt: opts.autoCompactAt } : {}),
    // EST-0973 (fix) — JANELA DE CONTEXTO do tier ativo (denominador da % janela +
    // auto-compactação). Resolvida do catálogo (ex.: 128k p/ Strata, 256k p/ Flui,
    // 200k p/ Cortex, 0 p/ Custom). SEMPRE passada (≠200k hardcoded). O controller
    // a re-resolve na troca de tier (`setTier`).
    contextWindow,
    // EST-0964 — AGENT.md confiável (já lido/clampado no startup) → canal `system`.
    ...(opts.projectInstructions !== undefined
      ? { projectInstructions: opts.projectInstructions }
      : {}),
    // EST-1109 — agentes DISPONÍVEIS no contexto: nota já formatada pelo core.
    ...(opts.availableAgents !== undefined ? { availableAgents: opts.availableAgents } : {}),
    // EST-1149 — comandos da SESSÃO no contexto: nota já formatada.
    ...(opts.sessionCommands !== undefined ? { sessionCommands: opts.sessionCommands } : {}),
    // EST-0970 — tools MCP já descobertas (handshake no startup) → registro atrás
    // da catraca. Efeito por padrão; classificadas por sinais do input (E-B2).
    ...(opts.mcpTools !== undefined ? { mcpTools: opts.mcpTools } : {}),
    // EST-1015 (POC headroom) — RETRIEVE: só monta a tool quando `ALUY_HEADROOM_URL`
    // aponta p/ o proxy LOCAL do usuário. Ausente ⇒ a sessão segue idêntica (sem ela).
    // Efeito `network` ⇒ atrás da catraca (`always-ask:network`, Plan-deny) como web_fetch.
    ...(() => {
      const headroomUrl = headroomUrlFromEnv(env);
      return headroomUrl !== undefined
        ? { headroomRetrieveTool: makeHeadroomRetrieveTool({ baseUrl: headroomUrl }) }
        : {};
    })(),
    // EST-0969 · ADR-0057 — sub-agentes locais paralelos (tool `spawn_agent`). Só
    // entra quando habilitado; o controller monta o spawner com a MESMA engine/
    // ports/budget/ask do pai (não-bypass + escopo ⊆ pai + E-A1/E-A2/E-A3).
    // EST-0980 — anexa um observador de `subagent-stop` (Claude: SubagentStop) que
    // dispara os hooks no `onChildEnd` (observe-only, atrás da catraca). Só quando HÁ
    // hooks desse evento (senão segue sem observer — zero overhead).
    ...(opts.subAgents?.enabled
      ? {
          subAgents: {
            ...opts.subAgents,
            ...(selectHooks(hooksConfig, 'subagent-stop').length > 0
              ? {
                  observer: {
                    onChildEnd: (): void => {
                      void hookRunner.runAll(selectHooks(hooksConfig, 'subagent-stop'));
                    },
                  },
                }
              : {}),
          },
        }
      : {}),
    // EST-0977/0978 — registro de agentes-`.md` nomeados (só usado com sub-agentes
    // habilitados): habilita `spawn_agent({ agent: "<nome>" })` com persona/toolset
    // (⊆ pai)/tier do `.md`. Nome desconhecido ⇒ erro visível (GS-MD7).
    ...(opts.subAgents?.enabled && opts.agentRegistry ? { agentRegistry: opts.agentRegistry } : {}),
    // EST-0969 (display) — caller dedicado dos filhos (não-streaming): evita o
    // interleave dos tokens crus dos N filhos na região viva do pai.
    ...(subAgentCaller ? { subAgentModel: subAgentCaller } : {}),
    // EST-SUBAGENT-MODEL — fábrica de caller POR TIER: cada filho cujo `.md` declara
    // `model:` que resolve num tier fala AQUELE tier ao broker (o spawner roteia por
    // filho). Ausente ⇒ todos os filhos usam o `subAgentModel`/`model` do pai (back-compat).
    ...(callerForTier ? { callerForTier } : {}),
    // EST-0996 — TOOL-CALLING NATIVO: o controller (dono do toolset FINAL) constrói o
    // catálogo de funções e nos entrega a capacidade AQUI; nós a ATTACHAMOS ao caller
    // de stream do pai E ao caller dedicado dos sub-agentes (MESMA capacidade ⇒ mesmo
    // degrade no 422 p/ toda a árvore). A pista `tools` reflete EXATAMENTE as tools
    // que o agente pode chamar (HG-2: catálogo, não credencial). Desligável por env.
    disableNativeTools: env.ALUY_NATIVE_TOOLS_OFF === '1' || env.ALUY_NATIVE_TOOLS_OFF === 'true',
    // EST-0969 (watchdog de TRAVAMENTO) — o env da sessão alimenta os limiares/toggle
    // do watchdog (`ALUY_STUCK_*` / `ALUY_STUCK_OFF`). Ligado por default: quando o
    // agente gira sem avançar, a sessão PAUSA e PEDE DIREÇÃO (não morre no teto).
    watchdogEnv: env,
    // EST-0948 · ADR-0069 — fonte da quota da PRÓPRIA conta (`GET /v1/quota`): saldo de
    // CRÉDITO (primário) + janelas, p/ o footer. Degrada silencioso (broker fora/
    // deslogado ⇒ `undefined` ⇒ footer oculto). O controller a chama no boot + refresh.
    quotaFetcher: () => quotaClient.fetchQuota(),
    // EST-1012 — MONITOR DE PRESSÃO DE MEMÓRIA (backstop de OOM): repassa o heap-limit
    // (o MESMO do launcher) + o amostrador do heap. A config escalonada é resolvida no
    // controller (env `ALUY_MEM_PRESSURE_AT`/`_OFF`). A porta de encerramento-limpo é
    // injetada DEPOIS pelo run.tsx (que tem o `unmount` da TUI). Ausente ⇒ desligado.
    ...(opts.memoryMonitor !== undefined
      ? {
          memory: {
            heapLimitMb: opts.memoryMonitor.heapLimitMb,
            sampleHeapUsed: opts.memoryMonitor.sampleHeapUsed,
            env,
            ...(opts.memoryMonitor.sampleIntervalMs !== undefined
              ? { sampleIntervalMs: opts.memoryMonitor.sampleIntervalMs }
              : {}),
          },
        }
      : {}),
    // EST-XXXX (CHECKPOINTS) — marca um ponto no início de cada prompt do usuário. O
    // `blockCountBefore` (transcrição SEM este prompt) é o corte da conversa; a fronteira
    // de código (seq do journal) é lida pelo registry no momento da marcação.
    onUserPrompt: (goal, blockCountBefore) => {
      checkpoints.markPrompt(goal, blockCountBefore);
    },
    // EST-1137 (C3) — MAESTRO: liga a regência de fluxo via flag ALUY_MAESTRO (default OFF).
    // O wiring resolve o `MaestroPort` concreto (engines + bus + rege) e o injeta.
    // Quando OFF (default), retorna undefined ⇒ baseline bit-a-bit.
    ...(() => {
      const maestro = resolveMaestro({ env });
      if (!maestro) return {};
      // F54 — também liga a política de CONTINUAÇÃO (fim-de-turno). Sem este fio,
      // o seam fica inerte e o agente "para e pede totó" (default-ON c/ Maestro).
      const continuationConfig = resolveContinuationCfg(env);
      return continuationConfig ? { maestro, continuationConfig } : { maestro };
    })(),
    // F-MEM — liga a MEMÓRIA (Mem0): recall+store no loop, escopo por projeto.
    // Independente do Maestro (kill-switch próprio ALUY_MEM_OFF). Default ON.
    ...(() => {
      const mem = resolveMemory({ env });
      return mem
        ? {
            memoryEngine: mem.memory,
            memoryScope: mem.memoryScope,
            memoryRecallScopes: mem.memoryRecallScopes,
          }
        : {};
    })(),
    onToolsReady: (cap) => {
      caller.attachNativeTools(cap);
      subAgentCaller?.attachNativeTools(cap);
      // EST-SUBAGENT-MODEL — o MESMO catálogo de tools vai a TODO caller por-tier já
      // criado (mesmo degrade no 422 p/ a árvore inteira); `latestToolsCap` garante que
      // os criados DEPOIS (lazy, no 1º spawn daquele tier) também o recebam.
      latestToolsCap = cap;
      for (const c of tierCallers.values()) c.attachNativeTools(cap);
    },
  });
  controllerRef = controller;

  return {
    controller,
    login,
    engine,
    egress,
    workspace,
    askResolver,
    questionResolver,
    journal,
    journalStore,
    checkpoints,
    fileIndex,
    attachReader,
    catalogClient,
    customModelClient,
    providersClient,
    quotaClient,
    ports,
    memory,
    todoStore,
    hookRunner,
    hooksConfig,
  };
}
