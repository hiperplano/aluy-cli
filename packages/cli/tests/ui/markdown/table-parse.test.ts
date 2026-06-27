// EST-0965 — testes do PARSER de TABELA markdown (GFM). Puro, sem Ink.
//
// Cobre o caso REAL do Tiago (`| Tipo | Nome | Tamanho | Modificação |` + sep +
// linhas), tolerância (com/sem pipe nas bordas, com/sem espaço), alinhamento
// `:--:`/`--:`, e o STREAMING-SAFE (header sem separador ainda NÃO vira tabela).

import { describe, expect, it } from 'vitest';
import { parseMarkdown, type TableBlockNode } from '../../../src/ui/markdown/parse.js';

/** Acha o 1º bloco de tabela do resultado (ou falha o teste). */
function table(md: string): TableBlockNode {
  const blocks = parseMarkdown(md);
  const t = blocks.find((b) => b.kind === 'table');
  if (!t) throw new Error(`nenhuma tabela em: ${JSON.stringify(blocks)}`);
  return t as TableBlockNode;
}

describe('parseMarkdown — TABELA (GFM)', () => {
  it('tabela do Tiago: 4 colunas, header + corpo, alinhamento default left', () => {
    const md = [
      '| Tipo | Nome | Tamanho | Modificação |',
      '| --- | --- | --- | --- |',
      '| dir | src | - | hoje |',
      '| arquivo | README.md | 2.1 KB | ontem |',
    ].join('\n');
    const t = table(md);
    expect(t.header).toEqual(['Tipo', 'Nome', 'Tamanho', 'Modificação']);
    expect(t.align).toEqual(['left', 'left', 'left', 'left']);
    expect(t.rows).toEqual([
      ['dir', 'src', '-', 'hoje'],
      ['arquivo', 'README.md', '2.1 KB', 'ontem'],
    ]);
  });

  it('alinhamento :--: (center) e --: (right) e :-- (left) respeitados', () => {
    const md = ['| a | b | c | d |', '|:---|:--:|---:|---|', '| 1 | 2 | 3 | 4 |'].join('\n');
    const t = table(md);
    expect(t.align).toEqual(['left', 'center', 'right', 'left']);
  });

  it('tolerante: SEM pipe nas bordas (`a | b`) ainda parseia', () => {
    const md = ['a | b', '--- | ---', '1 | 2'].join('\n');
    const t = table(md);
    expect(t.header).toEqual(['a', 'b']);
    expect(t.rows).toEqual([['1', '2']]);
  });

  it('tolerante: pipes coladas sem espaço (`|a|b|`) parseiam', () => {
    const md = ['|a|b|', '|---|---|', '|1|2|'].join('\n');
    const t = table(md);
    expect(t.header).toEqual(['a', 'b']);
    expect(t.rows).toEqual([['1', '2']]);
  });

  it('corpo com células faltando ⇒ preenche vazio; sobrando ⇒ corta no nº do header', () => {
    const md = ['| a | b | c |', '|---|---|---|', '| 1 | 2 |', '| 1 | 2 | 3 | 4 |'].join('\n');
    const t = table(md);
    expect(t.rows).toEqual([
      ['1', '2', ''],
      ['1', '2', '3'],
    ]);
  });

  it('STREAMING-SAFE: header SEM separador ainda ⇒ NÃO é tabela (cai como texto)', () => {
    const md = '| Tipo | Nome |';
    const blocks = parseMarkdown(md);
    expect(blocks.find((b) => b.kind === 'table')).toBeUndefined();
    expect(blocks[0]).toMatchObject({ kind: 'paragraph' });
  });

  it('STREAMING-SAFE: header + separador chegaram, corpo ainda não ⇒ tabela sem linhas', () => {
    const md = ['| a | b |', '|---|---|'].join('\n');
    const t = table(md);
    expect(t.header).toEqual(['a', 'b']);
    expect(t.rows).toEqual([]);
  });

  it('separador inválido (`| -- texto |`) NÃO casa como tabela', () => {
    const md = ['| a | b |', '| oops | nope |', '| 1 | 2 |'].join('\n');
    const blocks = parseMarkdown(md);
    expect(blocks.find((b) => b.kind === 'table')).toBeUndefined();
  });

  it('tabela termina na 1ª linha em branco; prosa depois vira parágrafo', () => {
    const md = ['| a | b |', '|---|---|', '| 1 | 2 |', '', 'depois da tabela'].join('\n');
    const blocks = parseMarkdown(md);
    const t = blocks.find((b) => b.kind === 'table') as TableBlockNode;
    expect(t.rows).toEqual([['1', '2']]);
    expect(blocks[blocks.length - 1]).toMatchObject({ kind: 'paragraph' });
  });

  it('pipe escapado `\\|` dentro da célula NÃO divide a coluna', () => {
    const md = ['| cmd | efeito |', '|---|---|', '| a \\| b | pipe literal |'].join('\n');
    const t = table(md);
    expect(t.rows[0]).toEqual(['a | b', 'pipe literal']);
  });

  it('célula com markdown inline preserva a marcação crua (render decide o estilo)', () => {
    const md = ['| nome | nota |', '|---|---|', '| **src** | `ok` |'].join('\n');
    const t = table(md);
    expect(t.rows[0]).toEqual(['**src**', '`ok`']);
  });
});
