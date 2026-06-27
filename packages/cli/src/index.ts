// @aluy/cli — TUI (Ink) + wiring do binário `aluy`. Consome @aluy/cli-core.
export { CLI_VERSION } from './version.js';
export { parseArgs, versionText, HELP_TEXT, type CliAction } from './cli.js';

// Config do cliente de modelo (EST-0943): resolve `ALUY_BROKER_URL` do env. O
// wiring do BrokerModelClient (loop EST-0944 / TUI EST-0948) parte daqui.
export { loadBrokerConfig, type BrokerConfig } from './model/config.js';

// EST-0948 — TUI: wiring + render da sessão. Liga login+broker+loop+catraca+I/O
// concreto confinado (cravas do seguranca) e renderiza os 11 estados da spec.
export { buildSession, type BuildSessionOptions, type BuiltSession } from './session/wiring.js';
export { runSession, type RunSessionOptions } from './session/run.js';
export { SessionController } from './session/controller.js';

// I/O concreto confinado (CLI-SEC: timeout no exec, cwd preso, confinamento de
// workspace REAL, egress allowlist default-deny).
export * from './io/index.js';

// MCP concreto (EST-0970 · ADR-0058 · CLI-SEC-12): leitura confinada do
// `~/.aluy/mcp.json` + transporte stdio do SDK MCP oficial (environ MÍNIMO, sem a
// credencial do CLI — CLI-SEC-7) + setup (descoberta/handshake/adaptação).
export * from './mcp/index.js';

// AskResolver da TUI (fail-safe deny em timeout/abort; efeito exato).
export { TuiAskResolver } from './ask/ask-resolver.js';
export type { PendingAskEntry, TuiAskResolverOptions } from './ask/ask-resolver.js';

// EST-1118 · ADR-0121 — FileRoomStore: transporte file do RoomStore
// (JSONL append-only em ~/.aluy/rooms/<código>.jsonl).
export { FileRoomStore } from './session/rooms/file-room-store.js';

// Slash-commands (CA-3).
export * from './slash/commands.js';

// EST-1131 · ADR-0123 §2.1-bis — OllamaJudgeEngine: cliente concreto
// JudgeEngine → Ollama loopback (malha anti-SSRF, saída=DADO, degrada).
export {
  OllamaJudgeEngine,
  parseVerdict,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  DEFAULT_OLLAMA_JUDGE_CONFIG,
  type OllamaJudgeConfig,
  type ParsedVerdict,
} from './maestro/ollama-judge.js';

// EST-1129 · ADR-0123 §2.2 — NodeBootSupervisor: boot-supervisor concreto
// que sobe os 3 sidecars (headroom + Mem0 + Ollama) sob travas G2.
// Injeta spawner/resolver/fetcher/fs por construtor.
export {
  NodeBootSupervisor,
  ensureMemoryStoreDir,
  type NodeBootSupervisorOptions,
  type SpawnFn,
  type SpawnOptions,
  type FetchFn,
  type TimerPort,
  type BootFileSystem,
} from './maestro/boot-supervisor.js';
