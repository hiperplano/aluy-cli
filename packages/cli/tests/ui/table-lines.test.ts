// tableLines — alinha colunas em texto (cara de tabela nas notas de listagem).
import { describe, expect, it } from 'vitest';
import { tableLines, boxTable } from '../../src/ui/table-lines.js';

describe('tableLines — alinhamento de colunas', () => {
  it('alinha as colunas (padEnd) e NÃO preenche a última', () => {
    const out = tableLines([
      ['read_file', '[leitura]', 'lê um arquivo'],
      ['run_command', '[execução]', 'roda um comando'],
    ]);
    // a 1ª coluna alinha pela mais larga ('run_command'); última sem trailing space.
    expect(out[0]).toBe('  read_file    [leitura]   lê um arquivo');
    expect(out[1]).toBe('  run_command  [execução]  roda um comando');
    expect(out.every((l) => l === l.replace(/\s+$/, ''))).toBe(true);
  });

  it('vazio ⇒ []; respeita indent/gap; cabeçalho opcional alinha junto', () => {
    expect(tableLines([])).toEqual([]);
    const out = tableLines([['a', 'bb']], { indent: '', gap: ' ', headers: ['NOME', 'X'] });
    expect(out[0]).toBe('NOME X'); // header alinhado às colunas
    expect(out[1]).toBe('a    bb'); // 'a' padEnd à largura de 'NOME'
  });
});

describe('boxTable — tabela com bordas (box-drawing)', () => {
  it('desenha topo/cabeçalho/régua/linhas/base com bordas', () => {
    const out = boxTable(['nome', 'efeito'], [['read', 'leitura']], { indent: '' });
    expect(out[0]).toBe('┌──────┬─────────┐'); // topo (col 'read'/'leitura' larguras)
    expect(out[1]).toBe('│ nome │ efeito  │'); // cabeçalho
    expect(out[2]).toBe('├──────┼─────────┤'); // régua
    expect(out[3]).toBe('│ read │ leitura │'); // linha
    expect(out[4]).toBe('└──────┴─────────┘'); // base
  });

  it('trunca célula que excede maxWidths (com …)', () => {
    const out = boxTable(['x'], [['abcdefghij']], { indent: '', maxWidths: [5] });
    expect(out.some((l) => l.includes('abcd…'))).toBe(true);
  });
});
