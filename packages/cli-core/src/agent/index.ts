// Barrel do engine de agente (EST-0944). Loop + tools + tetos + idempotency.
// PORTÁVEL (ADR-0053 §8): nada de Ink/IO de terminal. A TUI (EST-0948) consome
// isto; a engine de permissão concreta (EST-0945) pluga no ponto único `decide()`.
export * from './protocol.js';
export * from './context.js';
export * from './limits.js';
export * from './idempotency.js';
// EST-ASK (ADR-0080) — side-query do /ask (pergunta paralela read-only).
export {
  runSideQuery,
  summarizeLiveFlows,
  type SideQueryArgs,
  type SideQueryCaller,
} from './side-query.js';
// EST-MON-1 (ADR-0079) — capacidade Monitor: a EventQueue + o formato de evento-como-DADO.
export { EventQueue, formatMonitorEventAsData, type MonitorEvent } from './monitor/event-queue.js';
// EST-MON-3/4 (ADR-0079) — gatilhos read-only: file-watch + process-wait.
// EST-MON-7 (ADR-0079 adendo) — gatilho exec: command-wait (spawn injetado).
export { CommandWaitTrigger, FileWatchTrigger, ProcessWaitTrigger } from './monitor/triggers.js';
export type {
  CommandSpawnHandle,
  CommandWaitTriggerOptions,
  FileWatchTriggerOptions,
  ProcessWaitTriggerOptions,
} from './monitor/triggers.js';
// EST-MON-5 (ADR-0079) — MonitorStore: orquestração dos gatilhos com limite de concorrência.
export { MonitorStore } from './monitor/monitor-store.js';
export { buildMonitorTools } from './monitor/monitor-tools.js';
export type { ActiveMonitor, ArmSpec, MonitorStoreOptions } from './monitor/monitor-store.js';
export {
  AgentLoop,
  type AgentLoopOptions,
  type AgentRunResult,
  type ModelCaller,
  type StopReason,
  type ToolLifecycleObserver,
  type ProgressSignal,
  type ProgressObserver,
  type InjectedInputPort,
  type PreToolGate,
  type PreToolGateVerdict,
  type WeakYoloGuardrailConfig,
  type AutoCompactPort,
  type AutoCompactResult,
  type AutoCompactObserver,
  type MaestroPort,
} from './loop.js';
// EST-SEC-HARDEN (F21) · AG-0008 — GUARDRAIL do combo perigoso (yolo+tier-fraco+
// untrusted): detecção PURA + textos (warn no stderr + reforço do envelope).
export {
  type WeakYoloDetectInputs,
  WEAK_YOLO_WARNING_MARKER,
  WEAK_YOLO_REANCHOR_MARKER,
  detectWeakYoloUntrusted,
  hasUntrustedInContext,
  buildWeakYoloWarning,
  buildWeakYoloReanchor,
} from './weak-yolo-guardrail.js';
// EST-0973 — AUTO-COMPACTAÇÃO da JANELA de contexto: config + gating (env/flag) +
// juízo/anti-loop PUROS. A compactação concreta reusa o /compact (Compactor) via porta.
export {
  type AutoCompactConfig,
  type AutoCompactInputs,
  type AutoCompactState,
  type AutoCompactDecision,
  AUTOCOMPACT_OFF,
  DEFAULT_AUTOCOMPACT_AT,
  DEFAULT_MAX_CONSECUTIVE_AUTOCOMPACT,
  AUTOCOMPACT_GAVEUP_MARKER,
  resolveAutoCompact,
  decideAutoCompact,
  windowRatio,
  newAutoCompactState,
  parseAutoCompactAt,
} from './auto-compact.js';
// EST-1012 — ROBUSTEZ DE MEMÓRIA · backstop de OOM: juízo PURO + ESCALONADO + ANTI-
// SPAM da pressão de heap (compactar → avisar → encerrar-limpo). Config/limiares
// via env (`ALUY_MAX_HEAP_MB`/`ALUY_MEM_PRESSURE_AT`/`ALUY_MEM_PRESSURE_OFF`). A
// amostragem do heap e a AÇÃO concreta (auto-compactar/avisar/encerrar-salvando)
// vivem no locus (controller). REUSA a compactação do `/compact` (#157) como 1ª reação.
export {
  type MemPressureConfig,
  type MemPressureInputs,
  type MemPressureState,
  type MemPressureAction,
  MEM_PRESSURE_OFF,
  DEFAULT_COMPACT_AT,
  DEFAULT_WARN_AT,
  DEFAULT_SHUTDOWN_AT,
  DEFAULT_MAX_HEAP_MB,
  MIN_MAX_HEAP_MB,
  MAX_MAX_HEAP_MB,
  MAX_HEAP_MB_ENV,
  MEM_PRESSURE_AT_ENV,
  MEM_PRESSURE_DISABLE_ENV,
  MEM_PRESSURE_WARN_MARKER,
  MEM_PRESSURE_SHUTDOWN_MARKER,
  resolveHeapLimitMb,
  resolveMemPressure,
  decideMemPressure,
  heapPressureRatio,
  parseMemPressureAt,
  isMemPressureEnabled,
  newMemPressureState,
  noteMemAction,
  relaxMemPressure,
  bytesToMb,
} from './mem-pressure.js';
// EST-0944 — SELF-CHECK de atenção (re-âncora de objetivo + auto-verificação pré-
// "pronto"). Config + gating puros (flag/env/tier fraco) + redatores dos lembretes.
export {
  type SelfCheckConfig,
  type SelfCheckInputs,
  SELF_CHECK_OFF,
  WEAK_TIERS,
  DEFAULT_REANCHOR_EVERY_K,
  DEFAULT_MAX_VERIFICATIONS,
  REANCHOR_MARKER,
  SELF_CHECK_MARKER,
  isWeakTier,
  resolveSelfCheck,
  buildReanchor,
  buildSelfCheckProbe,
  buildVerificationCapNote,
} from './self-check.js';
// EST-F54 — Política de CONTINUAÇÃO do regente (Inv. I Fluidez): decideContinuation
// (função PURA) + detectores (isAnnounceNoTool) + nudge + resolveContinuationConfig.
// TETOS DUROS INEGOCIÁVEIS (anti-runaway): cap=4, giveUp=3, nudge=1. NUNCA toca
// decide()/permission (CLI-SEC-H1). Cada continuação consome iteração (CLI-SEC-14).
export {
  decideContinuation,
  buildContinuationNudge,
  resolveContinuationConfig,
  isAnnounceNoTool,
  endsWithUserQuestion,
  hasPendingPlanWork,
  buildPlanPendingNudge,
  DEFAULT_CONTINUATION_CONFIG,
  type ContinuationConfig,
  type ContinuationState,
  type ContinuationVerdict,
  type PlanBoxLike,
} from './continuation.js';

export {
  BrokerModelCaller,
  type BrokerModelCallerOptions,
  type ModelTierSource,
} from './model-caller.js';
// EST-0996 — TOOL-CALLING NATIVO: capacidade compartilhada pelos callers (decide
// mandar `tools` + degrade no 422). A conversão do catálogo → schema de função sai
// pelo barrel de tools (`toToolFunctionSchemas`, em `./tools/index.js`).
export {
  NativeToolsCapability,
  type NativeToolsCapabilityOptions,
  type NativeToolsRequestFields,
} from './native-tools.js';
// EST-0969 (anti-runaway) — guarda de LOOP DEGENERADO (repetição no stream do
// modelo): detector portável + sink p/ os acumuladores de stream + config `ALUY_*`.
// COMPLEMENTA o heartbeat (#67, que não pega "vivo mas repetindo") e o budget.
export {
  DegenerationDetector,
  DegenerateLoopError,
  newDegenerationSink,
  detectShortCycle,
  resolveDegenerationConfig,
  isDegenerationGuardEnabled,
  DEFAULT_DEGENERATION_CONFIG,
  DEFAULT_MAX_CONSECUTIVE_LINE_REPEATS,
  DEFAULT_MAX_CYCLE_LEN,
  DEFAULT_MIN_CYCLE_SPAN_CHARS,
  DEFAULT_TRIVIAL_LINE_MAX_LEN,
  DEGENERATION_MAX_LINE_REPEATS_ENV,
  DEGENERATION_MIN_CYCLE_SPAN_ENV,
  DEGENERATION_DISABLE_ENV,
  type DegenerationConfig,
  type DegenerationKind,
  type DegenerationSink,
} from './degeneration.js';
// EST-1010 (BUG-0020) — TETO de BYTES por turno de stream (anti-OOM client-side).
// COMPLEMENTA a guarda de degeneração: aquela pega o LOOP repetitivo; este pega o
// stream GIGANTE NÃO-repetitivo (broker bugado / `done` que nunca chega) sem corte.
export {
  StreamByteCap,
  newStreamByteCap,
  DEFAULT_MAX_STREAM_BYTES,
  STREAM_MAX_BYTES_ENV,
  STREAM_CAP_DISABLE_ENV,
  STREAM_CAP_FINISH_REASON,
} from './stream-cap.js';
// EST-0969 (watchdog de TRAVAMENTO · pausa-pede-direção) — detector portável de "o
// agente gira sem ir a lugar nenhum" (mesma tool/erro/turno-vazio/sem-progresso) que
// vira um PEDIDO DE DIREÇÃO acionável ao humano, em vez de matar seco. COMPLEMENTA o
// degenerado (stream), o heartbeat (#67) e o teto. SÓ pausa+ask — catraca intocada.
export {
  StuckWatchdog,
  newStuckWatchdog,
  resolveWatchdogConfig,
  isWatchdogEnabled,
  DEFAULT_WATCHDOG_CONFIG,
  DEFAULT_MAX_SAME_TOOL_CALL,
  DEFAULT_MAX_SAME_TOOL_ERROR,
  DEFAULT_MAX_EMPTY_TURNS,
  DEFAULT_MAX_STALE_ITERATIONS,
  WATCHDOG_SAME_TOOL_CALL_ENV,
  WATCHDOG_SAME_TOOL_ERROR_ENV,
  WATCHDOG_EMPTY_TURNS_ENV,
  WATCHDOG_STALE_ITERATIONS_ENV,
  WATCHDOG_DISABLE_ENV,
  type WatchdogConfig,
  type StuckKind,
  type StuckAlert,
  type StuckResolution,
  type StuckResolver,
} from './stuck-watchdog.js';
export * from './tools/index.js';

// EST-0969 · ADR-0057 (E-A1/E-A2/E-A3) · CLI-SEC-11 — SUB-AGENTES LOCAIS PARALELOS.
// Orçamento agregado ATÔMICO (SharedBudget, E-A2) + orquestrador do fan-out
// paralelo (SubAgentSpawner: engine derivada do pai com grants próprios + teto de
// profundidade ≤1, budget compartilhado, ask rotulado por origem, timeout duro).
// PORTÁVEL: mecânica/budget/orquestração aqui; a UI dos filhos rodando é do @hiperplano/aluy-cli.
export { SharedBudget } from './shared-budget.js';
export {
  SubAgentSpawner,
  childEngineOf,
  childCallerFor,
  resolveIdleTimeoutMs,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  SUBAGENT_IDLE_TIMEOUT_ENV,
  MAX_SUBAGENTS_PER_CALL,
  ROOM_ART_PATTERN_DEFAULT,
  DEBATE_ROUND_CAP_ABSOLUTE,
  DEBATE_ROUND_CAP_DEFAULT,
  formatRoomArtSystemNote,
  type SubAgentProfile,
  type SubAgentOutcome,
  type SubAgentObserver,
  type SubAgentSpawnerOptions,
  type RoomArtPattern,
} from './subagent.js';

// EST-1098 · ADR-0109 (WT-1) — seam de ISOLAMENTO por worktree de sub-agentes. O
// CONTRATO (WorktreePort/WorktreeHandle) + o resolvedor PURO (resolveChildWorktree);
// o concreto (NodeWorktreePort) vive no @hiperplano/aluy-cli. PORTÁVEL (só tipos + função pura).
export {
  resolveChildWorktree,
  type WorktreePort,
  type WorktreeHandle,
  type ChildIsolation,
} from './worktree-port.js';

// EST-0982 · ADR-0063 (VER/PARAR/INTERAGIR) · GS-C1..C5 + RES-C-1/2/3 — CONTROLE e
// OBSERVABILIDADE da árvore de fluxos (pai · sub-agentes · — futuro — ciclos /loop):
//   • FlowTree/FlowNode — a árvore navegável: identidade (rótulo de origem, CLI-SEC-9),
//     fase, atividade REDIGIDA (RES-C-1/CLI-SEC-6), contabilidade (tokens+TEMPO) e o
//     AbortController por nó (PARAR seguro — GS-C1 — com semântica de subárvore sem
//     deadlock — RES-C-3/GS-C2).
//   • ControlAudit — trilha `actor_type=cli` dos verbos de controle (CLI-SEC-10).
//   • injectedInputItem — INTERAGIR: input = conteúdo do usuário pela MESMA catraca,
//     sem ampliar escopo nem relaxar sempre-ask (GS-C5/RES-C-2).
// PORTÁVEL: mecânica/estado/relógio aqui; o drill-in/UI/contabilidade-visível é do @hiperplano/aluy-cli.
export {
  FlowTree,
  FlowNode,
  type FlowKind,
  type FlowPhase,
  type FlowStop,
  type FlowAccounting,
  type FlowActivity,
  type ToolEndDetail,
  type FlowDrillIn,
  type FlowSummary,
  type Clock as FlowClock,
} from './flow-tree.js';
export {
  ControlAudit,
  type ControlActorType,
  type ControlVerb,
  type ControlAuditEvent,
  type AuditClock,
} from './control-audit.js';
export { injectedInputItem, INJECTED_INPUT_LABEL } from './input-injection.js';

// EST-0977/0978 · ADR-0061 · CLI-SEC-11 (reaplicado) — AGENTES definidos em `.md`:
// parser PURO do perfil (frontmatter name/description/tools/model + corpo=system
// prompt; FALHA FECHADA RES-MD-3), o registro nomeado (precedência projeto>global,
// anti-spoofing cross-camada RES-MD-1, auto-seleção SÓ-globais R-S3-3/RES-MD-2) e o
// binding do `spawn_agent` ao nome (GS-MD7). A leitura confinada dos diretórios de
// agentes é do locus concreto (@hiperplano/aluy-cli, io/). O `tools:` vira `toolScope` ⊆ pai na
// catraca (GS-MD1, no PolicyPermissionEngine); o `model` vira tier pelo broker (GS-MD4).
export {
  parseAgentProfile,
  isAgentProfileError,
  normalizeAgentName,
  normalizeToolName,
  type AgentProfile,
  type AgentProfileError,
  type AgentProfileParse,
  type AgentOrigin,
} from './agent-profile.js';
export {
  AgentRegistry,
  bindNamedAgent,
  type AgentResolution,
  type CrossLayerNameConflict,
  type NamedAgentBinding,
} from './agent-registry.js';
// EST-0977 · ADR-0061 — `/agents` + `aluy agents`: FORMATADOR PURO que lista os perfis
// `.md` mapeados (válidos ✓ + rejeitados ⚠ com o motivo RES-MD-3). Reusa o resultado dos
// MESMOS loaders do boot/`/doctor`; não re-parseia nem lê o filesystem. Read-only.
export {
  buildAgentsNote,
  agentOriginLabel,
  agentPersonaLine,
  agentToolsLine,
  type AgentsListNote,
  type AgentsListInput,
} from './agents-list.js';
export { resolveModelTier, ALUY_TIER_KEYS, type AluyTierKey } from './agent-model-tier.js';
// EST-1112 · ADR-0116 (proposto) — SKILLS definidas em `SKILL.md` (capacidade invocável
// empacotada num diretório). Parser PURO do manifesto (frontmatter name/description +
// corpo = instruções; FALHA FECHADA RES-MD-3) + o FORMATADOR PURO que lista as skills
// mapeadas (válidas ✓ + rejeitadas ⚠). A leitura confinada dos diretórios de skills é
// do locus concreto (@hiperplano/aluy-cli, io/).
export {
  parseSkill,
  isSkillError,
  normalizeSkillName,
  type Skill,
  type SkillError,
  type SkillParse,
  type SkillOrigin,
} from './skill.js';
export {
  buildSkillsNote,
  skillOriginLabel,
  skillDescriptionLine,
  type SkillsListNote,
  type SkillsListInput,
} from './skills-list.js';
// EST-1109 — NOTA de agentes DISPONÍVEIS no contexto do modelo (system).
export { buildAvailableAgentsNote, AVAILABLE_AGENTS_HEADER } from './available-agents-note.js';

// EST-1105 · ADR-workflows — WORKFLOWS definidos em `.md`: parser PURO do
// workflow (frontmatter name/description + corpo com atividades numeradas;
// FALHA FECHADA RES-MD-3) e o FORMATADOR PURO que lista os workflows mapeados
// (válidos ✓ + rejeitados ⚠). A leitura confinada dos diretórios de workflows
// é do locus concreto (@hiperplano/aluy-cli, io/).
export {
  parseWorkflow,
  isWorkflowError,
  type WorkflowDef,
  type WorkflowError,
  type WorkflowActivity,
  type WorkflowOrigin,
} from './workflow/workflow-parse.js';
export {
  buildWorkflowsNote,
  workflowOriginLabel,
  workflowDescriptionLine,
  type WorkflowsListNote,
  type WorkflowsListInput,
} from './workflow/workflows-list.js';
// EST-1106 · ADR-workflows — MOTOR do /workflows run (orquestração PURA).
export {
  runWorkflow,
  type WorkflowActivityRunner,
  type WorkflowActivityOutcome,
  type WorkflowRunResult,
} from './workflow/workflow-runner.js';

// EST-0958 · CLI-SEC-3/4/9 — `!comando` (atalho de shell do composer): executor
// que reusa a MESMA catraca (`decide`) + shell confinado (ToolPorts) do agente.
// NÃO é um bypass — é o mesmo tool-call `run_command` atrás do mesmo ponto único.
export {
  BangExecutor,
  blockedObservation,
  BANG_TOOL_NAME,
  BANG_SOURCE_LABEL,
  type BangExecutorOptions,
  type BangOutcome,
} from './bang.js';

// EST-0974 · ADR-0053 §2.2 — COMANDOS CUSTOMIZADOS do usuário (`~/.aluy/commands/
// *.md`): parser PURO do template + expansão com args. O resultado é um OBJETIVO
// submetido pelo usuário (não bypassa a catraca). A leitura confinada (0700) é do
// locus concreto (@hiperplano/aluy-cli).
export {
  parseUserCommand,
  expandUserCommand,
  normalizeCommandName,
  splitFrontmatter,
  type UserCommand,
  type UserCommandMeta,
} from './user-command.js';

// EST-0974 · ADR-0053 §2.2 / CLI-SEC-3 — HOOKS de ciclo-de-vida. Config PURA
// (tipos + parser de `~/.aluy/hooks.json`) + o `HookRunner`, que executa o comando
// do hook ATRÁS da MESMA catraca (`decide`) e shell confinado do agente — NÃO é um
// caminho de shell paralelo. Plan nega hooks de efeito por construção.
export {
  parseHooksConfig,
  parseClaudeHooksSettings,
  mergeHooksConfigs,
  selectHooks,
  selectGateHooks,
  EMPTY_HOOKS_CONFIG,
  HOOK_EVENTS,
  CLAUDE_EVENT_MAP,
  type Hook,
  type HookEvent,
  type HooksConfig,
} from './hook-config.js';
export {
  HookRunner,
  blockedHookObservation,
  HOOK_TOOL_NAME,
  HOOK_SOURCE_LABEL,
  type HookRunnerOptions,
  type HookOutcomeResult,
  type HookGateVerdict,
} from './hook-runner.js';

// EST-0981 · ADR-0062 (APR-0067) · CLI-SEC-14 (GS-L1..L8 · RES-L-1/2/3/4) — `/cycle`
// (autonomia REPETIDA): scheduler de re-disparo + paradas DURAS (duração/iterações/
// budget AGREGADO atômico/conclusão) + anti-loop-vazio + parável por abort + os DOIS
// ritmos (fixo + auto-pace). MECÂNICA PORTÁVEL; o comando `/cycle` + a UI do laço vivo
// são do @hiperplano/aluy-cli. Reusa SharedBudget/E-A2, AbortSignal/freio (EST-0948/0982) e o
// AgentLoop por-ciclo (via CycleRunner) — não reinventa nada.
export {
  CycleEngine,
  parseCycleInput,
  parseDuration,
  resolveCycleCeilings,
  aggregateLimitsOf,
  CycleParseError,
  NoCeilingError,
  DEFAULT_STALL_TOLERANCE,
  MAX_CYCLE_DURATION_MS,
  MAX_CYCLE_ITERATIONS,
  DEFAULT_CYCLE_DURATION_MS,
  DEFAULT_CYCLE_ITERATIONS,
  DEFAULT_CYCLE_INTERVAL_MS,
  type CycleEngineOptions,
  type CycleRunner,
  type CycleOutcome,
  type CycleObserver,
  type CycleRunResult,
  type CycleStop,
  type CycleCeilings,
  type CycleRequest,
  type CycleRhythm,
  type ParsedCycleInput,
  type AbortableSleep,
} from './cycle/index.js';

// EST-0983 · ADR-0064 · CLI-SEC-15 — MEMÓRIA de agente: tool `remember` (porta de
// I/O PRÓPRIA, confinada a `memory/` — NÃO carve-out do `edit_file`), recall COMO
// DADO envelopado (anti-laundering, B/GS-M3 — nunca `system`), proveniência +
// heurística de diretiva (GS-M5), teto por sessão (GS-M2, na engine). O I/O concreto
// (`~/.aluy/memory/` 0600/0700 + `.aluy/memory/` do workspace) é do @hiperplano/aluy-cli.
export * from './memory/index.js';

// EST-1108 — BACKLOG/TODO persistente: tools add_todo/list_todos/done_todo (porta
// de I/O PRÓPRIA, confinada a `todos.json`). O I/O concreto (`~/.aluy/todos.json`
// 0600, fail-safe) é do @hiperplano/aluy-cli.
export * from './todo/index.js';

// EST-0999 · ADR-0078 — SALAS MULTI-AGENTE (INVARIANTE #1): mensagem entre agentes
// = DADO, nunca instrução. O envelope `<<<DADO_NAO_CONFIAVEL origem=...>>>` garante
// que o agente B pondera o conteúdo, nunca o obedece como comando/system.
export * from './rooms/index.js';

// EST-0960a · ADR-0056 — journal de snapshot-do-antes (mecanismo PORTÁVEL +
// portas de I/O concreto injetáveis). A captura/pilha/restauração que a 0960b
// (`/undo`/`/redo`) consome.
export * from './journal/index.js';

// EST-XXXX — CHECKPOINTS / REWIND (`/rewind` + Esc-Esc). Um ponto de restauração
// por PROMPT do usuário; orquestra o journal de snapshot p/ reverter código e
// expõe a fronteira da conversa (blockCount) que o @hiperplano/aluy-cli usa p/ truncar.
export * from './checkpoint/index.js';

// EST-0971 · CLI-SEC-13 — tools de WEB (web_fetch/web_search) + anti-SSRF PORTÁVEL.
// A lógica de segurança (resolve→valida→pina, denylist dura de IP, parser DDG) é
// dado/string puro; a rede concreta é a `WebPort` injetada pelo @hiperplano/aluy-cli.
export * from './web/index.js';

// ADR-0112 · EST-RT-1 — parser de testes + acumulador (4 dialetos: vitest/jest/pytest/go-test).
// PURO (sem `node:*`) — exportado p/ os testes e p/ a tool `run_tests`.
export * from './testing/test-parse.js';
// EST-0973 — compactação de contexto (`/compact`): resume os turnos antigos da
// conversa num sumário denso (via broker, CLI-SEC-7) e CONTINUA a sessão com a
// janela liberada. Seleção/aplicação PURAS; o sumário re-entra como `observation`
// (DADO_NAO_CONFIAVEL, CLI-SEC-4 — nunca elevado a instrução).
export {
  Compactor,
  NothingToCompactError,
  applyCompaction,
  compactDeterministic,
  selectForCompaction,
  sizeAwareKeepRecent,
  isCompactable,
  buildSummaryMessages,
  renderHistoryForSummary,
  summaryObservation,
  COMPACTION_TOOL_NAME,
  SUMMARY_SYSTEM_PROMPT,
  DEFAULT_KEEP_RECENT,
  DEFAULT_KEEP_RECENT_WINDOW_FRACTION,
  DEFAULT_SUMMARY_MAX_TOKENS,
  type CompactorOptions,
  type CompactionResult,
  type CompactionSelection,
  type CompactionStats,
} from './compact.js';
export { buildRoomTools, type RoomToolsDeps } from './rooms/room-tools.js';

// MAESTRO (ADR-0123) — raiz da família, PORTÁVEL: tipos/estado puros, sem I/O (ADR-0053 §8).
// EST-1122: contrato SupervisorSignal/SupervisorDecision + barramento de coleta (v1=poll);
// o regente (EST-1123) e o motor (EST-1127) consomem este contrato.
// EST-1125 (§4): esqueleto do grafo de caixas de contexto (ContextGraph) — fundação.
// EST-1128: portas MemoryEngine + JudgeEngine (interfaces puras, ZERO impl/I-O/sidecar).
export * from './maestro/index.js';
