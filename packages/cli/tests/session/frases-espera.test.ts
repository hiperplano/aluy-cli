// Frases de espera: lista, rotação e ajuste da linha de trabalho a UMA linha.
import { describe, expect, it } from 'vitest';
import { resolveText } from '../../src/i18n/translate.js';
import {
  PERIODO_FRASE_MS,
  ajustarLinhaTrabalho,
  cortarFrase,
  fraseDaEspera,
  ordemDasFrases,
  parseFrases,
} from '../../src/session/frases-espera.js';

const frases = parseFrases(resolveText('pt-BR', 'working.quips'));

describe('lista de frases', () => {
  it('tem de 40 a 60 entradas, sem repetição, curtas', () => {
    expect(frases.length).toBeGreaterThanOrEqual(40);
    expect(frases.length).toBeLessThanOrEqual(60);
    expect(new Set(frases).size).toBe(frases.length);
    for (const f of frases) expect(f.length).toBeLessThanOrEqual(46);
  });
});

describe('rotação', () => {
  const base = { frases, seed: 7, desde: 10_000, girar: true } as const;
  it('fica na mesma frase dentro do período e troca ao completá-lo', () => {
    const a = fraseDaEspera({ ...base, agoraMs: 10_000 });
    expect(fraseDaEspera({ ...base, agoraMs: 10_000 + PERIODO_FRASE_MS - 1 })).toBe(a);
    expect(fraseDaEspera({ ...base, agoraMs: 10_000 + PERIODO_FRASE_MS })).not.toBe(a);
  });
  it('percorre todas antes de repetir (ordem embaralhada)', () => {
    const vistas = new Set<string>();
    for (let i = 0; i < frases.length; i += 1)
      vistas.add(fraseDaEspera({ ...base, agoraMs: 10_000 + i * PERIODO_FRASE_MS })!);
    expect(vistas.size).toBe(frases.length);
    expect([...ordemDasFrases(10, 1)].sort((x, y) => x - y)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });
  it('sem movimento (girar=false) a frase não troca', () => {
    const a = fraseDaEspera({ ...base, girar: false, agoraMs: 10_000 });
    expect(fraseDaEspera({ ...base, girar: false, agoraMs: 10_000 + 10 * PERIODO_FRASE_MS })).toBe(
      a,
    );
  });
});

describe('ajustarLinhaTrabalho — nunca passa de uma linha', () => {
  const suffix = '· 2 sub-agente(s) trabalhando · F8 para parar';
  it('cabe em qualquer largura de 20 a 200 colunas', () => {
    for (let cols = 20; cols <= 200; cols += 1) {
      for (const label of frases) {
        const r = ajustarLinhaTrabalho({
          columns: cols,
          label,
          detalhe: '(escrevendo · ↑ ~8,2k ↓ 1,2k tokens · 1m 05s)',
          suffix,
        });
        const total =
          5 +
          r.label.length +
          1 +
          (r.detalhe ? 1 + r.detalhe.length : 0) +
          (r.suffix ? 1 + r.suffix.length : 0);
        expect(total).toBeLessThanOrEqual(Math.max(14, cols - 1));
      }
    }
  });
  it('largura sobrando não corta nada', () => {
    expect(ajustarLinhaTrabalho({ columns: 200, label: 'a', detalhe: '(1s)', suffix })).toEqual({
      label: 'a',
      detalhe: '(1s)',
      suffix,
    });
  });
  it('cortarFrase respeita a largura', () => {
    expect(cortarFrase('abcdefghij', 6).length).toBeLessThanOrEqual(5);
    expect(cortarFrase('abc', 6)).toBe('abc');
  });
});
