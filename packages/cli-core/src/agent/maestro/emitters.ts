// EST-1124 · ADR-0123 §2.1-bis · MAESTRO-EMISSORES —
// Emissores de SupervisorSignal para o barramento do Maestro.
//
// As 5 guardas existentes + o budget + o ESC humano passam a EMITIR
// `SupervisorSignal` para o barramento (SignalCollector), mantendo TODOS os
// freios DUROS existentes (a emissão é ADITIVA; nenhum freio é relaxado ou
// removido — CLI-SEC-8/11/14 intactos).
//
// Cada guarda mantém a MESMA capacidade de detecção (mesmo gatilho, mesma
// severidade) — o que muda é o DESTINO: além de agir no loop, publica um
// `SupervisorSignal` no barramento.
//
// PORTÁVEL (ADR-0053 §8): SEM Ink, SEM I/O de terminal. Tipos puros + funções
// determinísticas. O barramento é injetado (SignalCollector).

import type { SignalCollector } from './bus.js';
import type { SignalOrigin, SignalSeverity, SupervisorSignal } from './contract.js';

// ─── Factory pura de sinal ────────────────────────────────────────────────

/**
 * Cria um `SupervisorSignal` imutável. `ts` default é `Date.now()`, injetável
 * (p/ teste determinístico).
 */
export function makeSignal(
  origin: SignalOrigin,
  severity: SignalSeverity,
  payload: Record<string, unknown>,
  ts?: number,
): SupervisorSignal {
  return {
    origin,
    severity,
    ts: ts ?? Date.now(),
    payload,
  };
}

// ─── Helpers de emissão por guarda ────────────────────────────────────────

/**
 * Emite um sinal de degeneração ao barramento (se presente). ADITIVO: o erro
 * `DegenerateLoopError` ainda é lançado normalmente — o freio DURO segue intacto.
 */
export function emitDegenerationSignal(
  bus: SignalCollector | undefined,
  kind: 'line-repeat' | 'short-cycle',
  repeats: number,
  sample: string,
  ts?: number,
): void {
  if (!bus) return;
  const severity: SignalSeverity = kind === 'short-cycle' ? 'critical' : 'warning';
  bus.publish(
    makeSignal('degeneration', severity, { kind, repeats, sample } as Record<string, unknown>, ts),
  );
}

/**
 * Emite um sinal de travamento (stuck) ao barramento. ADITIVO: o `StuckAlert`
 * ainda é entregue ao resolver — o freio DURO segue intacto.
 */
export function emitStuckSignal(
  bus: SignalCollector | undefined,
  stuckKind: string,
  count: number,
  sample: string,
  ts?: number,
): void {
  if (!bus) return;
  bus.publish(
    makeSignal('stuck', 'warning', { stuckKind, count, sample } as Record<string, unknown>, ts),
  );
}

/**
 * Emite um sinal de pressão de memória ao barramento. ADITIVO: a ação
 * (`compact`/`warn`/`shutdown`) ainda é executada pelo locus normalmente.
 */
export function emitMemPressureSignal(
  bus: SignalCollector | undefined,
  action: string,
  ratio: number,
  heapLimitBytes: number,
  ts?: number,
): void {
  if (!bus) return;
  const severity: SignalSeverity = action === 'shutdown' ? 'critical' : 'warning';
  bus.publish(
    makeSignal(
      'mem-pressure',
      severity,
      { action, ratio, heapLimitBytes } as Record<string, unknown>,
      ts,
    ),
  );
}

/**
 * Emite um sinal de self-check ao barramento. ADITIVO: o probe de self-check
 * ainda é injetado no histórico normalmente.
 */
export function emitSelfCheckSignal(
  bus: SignalCollector | undefined,
  checkKind: 'reanchor' | 'verify' | 'cap-reached',
  iteration?: number,
  attempt?: number,
  max?: number,
  ts?: number,
): void {
  if (!bus) return;
  const payload: Record<string, unknown> = { checkKind };
  if (iteration !== undefined) payload['iteration'] = iteration;
  if (attempt !== undefined) payload['attempt'] = attempt;
  if (max !== undefined) payload['max'] = max;
  bus.publish(makeSignal('self-check', 'info', payload, ts));
}

/**
 * Emite um sinal de weak-yolo (combo perigoso) ao barramento. ADITIVO: o aviso
 * ao stderr e o reforço ainda são emitidos normalmente.
 */
export function emitWeakYoloSignal(
  bus: SignalCollector | undefined,
  tier: string,
  ts?: number,
): void {
  if (!bus) return;
  bus.publish(makeSignal('weak-yolo', 'warning', { tier } as Record<string, unknown>, ts));
}

/**
 * Emite um sinal de budget excedido ao barramento. ADITIVO: o limite ainda é
 * respeitado e o loop para normalmente.
 */
export function emitBudgetSignal(
  bus: SignalCollector | undefined,
  limitKind: string,
  usage: { iterations: number; toolCalls: number; tokens: number },
  ts?: number,
): void {
  if (!bus) return;
  bus.publish(makeSignal('budget', 'warning', { limitKind, usage } as Record<string, unknown>, ts));
}

/**
 * Emite um sinal de cancelamento humano (ESC/Ctrl+C) ao barramento. ADITIVO:
 * o aborto do turno ainda acontece normalmente.
 *
 * Este é o sinal de TOPO absoluto (Q-MA1): severidade `critical` garante que
 * o regente (EST-1123) o coloque no topo da precedência.
 */
export function emitHumanCancelSignal(
  bus: SignalCollector | undefined,
  reason: string,
  ts?: number,
): void {
  if (!bus) return;
  bus.publish(makeSignal('human-cancel', 'critical', { reason } as Record<string, unknown>, ts));
}
