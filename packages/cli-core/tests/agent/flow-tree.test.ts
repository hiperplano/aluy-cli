// EST-1014 — endurecimento dos testes do motor agente: cobertura síncrona de
// ramos determinísticos em FlowNode que o teste de evict (EST-1011) não cobre:
//   (1) getter `aborted` — inicialmente false → true após cancel()
//   (2) setPhase em nó terminal (sticky) — terminal não regride de fase
//   (3) addTokens com valores inválidos/≤0 — só n > 0 e finito acumula
//
// Síncrono, sem I/O, sem mock de externalidades.

import { describe, expect, it } from 'vitest';
import { FlowNode } from '../../src/index.js';

/** Relógio determinístico (não avança automaticamente — só o que pedirmos). */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('EST-1014 · FlowNode — aborted / setPhase terminal / addTokens inválido', () => {
  // ─── (1) getter `aborted` ──────────────────────────────────────────────

  it('começa com aborted === false; vira true após cancel()', () => {
    const clock = fakeClock();
    const node = new FlowNode({
      id: 'test/abort-1',
      kind: 'subagent',
      label: 'abort-1',
      clock: clock.now,
    });

    // Inicialmente o nó NÃO está abortado.
    expect(node.aborted).toBe(false);

    // Cancela o nó (aborta o AbortController + marca cancelled).
    node.cancel();

    // Após cancel() o nó está abortado.
    expect(node.aborted).toBe(true);
  });

  // ─── (2) setPhase em nó terminal (sticky) ──────────────────────────────

  it('não muda de fase quando o nó está em estado terminal (done)', () => {
    const clock = fakeClock();
    const node = new FlowNode({
      id: 'test/sticky-1',
      kind: 'subagent',
      label: 'sticky-1',
      clock: clock.now,
    });

    // Leva o nó ao estado terminal 'done'.
    node.finish('final');
    expect(node.phase).toBe('done');
    expect(node.isTerminal()).toBe(true);

    // Tenta regredir a fase para 'tool' — deve ser IGNORADO.
    const phaseBefore = node.phase;
    node.setPhase('tool');
    expect(node.phase).toBe(phaseBefore);
    expect(node.phase).toBe('done');
  });

  it('não muda de fase quando o nó está em estado terminal (cancelled)', () => {
    const clock = fakeClock();
    const node = new FlowNode({
      id: 'test/sticky-2',
      kind: 'subagent',
      label: 'sticky-2',
      clock: clock.now,
    });

    // Leva o nó ao estado terminal 'cancelled'.
    node.cancel();
    expect(node.phase).toBe('cancelled');
    expect(node.isTerminal()).toBe(true);

    // Tenta regredir a fase — deve ser IGNORADO.
    const phaseBefore = node.phase;
    node.setPhase('thinking');
    expect(node.phase).toBe(phaseBefore);
    expect(node.phase).toBe('cancelled');
  });

  it('não muda de fase quando o nó está em estado terminal (failed)', () => {
    const clock = fakeClock();
    const node = new FlowNode({
      id: 'test/sticky-3',
      kind: 'subagent',
      label: 'sticky-3',
      clock: clock.now,
    });

    // Leva o nó ao estado terminal 'failed'.
    node.finish('error');
    expect(node.phase).toBe('failed');
    expect(node.isTerminal()).toBe(true);

    // Tenta regredir a fase — deve ser IGNORADO.
    const phaseBefore = node.phase;
    node.setPhase('asking');
    expect(node.phase).toBe(phaseBefore);
    expect(node.phase).toBe('failed');
  });

  // ─── (3) addTokens com valores inválidos/≤0 ────────────────────────────

  it('addTokens(5) acumula 5 tokens; addTokens(0) não muda; addTokens(-3) não muda; addTokens(NaN) não muda', () => {
    const clock = fakeClock();
    const node = new FlowNode({
      id: 'test/tokens-1',
      kind: 'subagent',
      label: 'tokens-1',
      clock: clock.now,
    });

    // Começa com 0.
    expect(node.accounting().tokens).toBe(0);

    // addTokens(5) → aumenta em 5.
    node.addTokens(5);
    expect(node.accounting().tokens).toBe(5);

    // addTokens(0) → ignorado (≤0).
    node.addTokens(0);
    expect(node.accounting().tokens).toBe(5);

    // addTokens(-3) → ignorado (≤0).
    node.addTokens(-3);
    expect(node.accounting().tokens).toBe(5);

    // addTokens(NaN) → ignorado (!Number.isFinite).
    node.addTokens(NaN);
    expect(node.accounting().tokens).toBe(5);
  });

  it('addTokens com n finito e > 0 sempre acumula; negativos e zero não afetam', () => {
    const clock = fakeClock();
    const node = new FlowNode({
      id: 'test/tokens-2',
      kind: 'subagent',
      label: 'tokens-2',
      clock: clock.now,
    });

    // Sequência: 10 (ok), -5 (ignora), 3 (acumula), 0 (ignora).
    node.addTokens(10);
    expect(node.accounting().tokens).toBe(10);

    node.addTokens(-5);
    expect(node.accounting().tokens).toBe(10);

    node.addTokens(3);
    expect(node.accounting().tokens).toBe(13);

    node.addTokens(0);
    expect(node.accounting().tokens).toBe(13);

    // Infinity não é finito — ignorado.
    node.addTokens(Infinity);
    expect(node.accounting().tokens).toBe(13);

    // -Infinity não é finito — ignorado.
    node.addTokens(-Infinity);
    expect(node.accounting().tokens).toBe(13);
  });
});
