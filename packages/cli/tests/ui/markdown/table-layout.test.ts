// EST-0965 — testes do LAYOUT de tabela (puro): largura por coluna respeitando o
// terminal, truncamento com `…`, pad por alinhamento. Sem Ink.

import { describe, expect, it } from 'vitest';
import {
  computeColumnWidths,
  truncateToWidth,
  padCell,
  COL_GUTTER,
} from '../../../src/ui/markdown/table-layout.js';
import { displayWidth } from '../../../src/session/visual-lines.js';

describe('truncateToWidth', () => {
  it('cabe ⇒ inalterado', () => {
    expect(truncateToWidth('abc', 5)).toBe('abc');
  });
  it('não cabe ⇒ corta e põe … (largura total = width)', () => {
    const out = truncateToWidth('abcdefgh', 4);
    expect(out).toBe('abc…');
    expect(displayWidth(out)).toBe(4);
  });
  it('width<=0 ⇒ vazio', () => {
    expect(truncateToWidth('abc', 0)).toBe('');
  });
});

describe('padCell — alinhamento', () => {
  it('left pad à direita', () => {
    expect(padCell('ab', 5, 'left')).toBe('ab   ');
  });
  it('right pad à esquerda', () => {
    expect(padCell('ab', 5, 'right')).toBe('   ab');
  });
  it('center divide a sobra (extra à direita)', () => {
    expect(padCell('ab', 5, 'center')).toBe(' ab  ');
  });
});

describe('computeColumnWidths', () => {
  it('cabe ⇒ usa a largura NATURAL (máx do conteúdo por coluna)', () => {
    const w = computeColumnWidths(['Tipo', 'Nome'], [['dir', 'src-longo']], 2, 100);
    // col0: max('Tipo'=4,'dir'=3)=4 ; col1: max('Nome'=4,'src-longo'=9)=9
    expect(w).toEqual([4, 9]);
  });

  it('columns=0 (desconhecido) ⇒ natural, sem truncar', () => {
    const w = computeColumnWidths(['aaaa'], [['bbbbbbbb']], 1, 0);
    expect(w).toEqual([8]);
  });

  it('NÃO cabe ⇒ encolhe a coluna mais larga e a soma+gutters fica ≤ columns', () => {
    // 3 colunas de 20 cada = 60 + 2*gutter; columns=30 força encolher.
    const header = ['aaaaaaaaaaaaaaaaaaaa', 'b', 'c'];
    const rows = [['', 'bbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccc']];
    const cols = 3;
    const columns = 30;
    const w = computeColumnWidths(header, rows, cols, columns);
    const total = w.reduce((a, b) => a + b, 0) + (cols - 1) * COL_GUTTER;
    expect(total).toBeLessThanOrEqual(columns);
    expect(w.every((x) => x >= 1)).toBe(true);
  });

  it('terminal estreitíssimo ⇒ piso de 1 col por coluna (não explode)', () => {
    const w = computeColumnWidths(['xxxxxx', 'yyyyyy', 'zzzzzz'], [], 3, 5);
    expect(w).toEqual([1, 1, 1]);
  });
});
