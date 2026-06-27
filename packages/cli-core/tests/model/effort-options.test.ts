// EST-1117 · ADR-0053 §8 — testes do módulo PURO do passo de effort do `/model`
// conjugado: opções, navegação, normalização/validação do custom e resultado conjugado.
// Sem Ink/IO — só lógica determinística (o hook do CLI usa estes helpers).

import { describe, expect, it } from 'vitest';
import {
  effortOptions,
  effortOptionCount,
  clampEffortIndex,
  isCanonicalEffort,
  normalizeCustomEffort,
  validateCustomEffort,
  effortChoiceAt,
  effortChoiceFromCustom,
  CANONICAL_EFFORTS,
  MAX_EFFORT_LEN,
} from '../../src/model/effort-options.js';

describe('effort-options — opções e ordem', () => {
  it('lista manter + low/medium/high + custom, nesta ordem', () => {
    const opts = effortOptions();
    expect(opts.map((o) => o.id)).toEqual(['keep', 'low', 'medium', 'high', 'custom']);
    expect(opts[0]!.kind).toBe('keep');
    expect(opts[4]!.kind).toBe('custom');
  });

  it('os níveis canônicos carregam o value passthrough', () => {
    const levels = effortOptions().filter((o) => o.kind === 'level');
    expect(levels.map((o) => o.value)).toEqual([...CANONICAL_EFFORTS]);
  });

  it('effortOptionCount = 5', () => {
    expect(effortOptionCount()).toBe(5);
  });
});

describe('effort-options — navegação (clamp)', () => {
  it('clampa nas pontas [0, count-1]', () => {
    expect(clampEffortIndex(-3)).toBe(0);
    expect(clampEffortIndex(0)).toBe(0);
    expect(clampEffortIndex(4)).toBe(4);
    expect(clampEffortIndex(99)).toBe(4);
  });
});

describe('effort-options — canônico vs custom', () => {
  it('reconhece os canônicos (case-insensitive)', () => {
    expect(isCanonicalEffort('low')).toBe(true);
    expect(isCanonicalEffort('MEDIUM')).toBe(true);
    expect(isCanonicalEffort('high')).toBe(true);
    expect(isCanonicalEffort('ultra')).toBe(false);
    expect(isCanonicalEffort('')).toBe(false);
  });
});

describe('effort-options — normalização e validação do custom', () => {
  it('normaliza com trim', () => {
    expect(normalizeCustomEffort('  high  ')).toBe('high');
    expect(normalizeCustomEffort('xtra')).toBe('xtra');
  });

  it('vazio (ou só espaços) é inválido (empty)', () => {
    expect(validateCustomEffort('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateCustomEffort('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('> MAX_EFFORT_LEN é inválido (too-long)', () => {
    const over = 'x'.repeat(MAX_EFFORT_LEN + 1);
    expect(validateCustomEffort(over)).toEqual({ ok: false, reason: 'too-long' });
  });

  it('no limite exato (32) é VÁLIDO', () => {
    const exact = 'x'.repeat(MAX_EFFORT_LEN);
    expect(validateCustomEffort(exact)).toEqual({ ok: true, value: exact });
  });

  it('valor passthrough arbitrário ≤32 é aceito (trim aplicado)', () => {
    expect(validateCustomEffort('  reasoning:max  ')).toEqual({ ok: true, value: 'reasoning:max' });
  });
});

describe('effort-options — escolha conjugada (modo lista)', () => {
  it('índice 0 (manter) ⇒ keep', () => {
    expect(effortChoiceAt(0)).toEqual({ kind: 'keep' });
  });

  it('níveis canônicos ⇒ set com o value', () => {
    expect(effortChoiceAt(1)).toEqual({ kind: 'set', value: 'low' });
    expect(effortChoiceAt(2)).toEqual({ kind: 'set', value: 'medium' });
    expect(effortChoiceAt(3)).toEqual({ kind: 'set', value: 'high' });
  });

  it('"custom" (índice 4) ⇒ null (abre o texto-livre, não confirma)', () => {
    expect(effortChoiceAt(4)).toBeNull();
  });

  it('índice fora da faixa ⇒ null (defensivo)', () => {
    expect(effortChoiceAt(-1)).toBeNull();
    expect(effortChoiceAt(99)).toBeNull();
  });
});

describe('effort-options — escolha conjugada (custom)', () => {
  it('texto válido ⇒ set com o valor limpo', () => {
    expect(effortChoiceFromCustom('  xtra-high ')).toEqual({ kind: 'set', value: 'xtra-high' });
  });

  it('vazio/>32 ⇒ null (não confirma)', () => {
    expect(effortChoiceFromCustom('')).toBeNull();
    expect(effortChoiceFromCustom('x'.repeat(33))).toBeNull();
  });
});
