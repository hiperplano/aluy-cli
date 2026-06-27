// EST-1009 · ADR-0065 · CLI-SEC-H1 — barrel da FUNDAÇÃO PORTÁVEL do sandbox de SO.
//
// Aqui mora SÓ o que é portável (tipos + lógica pura): a forma da capability, a
// decisão de fail-mode (D-SB-4) e a geração do filtro seccomp (bytes). O LANÇADOR
// concreto (`bwrap`/userns + spawn) vive em `@aluy/cli` (`src/sandbox/`) e consome
// estes contratos. É a fronteira atravessa-loci (ADR-0053 §8/§8-bis): o modelo de
// confinamento viaja junto da catraca no futuro split de locus.
export type {
  SandboxEnv,
  SandboxCapability,
  SandboxAction,
  SandboxDecision,
  SandboxConfinement,
  SandboxResourceLimits,
  SandboxSpawnResult,
  SandboxLauncher,
} from './types.js';
export { floorAvailable, DEFAULT_RESOURCE_LIMITS } from './types.js';
export { resolveFailMode, resolveSandboxEnv, resolveUnsafeNoSandbox } from './fail-mode.js';
export {
  AUDIT_ARCH,
  DENIED_SYSCALL_NAMES,
  seccompArchOf,
  buildSeccompProgram,
  serializeSeccompProgram,
  seccompFilterBytes,
} from './seccomp-policy.js';
export type { SeccompArch } from './seccomp-policy.js';
