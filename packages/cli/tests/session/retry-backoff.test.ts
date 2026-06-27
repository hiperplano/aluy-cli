// EST-0948 (auto-retry) — política de BACKOFF do auto-retry (pura, sem timers).
// Prova: respeita o Retry-After do broker; senão exponencial (1s,2s,4s); jitter
// simétrico e limitado; teto duro (maxMs); piso não-negativo.

import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  DEFAULT_BACKOFF,
  type BackoffPolicy,
} from '../../src/session/retry-backoff.js';

const NO_JITTER: BackoffPolicy = { baseMs: 1000, maxMs: 30_000, jitter: 0 };

describe('backoffDelayMs (EST-0948)', () => {
  it('exponencial a partir de baseMs quando NÃO há Retry-After (1s, 2s, 4s)', () => {
    expect(backoffDelayMs(1, undefined, NO_JITTER)).toBe(1000);
    expect(backoffDelayMs(2, undefined, NO_JITTER)).toBe(2000);
    expect(backoffDelayMs(3, undefined, NO_JITTER)).toBe(4000);
    expect(backoffDelayMs(4, undefined, NO_JITTER)).toBe(8000);
  });

  it('RESPEITA o Retry-After do broker (segundos → ms), ignorando o exponencial', () => {
    expect(backoffDelayMs(1, 5, NO_JITTER)).toBe(5000);
    // mesmo numa tentativa avançada, o Retry-After manda (não soma exponencial).
    expect(backoffDelayMs(3, 2, NO_JITTER)).toBe(2000);
  });

  it('aplica o TETO maxMs (Retry-After hostil não vira espera absurda)', () => {
    expect(backoffDelayMs(1, 9999, { baseMs: 1000, maxMs: 30_000, jitter: 0 })).toBe(30_000);
    // exponencial alto também é limitado pelo teto.
    expect(backoffDelayMs(20, undefined, { baseMs: 1000, maxMs: 10_000, jitter: 0 })).toBe(10_000);
  });

  it('jitter simétrico ±fração (rand injetável), nunca negativo', () => {
    const policy: BackoffPolicy = { baseMs: 1000, maxMs: 30_000, jitter: 0.1 };
    // rand=0 ⇒ extremo inferior: 1000 * (1 + (0*2-1)*0.1) = 900.
    expect(backoffDelayMs(1, undefined, policy, () => 0)).toBe(900);
    // rand=1 (clamp teórico) ⇒ extremo superior: 1000 * 1.1 = 1100.
    expect(backoffDelayMs(1, undefined, policy, () => 1)).toBe(1100);
    // rand=0.5 ⇒ centro (sem desvio): 1000.
    expect(backoffDelayMs(1, undefined, policy, () => 0.5)).toBe(1000);
  });

  it('attempt < 1 é tratado como 1 (defensivo); resultado nunca negativo', () => {
    expect(backoffDelayMs(0, undefined, NO_JITTER)).toBe(1000);
    expect(backoffDelayMs(-3, undefined, NO_JITTER)).toBe(1000);
  });

  // HUNT-BROKER-RETRY — anti-thundering-herd NO TETO. Bug: o jitter era aplicado
  // ANTES do clamp a `maxMs`; quando o base (Retry-After hostil/compartilhado ou
  // exponencial alto) ≥ maxMs, o `Math.min(…, maxMs)` COMIA o jitter ⇒ N clientes
  // com o MESMO Retry-After acordavam no MESMÍSSIMO instante (maxMs). Agora o teto é
  // aplicado ao BASE antes do jitter, então o espalhamento sobrevive no teto.
  it('jitter SOBREVIVE no teto: Retry-After ≥ maxMs ainda espalha (não colapsa em maxMs)', () => {
    const policy: BackoffPolicy = { baseMs: 1000, maxMs: 30_000, jitter: 0.1 };
    // Retry-After=60s ⇒ rawBase=60000 ≥ maxMs=30000. ANTES: todo rand ⇒ 30000 (herd).
    // AGORA: o jitter incide sobre o base já-limitado (30000) ⇒ a metade inferior espalha.
    const low = backoffDelayMs(1, 60, policy, () => 0); // 30000 * 0.9 = 27000
    const mid = backoffDelayMs(1, 60, policy, () => 0.5); // 30000 (centro)
    expect(low).toBe(27_000);
    expect(mid).toBe(30_000);
    // Clientes distintos NÃO colapsam no mesmo instante (o ponto do anti-herd).
    expect(low).not.toBe(mid);
    // O teto segue sendo o máximo ABSOLUTO (o jitter nunca empurra acima de maxMs).
    expect(backoffDelayMs(1, 60, policy, () => 1)).toBe(30_000);
    expect(backoffDelayMs(1, 60, policy, () => 0.999)).toBeLessThanOrEqual(30_000);
  });

  it('jitter sobrevive no teto também no EXPONENCIAL alto (base > maxMs)', () => {
    const policy: BackoffPolicy = { baseMs: 1000, maxMs: 10_000, jitter: 0.1 };
    // attempt 6 ⇒ base = 1000*2^5 = 32000 > maxMs=10000. ANTES colapsava em 10000.
    const low = backoffDelayMs(6, undefined, policy, () => 0); // 10000 * 0.9 = 9000
    expect(low).toBe(9_000);
    expect(low).toBeLessThan(10_000);
    expect(backoffDelayMs(6, undefined, policy, () => 1)).toBe(10_000);
  });

  it('DEFAULT_BACKOFF é 1s base, teto 30s, jitter leve', () => {
    expect(DEFAULT_BACKOFF.baseMs).toBe(1000);
    expect(DEFAULT_BACKOFF.maxMs).toBe(30_000);
    expect(DEFAULT_BACKOFF.jitter).toBeGreaterThan(0);
    expect(DEFAULT_BACKOFF.jitter).toBeLessThan(0.5);
  });
});
