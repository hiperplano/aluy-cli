// EST-1122 · ADR-0123 §2.1 · MAESTRO-BUS —
// Contrato SupervisorSignal / SupervisorDecision: a raiz da família Maestro.
//
// O `Maestro` é o Motor de Articulação que rege o loop agêntico, os sub-agentes,
// a recuperação de contexto e a articulação multi-agente sob UM contrato coerente.
// Ele recebe SINAIS (das guardas, do orçamento de contexto, dos fluxos) e emite
// DECISÕES DE REGÊNCIA. Esta estória entrega SÓ OS TIPOS + barramento de coleta;
// o regente (EST-1123) e o motor (EST-1127) consomem este contrato.
//
// PORTÁVEL (ADR-0053 §8): SEM Ink, SEM I/O de terminal. Tipos puros, sem nenhum
// import de node:fs, node:net, child_process direta ou transitivamente.
//
// INVARIANTES do contrato (ADR-0123 §2.1):
//   1. Ponto único de decisão de turno — sinais convergem aqui.
//   2. Rastreabilidade — toda decisão carrega os sinais que a geraram + razão.
//   3. Determinismo de tipo — mesma entrada de sinais ⇒ tipo de decisão estável.

// ─── Guardas (origens de sinal) ───────────────────────────────────────────────
//
// As 5 guardas + budget + cancelamento humano (Q-MA1: topo absoluto).
// Cada guarda vira EMISSORA na EST-1124; aqui definimos SÓ a identidade.

/** Origem de um `SupervisorSignal`: qual guarda/fluxo o emitiu. */
export type SignalOrigin =
  | 'degeneration' // guarda de degeneração de resposta
  | 'stuck' // guarda de stuck (loop preso)
  | 'mem-pressure' // guarda de pressão de memória/contexto
  | 'self-check' // guarda de auto-verificação
  | 'weak-yolo' // guarda weak-yolo (decisão de tool sem modelo)
  | 'budget' // guarda de orçamento (tokens/custo)
  | 'human-cancel'; // cancelamento humano (Q-MA1 — topo absoluto)

/** Severidade de um sinal: da mais branda à mais crítica. */
export type SignalSeverity = 'info' | 'warning' | 'critical';

// ─── SupervisorSignal — o DADO de entrada ─────────────────────────────────────

/**
 * Um sinal emitido por uma guarda/fluxo ao `Maestro`.
 *
 * É DADO puro — o `Maestro` o INTERPRETA, NUNCA obedece cegamente.
 * O `payload` é opaco para o contrato: cada guarda define seu formato,
 * mas SEMPRE é tratado como DADO (nunca como instrução).
 */
export interface SupervisorSignal {
  /** QUAL guarda/fluxo emitiu este sinal (rastro de origem — CLI-SEC-9). */
  readonly origin: SignalOrigin;

  /** Gravidade do sinal. */
  readonly severity: SignalSeverity;

  /** Timestamp de emissão (ms epoch — relógio injetável). */
  readonly ts: number;

  /**
   * Payload de contexto como DADO.
   *
   * Cada guarda define seu formato (ex.: `{ pressurePct: 87 }` para
   * mem-pressure, `{ reason: 'user-ctrl-c' }` para human-cancel).
   * O `Maestro` o trata como DADO NÃO-CONFIÁVEL e o interpreta.
   */
  readonly payload: Record<string, unknown>;
}

// ─── SupervisorDecision — a ação de regência ──────────────────────────────────

/** Ação de regência consolidada que o `Maestro` emite (ADR-0123 §2.1). */
export type DecisionAction =
  | 'continuar' // segue o turno normalmente
  | 'pausar' // pausa o loop (ex.: aguardando confirmação)
  | 'recuperar' // recupera contexto (compactar, headroom-retrieve, resume)
  | 'delegar' // delega para sub-agente
  | 'convergir' // converge resultados de sub-agentes
  | 'parar'; // para o loop (fim ou erro irrecuperável)

/**
 * Decisão de regência emitida pelo `Maestro`.
 *
 * Carrega RASTRO AUDITÁVEL (CLI-SEC-10): os sinais que a geraram + a razão
 * textual, suficiente para `actor_type=cli` auditar o que o `Maestro` decidiu
 * e por quê.
 */
export interface SupervisorDecision {
  /** Ação consolidada. */
  readonly action: DecisionAction;

  /**
   * Sinais que geraram esta decisão (rastro auditável).
   *
   * Pelo menos 1 sinal; no caso de `continuar` sem incidentes,
   * pode ser um sinal `info` de `self-check` indicando normalidade.
   */
  readonly signals: readonly SupervisorSignal[];

  /**
   * Razão textual da decisão — legível por humano, auditável por
   * `actor_type=cli` (CLI-SEC-10). Explica POR QUE o `Maestro` escolheu
   * esta ação a partir destes sinais.
   */
  readonly reason: string;

  /** Timestamp da decisão (ms epoch — relógio injetável). */
  readonly ts: number;
}

// ─── Funções fábrica puras (determinísticas, sem I/O) ─────────────────────────

/**
 * Cria um `SupervisorSignal` validado.
 *
 * Puramente determinística — mesma entrada ⇒ mesma saída.
 */
export function createSignal(
  origin: SignalOrigin,
  severity: SignalSeverity,
  ts: number,
  payload: Record<string, unknown> = {},
): SupervisorSignal {
  return { origin, severity, ts, payload };
}

/**
 * Cria uma `SupervisorDecision` validada.
 *
 * Puramente determinística — mesma entrada ⇒ mesma saída (Inv. 3).
 * O `reason` NUNCA é vazio: toda decisão tem rastro auditável.
 */
export function createDecision(
  action: DecisionAction,
  signals: readonly SupervisorSignal[],
  reason: string,
  ts: number,
): SupervisorDecision {
  if (signals.length === 0) {
    throw new Error('SupervisorDecision requires at least one signal');
  }
  if (!reason.trim()) {
    throw new Error('SupervisorDecision requires a non-empty reason (CLI-SEC-10)');
  }
  return { action, signals, reason, ts };
}
