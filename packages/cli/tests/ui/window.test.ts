// F88 (anti-flicker) — teste do primitivo de janela `windowAround` (a fonte única usada
// por History/Rewind/Provider/FlowTree/Permissions pickers). Garante a INVARIANTE de
// altura (slice ≤ maxRows) e a centralização no selecionado, incl. as bordas.

import { describe, expect, it } from 'vitest';
import { windowAround } from '../../src/ui/window.js';

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('windowAround', () => {
  it('cabe tudo (len ≤ maxRows) ⇒ devolve a coleção inteira, start 0', () => {
    const w = windowAround(range(5), 0, 10);
    expect(w.start).toBe(0);
    expect(w.slice).toEqual([0, 1, 2, 3, 4]);
  });

  it('len == maxRows ⇒ ainda mostra tudo (sem janelar)', () => {
    const w = windowAround(range(8), 3, 8);
    expect(w.start).toBe(0);
    expect(w.slice).toHaveLength(8);
  });

  it('len > maxRows ⇒ slice tem EXATAMENTE maxRows itens (invariante de altura)', () => {
    const w = windowAround(range(40), 20, 8);
    expect(w.slice).toHaveLength(8);
  });

  it('centra no selecionado (no meio)', () => {
    const w = windowAround(range(40), 20, 8);
    // start = 20 - floor(8/2) = 16 ; slice = [16..24)
    expect(w.start).toBe(16);
    expect(w.slice[0]).toBe(16);
    expect(w.slice).toContain(20);
  });

  it('clampa na borda INICIAL (selecionado no começo)', () => {
    const w = windowAround(range(40), 0, 8);
    expect(w.start).toBe(0);
    expect(w.slice).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('clampa na borda FINAL (selecionado no fim) — sempre visível', () => {
    const w = windowAround(range(40), 39, 8);
    expect(w.start).toBe(32); // 40 - 8
    expect(w.slice[w.slice.length - 1]).toBe(39);
    expect(w.slice).toContain(39);
  });

  it('tolera selected fora do intervalo (clampa pelas bordas, nunca lança)', () => {
    expect(windowAround(range(40), -5, 8).start).toBe(0);
    expect(windowAround(range(40), 999, 8).start).toBe(32);
    expect(windowAround(range(40), 999, 8).slice).toHaveLength(8);
  });

  it('coleção vazia ⇒ slice vazio', () => {
    expect(windowAround([], 0, 8).slice).toEqual([]);
  });

  it('genérico: preserva o tipo dos itens (objetos)', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const w = windowAround(items, 0, 2);
    expect(w.slice).toHaveLength(2);
    expect(w.slice[0]).toEqual({ id: 'a' });
  });
});

// F89 (wrap-aware) — janela por LINHAS VISUAIS quando `rowHeight` é dado. Resolve o estouro
// em terminais estreitos (entradas que quebram em ≥2 linhas).
describe('windowAround — modo wrap-aware (rowHeight)', () => {
  it('rowHeight=()=>1 reproduz EXATAMENTE o caminho por-item (cols largo intacto)', () => {
    for (let sel = 0; sel < 40; sel += 1) {
      for (const maxRows of [4, 7, 8, 13]) {
        const byItem = windowAround(range(40), sel, maxRows);
        const byHeight = windowAround(range(40), sel, maxRows, () => 1);
        expect(byHeight.start).toBe(byItem.start);
        expect(byHeight.slice).toEqual(byItem.slice);
      }
    }
  });

  it('empacota MENOS itens quando as entradas são altas (orçamento de LINHAS)', () => {
    // cada item ocupa 3 linhas visuais; maxRows=9 ⇒ cabem 3 itens (3×3=9).
    const w = windowAround(range(40), 20, 9, () => 3);
    const visual = w.slice.reduce((sum) => sum + 3, 0);
    expect(visual).toBeLessThanOrEqual(9);
    expect(w.slice).toHaveLength(3);
    expect(w.slice).toContain(20); // o selecionado continua visível.
  });

  it('alturas MISTAS: respeita o orçamento de linhas e mantém o selecionado', () => {
    // alturas alternadas 1/2; budget 6 linhas.
    const h = (n: number): number => (n % 2 === 0 ? 1 : 2);
    const w = windowAround(range(40), 21, 6, h);
    const visual = w.slice.reduce((s, n) => s + h(n), 0);
    expect(visual).toBeLessThanOrEqual(6);
    expect(w.slice).toContain(21);
  });

  it('item único mais alto que o orçamento ⇒ mostra ao menos o selecionado (clipado)', () => {
    const w = windowAround(range(40), 10, 4, () => 99);
    expect(w.slice).toEqual([10]);
  });

  it('tudo cabe em linhas ⇒ mostra tudo', () => {
    const w = windowAround(range(5), 2, 100, () => 2); // 5×2=10 ≤ 100
    expect(w.start).toBe(0);
    expect(w.slice).toHaveLength(5);
  });
});
