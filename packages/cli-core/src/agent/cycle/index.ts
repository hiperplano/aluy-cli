// EST-0981 · ADR-0062 (APR-0067) · CLI-SEC-14 — barrel de `/cycle` (autonomia
// REPETIDA). A MECÂNICA (scheduler de re-disparo · contadores duração/iterações ·
// portão do budget AGREGADO atômico · anti-loop-vazio · parável por abort) vive no
// `@hiperplano/aluy-cli-core` (portável — ADR-0053 §8); o comando `/cycle` + a UI do laço vivo
// (ciclo N, parar) são do `@hiperplano/aluy-cli`, que CONSOME isto.
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
  type CycleConfigDefaults,
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
// ADR-0137 (Fatia 3) — POLÍTICA PURA de continuação de subciclo guiada pelo juiz
// (JudgeEngine). KERNEL: provider-agnóstica, sem I/O, sem ollama. A borda (cli) injeta
// o JudgeResult JÁ CALCULADO e a redação; o CycleEngine segue PURO/ignorante do juiz.
export {
  CYCLE_CONTINUE_OPTION_ID,
  CYCLE_STOP_OPTION_ID,
  CYCLE_JUDGE_OPTIONS,
  CYCLE_JUDGE_QUESTION,
  DEFAULT_JUDGE_REASON_MAX_CHARS,
  buildRedactedSubcycleContext,
  buildSubcycleJudgeInput,
  judgeResultToContinuation,
  clampReasonToLine,
  type SubcycleSummaryInput,
  type SubcycleBox,
  type CycleContinuation,
} from './cycle-judge-policy.js';
