// EST-0981 · ADR-0062 (APR-0067) · CLI-SEC-14 — barrel de `/cycle` (autonomia
// REPETIDA). A MECÂNICA (scheduler de re-disparo · contadores duração/iterações ·
// portão do budget AGREGADO atômico · anti-loop-vazio · parável por abort) vive no
// `@aluy/cli-core` (portável — ADR-0053 §8); o comando `/cycle` + a UI do laço vivo
// (ciclo N, parar) são do `@aluy/cli`, que CONSOME isto.
//
// Reuso (não reinventa): SharedBudget/E-A2 (EST-0969) p/ o budget agregado atômico;
// AbortSignal/freio (EST-0948/0982) p/ a parada; AgentLoop (EST-0944) por-ciclo via
// o `CycleRunner`; precedência Plan da `decide()` (ADR-0055) herdada por-ciclo.
export {
  parseCycleInput,
  parseDuration,
  CycleParseError,
  type ParsedCycleInput,
} from './cycle-parse.js';
export {
  resolveCycleCeilings,
  aggregateLimitsOf,
  NoCeilingError,
  MAX_CYCLE_DURATION_MS,
  MAX_CYCLE_ITERATIONS,
  DEFAULT_CYCLE_DURATION_MS,
  DEFAULT_CYCLE_ITERATIONS,
  DEFAULT_CYCLE_INTERVAL_MS,
  type CycleCeilings,
  type CycleRequest,
  type CycleRhythm,
} from './cycle-limits.js';
export {
  CycleEngine,
  DEFAULT_STALL_TOLERANCE,
  type CycleEngineOptions,
  type CycleRunner,
  type CycleOutcome,
  type CycleObserver,
  type CycleRunResult,
  type CycleStop,
  type Clock as CycleClock,
  type AbortableSleep,
} from './cycle-engine.js';
