// MAESTRO — barrel do módulo (ADR-0123 §3.1). Raiz da família Maestro.
// PORTÁVEL: tipos/estado puros, sem I/O (ADR-0053 §8).
// EST-1122: contrato SupervisorSignal/SupervisorDecision + barramento de coleta.
// EST-1125: esqueleto do grafo de caixas de contexto (ContextGraph), a fundação.
// EST-1127: motor heurístico camada (a) — SEM LLM, sempre-disponível (CA-MA8).
//   Precedência de guarda (Inv. I), salience por sinais (recência/frequência/pin),
//   roteamento por regra. Puro, local, determinístico, offline-first.
// EST-1128: portas `MemoryEngine` + `JudgeEngine` — interfaces puras, ZERO impl,
//   ZERO I/O, ZERO sidecar, ZERO credencial (CLI-SEC-7); impl concreta no `@aluy/cli`.
//   `MemoryEngine` acomoda ingestão de documentos (§4-bis, RAG-como-modo);
//   `JudgeEngine` plugável (Ollama/llama.cpp OU provider). Saída = DADO envelopado (CLI-SEC-15-B).
export * from './contract.js';
export * from './bus.js';
export * from './regent.js';
export * from './emitters.js';
export * from './motor-a.js';
export * from './context-box-graph.js';

export {
  type MemoryEngine,
  type MemoryContent,
  type MemoryAddInput,
  type MemoryAddResult,
  type MemorySearchInput,
  type MemorySearchHit,
  type MemorySearchResult,
  type MemoryScopeOp,
  type MemoryScopeInput,
  type MemoryScopeInfo,
  type MemoryScopeResult,
} from './memory-engine.js';

export {
  type JudgeEngine,
  type JudgeOption,
  type JudgeInput,
  type JudgeReason,
  type JudgeResult,
} from './judge-engine.js';

export {
  type AgentProfileTier,
  type SidecarTarget,
  type PinnedArtifact,
  type ProvisionStatus,
  type ProvisionTargetResult,
  type ProvisionResult,
  type SidecarProvisioner,
  OLLAMA_VERSION,
  OLLAMA_RELEASE_TAG,
  OLLAMA_BINARY_SHA256,
  OLLAMA_BINARY_URL,
  OLLAMA_ASSET_NAME,
  JUDGE_MODEL,
  EMBEDDER_MODEL,
  QWEN_JUDGE_MODEL_DIGEST,
  NOMIC_EMBEDDER_MODEL_DIGEST,
  OLLAMA_PULL_TIMEOUT_MS,
  OLLAMA_LOOPBACK_PORT,
  OLLAMA_LOOPBACK_HOST,
  OLLAMA_BASE_URL,
  OLLAMA_INSTALL_DIR,
  MEM0_VENV_DIR,
  MEM0_MIN_PYTHON,
  MEM0_PIP_PACKAGES,
  HEADROOM_VENV_DIR,
  HEADROOM_PIP_PACKAGES,
  HEADROOM_LOOPBACK_PORT,
  verifySha256,
  isRoot,
  shouldProvision,
  resolveSidecarToggles,
} from './provisioner-contract.js';

export {
  type SidecarKind,
  type SidecarConfig,
  type SidecarState,
  type BootResult,
  type BootSupervisor,
  HEADROOM_PORT,
  OLLAMA_PORT,
  MEM0_PORT,
  SIDECAR_HANDSHAKE_TIMEOUT_MS,
  SIDECAR_POLL_INTERVAL_MS,
  SIDECAR_POLL_MAX_ATTEMPTS,
  resolveSidecarPaths,
  targetsToKinds,
} from './boot-contract.js';
