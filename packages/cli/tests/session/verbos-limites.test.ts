// Auditoria — limites dos formatadores/sorteio da linha de trabalho (verbos.ts), que as
// mutações deixaram passar: o sorteio nunca repete o verbo anterior (nem com o RNG teimoso), a
// virada de 59s→1m, o corte do `k`/`M` e o `0` que não aparece.

import { describe, expect, it } from 'vitest';
import {
  formatContagemPtBr,
  formatSegundos,
  formatTokensPtBr,
  sortearVerbo,
} from '../../src/session/verbos.js';

describe('sortearVerbo', () => {
  const lista = ['A', 'B', 'C', 'D'];

  it('com um RNG que SEMPRE cai no anterior, ainda assim devolve outro (nunca repete)', () => {
    // rng()=0 ⇒ índice 0 ⇒ 'A' em todas as 8 tentativas; o fallback acha o primeiro diferente.
    expect(sortearVerbo(lista, () => 0, 'A')).toBe('B');
    expect(sortearVerbo(lista, () => 0.99, 'D')).toBe('A');
  });

  it('sem anterior, devolve o sorteado; lista vazia ⇒ undefined; um só ⇒ ele mesmo', () => {
    expect(sortearVerbo(lista, () => 0.6)).toBe('C');
    expect(sortearVerbo([], () => 0.5)).toBeUndefined();
    expect(sortearVerbo(['Só'], () => 0.5, 'Só')).toBe('Só');
  });
});

describe('formatSegundos', () => {
  it('59s continua em segundos; 60s vira 1m 00s; zera os segundos com 2 dígitos', () => {
    expect(formatSegundos(59_999)).toBe('59s');
    expect(formatSegundos(60_000)).toBe('1m 00s');
    expect(formatSegundos(65_000)).toBe('1m 05s');
    expect(formatSegundos(3_600_000)).toBe('60m 00s');
  });
  it('inválido/negativo ⇒ 0s', () => {
    expect(formatSegundos(-5)).toBe('0s');
    expect(formatSegundos(Number.NaN)).toBe('0s');
  });
});

describe('formatContagemPtBr / formatTokensPtBr', () => {
  it('abaixo de mil: número cru; a partir de mil: k com 1 casa até 10k, inteiro acima', () => {
    expect(formatContagemPtBr(850)).toBe('850');
    expect(formatContagemPtBr(1_000)).toBe('1k');
    expect(formatContagemPtBr(1_234)).toBe('1,2k');
    expect(formatContagemPtBr(9_400)).toBe('9,4k');
    expect(formatContagemPtBr(10_000)).toBe('10k');
    expect(formatContagemPtBr(12_400)).toBe('12k');
    expect(formatContagemPtBr(33_000)).toBe('33k');
    expect(formatContagemPtBr(250_000)).toBe('250k');
  });
  it('a partir de 1 milhão vira M com vírgula', () => {
    expect(formatContagemPtBr(1_000_000)).toBe('1,0M');
    expect(formatContagemPtBr(2_500_000)).toBe('2,5M');
  });
  it('zero, negativo e inválido somem (nunca "0 tokens")', () => {
    expect(formatContagemPtBr(0)).toBeUndefined();
    expect(formatContagemPtBr(-3)).toBeUndefined();
    expect(formatContagemPtBr(Number.NaN)).toBeUndefined();
    expect(formatTokensPtBr(0)).toBeUndefined();
    expect(formatTokensPtBr(1_200)).toBe('1,2k tokens');
  });
});
