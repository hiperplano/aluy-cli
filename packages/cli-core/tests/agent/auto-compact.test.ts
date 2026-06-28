// EST-0973 — AUTO-COMPACTAÇÃO da JANELA: testes PUROS do módulo (config/gating +
// medição da ocupação + juízo/anti-loop). Sem modelo, sem I/O — só a lógica.

import { describe, expect, it } from 'vitest';
import {
  AUTOCOMPACT_OFF,
  DEFAULT_AUTOCOMPACT_AT,
  DEFAULT_MAX_CONSECUTIVE_AUTOCOMPACT,
  decideAutoCompact,
  newAutoCompactState,
  parseAutoCompactAt,
  resolveAutoCompact,
  windowRatio,
  type AutoCompactConfig,
} from '../../src/agent/auto-compact.js';

const WINDOW = 200_000;

function cfg(over: Partial<AutoCompactConfig> = {}): AutoCompactConfig {
  return {
    at: DEFAULT_AUTOCOMPACT_AT,
    contextWindow: WINDOW,
    maxConsecutive: DEFAULT_MAX_CONSECUTIVE_AUTOCOMPACT,
    ...over,
  };
}

describe('EST-0973 — windowRatio (ocupação da janela)', () => {
  it('razão = tokens_in / janela, clampada [0,1]', () => {
    expect(windowRatio(100_000, 200_000)).toBeCloseTo(0.5);
    expect(windowRatio(170_000, 200_000)).toBeCloseTo(0.85);
    // estoura ⇒ clampa em 1 (nunca >1).
    expect(windowRatio(500_000, 200_000)).toBe(1);
  });

  it('fail-safe: sem tokens / sem janela ⇒ 0 (não dispara)', () => {
    expect(windowRatio(undefined, 200_000)).toBe(0);
    expect(windowRatio(0, 200_000)).toBe(0);
    expect(windowRatio(100_000, 0)).toBe(0);
    expect(windowRatio(NaN, 200_000)).toBe(0);
  });
});

describe('EST-0973 — parseAutoCompactAt', () => {
  it('off/0/false ⇒ desliga (0)', () => {
    expect(parseAutoCompactAt('off')).toBe(0);
    expect(parseAutoCompactAt('0')).toBe(0);
    expect(parseAutoCompactAt('false')).toBe(0);
    expect(parseAutoCompactAt('no')).toBe(0);
    expect(parseAutoCompactAt('none')).toBe(0);
  });

  it('razão 0..1 usada direto; porcentagem >1 dividida por 100', () => {
    expect(parseAutoCompactAt('0.85')).toBeCloseTo(0.85);
    expect(parseAutoCompactAt('0.9')).toBeCloseTo(0.9);
    expect(parseAutoCompactAt('85')).toBeCloseTo(0.85);
    expect(parseAutoCompactAt('100')).toBeCloseTo(1);
  });

  it('vazio/undefined/lixo ⇒ undefined (cai no default)', () => {
    expect(parseAutoCompactAt(undefined)).toBeUndefined();
    expect(parseAutoCompactAt('')).toBeUndefined();
    expect(parseAutoCompactAt('abc')).toBeUndefined();
  });
});

describe('EST-0973 — resolveAutoCompact (gating flag>env>default)', () => {
  it('default LIGADO a 0.85 quando nada decide e há janela', () => {
    const c = resolveAutoCompact({ contextWindow: WINDOW });
    expect(c.at).toBeCloseTo(DEFAULT_AUTOCOMPACT_AT);
    expect(c.contextWindow).toBe(WINDOW);
    expect(c.maxConsecutive).toBe(DEFAULT_MAX_CONSECUTIVE_AUTOCOMPACT);
  });

  it('ALUY_AUTOCOMPACT_AT=0 DESLIGA (at:0 ⇒ baseline)', () => {
    const c = resolveAutoCompact({ atEnv: '0', contextWindow: WINDOW });
    expect(c.at).toBe(0);
  });

  it('a FLAG vence o env', () => {
    // env desliga, mas a flag liga a 0.9 ⇒ vence.
    const c = resolveAutoCompact({ atFlag: '0.9', atEnv: 'off', contextWindow: WINDOW });
    expect(c.at).toBeCloseTo(0.9);
    // env liga, flag desliga ⇒ desligado.
    const c2 = resolveAutoCompact({ atFlag: 'off', atEnv: '0.8', contextWindow: WINDOW });
    expect(c2.at).toBe(0);
  });

  it('ADR-0136: config.context entra entre env e default (flag>env>config>default)', () => {
    // só config define o limiar
    expect(resolveAutoCompact({ atConfig: 0.7, contextWindow: WINDOW }).at).toBeCloseTo(0.7);
    // env vence config
    expect(resolveAutoCompact({ atEnv: '0.8', atConfig: 0.7, contextWindow: WINDOW }).at).toBeCloseTo(0.8);
    // flag vence tudo
    expect(
      resolveAutoCompact({ atFlag: '0.9', atEnv: '0.8', atConfig: 0.7, contextWindow: WINDOW }).at,
    ).toBeCloseTo(0.9);
    // config desliga (off) quando é a fonte vencedora
    expect(resolveAutoCompact({ atConfig: 'off', contextWindow: WINDOW }).at).toBe(0);
    // maxConsecutive (clampado a [1,5]): env vence config; só config também vale
    expect(
      resolveAutoCompact({ contextWindow: WINDOW, maxConsecutiveConfig: 3 }).maxConsecutive,
    ).toBe(3);
    expect(
      resolveAutoCompact({ contextWindow: WINDOW, maxConsecutiveEnv: '4', maxConsecutiveConfig: 2 })
        .maxConsecutive,
    ).toBe(4);
  });

  it('limiar é CLAMPADO a [0.5, 0.98] quando ligado', () => {
    expect(resolveAutoCompact({ atFlag: '0.1', contextWindow: WINDOW }).at).toBeCloseTo(0.5);
    expect(resolveAutoCompact({ atFlag: '0.999', contextWindow: WINDOW }).at).toBeCloseTo(0.98);
  });

  it('sem janela (contextWindow<=0) ⇒ INERTE (at:0) mesmo com limiar', () => {
    const c = resolveAutoCompact({ atFlag: '0.85', contextWindow: 0 });
    expect(c.at).toBe(0);
  });

  it('ALUY_AUTOCOMPACT_MAX afina o anti-loop (clampado)', () => {
    expect(
      resolveAutoCompact({ contextWindow: WINDOW, maxConsecutiveEnv: '3' }).maxConsecutive,
    ).toBe(3);
    // clamp: 99 ⇒ teto 5; 0/lixo ⇒ default.
    expect(
      resolveAutoCompact({ contextWindow: WINDOW, maxConsecutiveEnv: '99' }).maxConsecutive,
    ).toBe(5);
    expect(
      resolveAutoCompact({ contextWindow: WINDOW, maxConsecutiveEnv: 'x' }).maxConsecutive,
    ).toBe(DEFAULT_MAX_CONSECUTIVE_AUTOCOMPACT);
  });
});

describe('EST-0973 — decideAutoCompact (juízo + ANTI-LOOP)', () => {
  it('janela abaixo do limiar ⇒ none', () => {
    const d = decideAutoCompact(cfg(), 0.7, newAutoCompactState());
    expect(d.action).toBe('none');
  });

  it('desligada (at:0) ⇒ none mesmo cheia', () => {
    const d = decideAutoCompact(cfg({ at: 0 }), 0.99, newAutoCompactState());
    expect(d.action).toBe('none');
  });

  it('inerte (sem janela) ⇒ none', () => {
    const d = decideAutoCompact(cfg({ contextWindow: 0 }), 0.99, newAutoCompactState());
    expect(d.action).toBe('none');
  });

  it('janela no/acima do limiar e com orçamento ⇒ compact', () => {
    expect(decideAutoCompact(cfg(), 0.85, newAutoCompactState()).action).toBe('compact');
    expect(decideAutoCompact(cfg(), 0.97, newAutoCompactState()).action).toBe('compact');
  });

  it('ANTI-LOOP: estourou maxConsecutive ⇒ give-up (firstTime na transição)', () => {
    const state = { consecutive: DEFAULT_MAX_CONSECUTIVE_AUTOCOMPACT, gaveUp: false };
    const d = decideAutoCompact(cfg(), 0.95, state);
    expect(d).toEqual({ action: 'give-up', firstTime: true });
  });

  it('ANTI-LOOP: já desistiu (gaveUp) ⇒ give-up sem re-avisar (firstTime:false)', () => {
    const state = { consecutive: 9, gaveUp: true };
    const d = decideAutoCompact(cfg(), 0.95, state);
    expect(d).toEqual({ action: 'give-up', firstTime: false });
  });

  it('AUTOCOMPACT_OFF é baseline puro', () => {
    expect(AUTOCOMPACT_OFF.at).toBe(0);
    expect(decideAutoCompact(AUTOCOMPACT_OFF, 0.99, newAutoCompactState()).action).toBe('none');
  });
});
