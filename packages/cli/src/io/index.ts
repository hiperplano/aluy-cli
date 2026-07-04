// EST-0948 — barrel do I/O concreto do @hiperplano/aluy-cli (o "locus concreto" da 0944/45).
// Liga as portas PORTÁVEIS do core (FileSystemPort/ShellPort/SearchPort) ao fs/
// child_process reais, SEMPRE atrás do confinamento de workspace + egress
// allowlist (cravas do seguranca). É aqui que mora o I/O — nunca no core.
export { NodeWorkspace, WorkspaceEscapeError, AddRootError } from './workspace.js';
export type { WorkspacePort, NodeWorkspaceOptions } from './workspace.js';
export { NodeFileSystemPort } from './fs-port.js';
export type { NodeFileSystemPortOptions } from './fs-port.js';
// EST-1010 · ANTI-OOM — leitura confinada por TETO de bytes ANTES de materializar
// (stat-then-partial; nunca aloca o arquivo inteiro). Consumida pelo FS-port
// (read_file) e pelo Search-port (grep). Mesma classe do `web_fetch → "Killed"`.
export { readBounded } from './read-bounded.js';
export type { BoundedRead } from './read-bounded.js';
export { NodeShellPort, DEFAULT_EXEC_TIMEOUT_MS } from './shell-port.js';
export type { NodeShellPortOptions } from './shell-port.js';
export { NodeSearchPort } from './search-port.js';
export type { NodeSearchPortOptions } from './search-port.js';
export { NodeFileIndexPort } from './file-index.js';
export type { FileIndexPort, NodeFileIndexPortOptions } from './file-index.js';
export { EgressAllowlist, networkTargetOf, DDG_SEARCH_HOSTS } from './egress.js';
export type { EgressInspection, EgressAllowlistOptions } from './egress.js';
// EST-0971 · CLI-SEC-13 — WebPort concreta: resolver DNS (todos os IPs) + fetcher
// PINADO (conecta ao IP validado, sem re-resolver) + guarda de egress. O I/O de
// rede (node:dns/http(s)) mora AQUI — nunca no core.
export {
  NodeHostResolver,
  NodePinnedFetcher,
  EgressAllowlistGuard,
  createWebPort,
} from './web-port.js';
export type { NodePinnedFetcherOptions } from './web-port.js';
// EST-0960a · ADR-0056 — journal de snapshot (I/O concreto: store + restauração).
export { NodeJournalStore } from './journal-store.js';
export type { NodeJournalStoreOptions } from './journal-store.js';

// EST-0983 · ADR-0064 · CLI-SEC-15 — I/O concreto da MEMÓRIA de agente (global
// `~/.aluy/memory/` 0600/0700 + projeto `<workspace>/.aluy/memory/`). Porta ESTREITA
// (append/remove/update por escopo — nunca write(path)); read/write-deny do agente.
export { NodeMemoryStore, MEMORY_DIRNAME } from './memory-store.js';
export type { NodeMemoryStoreOptions } from './memory-store.js';

// EST-1132 · ADR-0123 §2.2/Inv. II — cliente concreto MemoryEngine → Mem0 OSS
// local via HTTP loopback. scope ↔ user_id (CAIXA). Degradação fail-open (CA-MA8).
export { Mem0MemoryEngine } from './mem0-memory-engine.js';
export type { Mem0MemoryEngineOptions } from './mem0-memory-engine.js';

// EST-1108 — store concreto do backlog/TODO (~/.aluy/todos.json).
export { NodeTodoStore } from './todo-store.js';
export type { NodeTodoStoreOptions } from './todo-store.js';
export { NodeRestoreWriter, NodeCurrentReader } from './journal-restore.js';
export type { NodeRestoreWriterOptions } from './journal-restore.js';
// EST-0963 — porta de notificação (BEL/OSC9) + config do env. IO de terminal puro.
export {
  TerminalNotificationPort,
  NO_OP_NOTIFICATION_PORT,
  NOTIFY_LABELS,
  loadNotifyConfig,
} from './notify-port.js';
export type {
  NotificationPort,
  NotifyReason,
  NotifyConfig,
  TerminalNotificationPortOptions,
} from './notify-port.js';
// EST-0964 — leitor confinado do AGENT.md (instruções de PROJETO, config confiável
// do dono do repo). Lido no startup; injetado no canal `system` pelo loop. Distinto
// do `@arquivo` (DADO ingerido, não-confiável) — ver agent-md.ts.
// EST-0979 — `loadProjectInstructions`: amplia as FONTES (AGENT.md + AGENTS.md +
// CLAUDE.md) com precedência cravada e composição; mesma injeção confiável.
export {
  loadAgentMd,
  loadProjectInstructions,
  AGENT_MD_FILENAME,
  PROJECT_INSTRUCTION_FILENAMES,
} from './agent-md.js';
export type { LoadAgentMdOptions, ProjectInstructionsLoad } from './agent-md.js';
// EST-0969 — config persistente de PREFERÊNCIAS de UI (tema/tier) em
// `~/.aluy/config.json` (`0600`). FORA do workspace; só UI/tier, nunca credencial
// (CLI-SEC-7). Leitura fail-safe (defaults), escrita atômica. Precedência:
// flag CLI > config salva > default (resolveInitialTier/configuredTheme, puros).
export {
  UserConfigStore,
  CONFIG_FILENAME,
  resolveInitialTier,
  configuredTheme,
  resolveInitialSplitView,
  resolveInitialFullscreen,
} from './user-config.js';
export type { UserConfig, UserConfigStoreOptions } from './user-config.js';
// EST-1000 · ADR-0076 §4 — store do `/export` (transcript redigido em ~/.aluy/exports/).
export { ExportStore, writeExport, EXPORTS_DIRNAME } from './export-store.js';
export type { ExportStoreOptions, ExportResult } from './export-store.js';
// EST-0972 — persistência de SESSÃO (salvar/retomar — `--continue`/`--resume`) em
// `~/.aluy/sessions/<id>.json` (`0600`, dir `0700`, escrita atômica). FORA do
// workspace; transcrição (blocos) + tier, NUNCA credencial (CLI-SEC-7). Leitura
// fail-safe (corrompido ⇒ nova), GC por idade/teto. `~/.aluy/` fora da path-deny do
// agente como o journal/undo.
export {
  SessionStore,
  SESSIONS_DIRNAME,
  SESSION_RECORD_VERSION,
  hasAnySession,
  // ADR-0150 (balde b) — resolve `session.gcMaxAgeMs`/`gcMaxCount` do config único.
  resolveSessionGcOptions,
  MIN_GC_MAX_AGE_MS,
  MIN_GC_MAX_COUNT,
  DEFAULT_GC_MAX_AGE_MS,
  DEFAULT_GC_MAX_COUNT,
} from './session-store.js';
export type {
  SessionRecord,
  SessionSummary,
  SessionStoreOptions,
  SessionGcOptions,
} from './session-store.js';
export { sanitizeBlocks, sanitizeBlock, blocksToHistory } from './session-record.js';
// EST-0974 · ADR-0053 §2.2 — LOADER confinado dos comandos customizados do usuário
// (`~/.aluy/commands/*.md`, dir `0700`). Lê o DADO; o parser/expansão são puros no
// core. O resultado é um OBJETIVO submetido pelo usuário (passa pela catraca normal).
export { UserCommandsLoader, COMMANDS_DIRNAME } from './user-commands.js';
export type { UserCommandsLoaderOptions } from './user-commands.js';
// EST-0979 — LOADER confinado dos comandos do PROJETO (`.claude/commands/*.md`, padrão
// Claude Code, no workspace) + `mergeUserCommands` (projeto > global). Mesmo mecanismo
// (.md → /comando) da EST-0974; config de projeto = DADO confinado, não relaxa catraca.
export {
  ProjectCommandsLoader,
  PROJECT_COMMANDS_DIRNAMES,
  mergeUserCommands,
} from './project-commands.js';
export type { ProjectCommandsLoaderOptions } from './project-commands.js';
// EST-0977 · ADR-0061 · CLI-SEC-11 (reaplicado) — LOADERS confinados dos agentes-`.md`:
// GLOBAL (`~/.aluy/agents/*.md`, dono=confiável → origin='global', entra na auto-
// seleção) e PROJETO (`.claude/agents/*.md` + `.aluy/agents/*.md` no workspace, DADO →
// origin='project', FORA da auto-seleção). `tools:` ⊆ pai (GS-MD1); malformado = falha
// fechada (RES-MD-3, coletada em `errors`). O registro/precedência/anti-spoofing vive
// no core (AgentRegistry); aqui é só a LEITURA confinada (mesma disciplina dos commands).
export { UserAgentsLoader, AGENTS_DIRNAME } from './user-agents.js';
export type { UserAgentsLoaderOptions, AgentLoadResult } from './user-agents.js';
export { ProjectAgentsLoader, PROJECT_AGENTS_DIRNAMES } from './project-agents.js';
export type { ProjectAgentsLoaderOptions } from './project-agents.js';
// EST-1105 · ADR-workflows — LOADERS confinados dos workflows-`.md`:
// GLOBAL (`~/.aluy/workflows/*.md`, dono=confiável → origin='global') e
// PROJETO (`.aluy/workflows/*.md` no workspace, DADO → origin='project').
// Malformado = falha fechada (RES-MD-3, coletada em `errors`).
export { UserWorkflowsLoader, WORKFLOWS_DIRNAME } from './user-workflows.js';
export type { UserWorkflowsLoaderOptions, WorkflowLoadResult } from './user-workflows.js';
export { ProjectWorkflowsLoader, PROJECT_WORKFLOWS_DIRNAMES } from './project-workflows.js';
export type { ProjectWorkflowsLoaderOptions } from './project-workflows.js';
// EST-1112 · ADR-0116 (proposto) · CLI-SEC-11 (reaplicado) — LOADERS confinados das
// SKILLS (`<nome>/SKILL.md`, unidade = DIRETÓRIO por skill): GLOBAL (`~/.aluy/skills/`,
// dono=confiável → origin='global') e PROJETO (`.claude/skills/` + `.aluy/skills/` no
// workspace, DADO → origin='project'). Uma skill só INJETA INSTRUÇÕES — não relaxa a
// catraca (instruções seguem sob `decide()`); malformada = falha fechada (RES-MD-3,
// coletada em `errors`). O parser/formatador são puros no core.
export { UserSkillsLoader, SKILLS_DIRNAME, SKILL_MANIFEST } from './user-skills.js';
export type { UserSkillsLoaderOptions, SkillLoadResult } from './user-skills.js';
export { ProjectSkillsLoader, PROJECT_SKILLS_DIRNAMES } from './project-skills.js';
export type { ProjectSkillsLoaderOptions } from './project-skills.js';
// EST-0974 · ADR-0053 §2.2 / CLI-SEC-3 — LEITOR confinado de `~/.aluy/hooks.json`
// (config de hooks de ciclo-de-vida). SÓ-LEITURA: a catraca NEGA que o agente escreva
// `~/.aluy/` (aluy-config-write-deny). O `HookRunner` (core) executa atrás da catraca.
export { HooksConfigStore, HOOKS_CONFIG_FILENAME } from './hooks-config-store.js';
export type { HooksConfigStoreOptions } from './hooks-config-store.js';
