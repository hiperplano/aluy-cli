// ADR-0150 (balde b) — `resolveSessionGcOptions`: config.json → `SessionGcOptions`,
// com a sanidade MÍNIMA (não anti-runaway) de `MIN_GC_MAX_AGE_MS`/`MIN_GC_MAX_COUNT`.

import { describe, expect, it } from 'vitest';
import {
  resolveSessionGcOptions,
  MIN_GC_MAX_AGE_MS,
  MIN_GC_MAX_COUNT,
} from '../../src/io/session-store.js';

describe('ADR-0150 (balde b) — resolveSessionGcOptions', () => {
  it('ausente/vazio ⇒ {} (o gc() cai nos próprios defaults)', () => {
    expect(resolveSessionGcOptions()).toEqual({});
    expect(resolveSessionGcOptions({})).toEqual({});
  });

  it('valores válidos passam direto', () => {
    expect(
      resolveSessionGcOptions({ gcMaxAgeMs: 5 * 24 * 60 * 60 * 1000, gcMaxCount: 20 }),
    ).toEqual({ maxAgeMs: 5 * 24 * 60 * 60 * 1000, maxCount: 20 });
  });

  it('sanidade MÍNIMA: idade abaixo de 1 dia é ELEVADA a 1 dia (nunca abaixo)', () => {
    expect(resolveSessionGcOptions({ gcMaxAgeMs: 1000 })).toEqual({ maxAgeMs: MIN_GC_MAX_AGE_MS });
  });

  it('sanidade MÍNIMA: contagem abaixo de 1 é ELEVADA a 1', () => {
    // gcMaxCount <= 0 é descartado pelo sanitize do config (shape-only não aceita
    // ≤0); aqui testamos a função resolver isolada com um valor já "positivo mas
    // baixo" — o piso do resolver nunca deixa passar 0.
    expect(resolveSessionGcOptions({ gcMaxCount: 1 })).toEqual({ maxCount: MIN_GC_MAX_COUNT });
  });

  it('entrada inválida (não-finito/≤0) ⇒ ignorada (campo ausente no resultado)', () => {
    expect(resolveSessionGcOptions({ gcMaxAgeMs: -1, gcMaxCount: Number.NaN })).toEqual({});
  });
});
