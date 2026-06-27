// Helper de TABELA-em-texto para as notas dos comandos de LISTAGEM (/tools, /mcp,
// /agents, /skills): alinha as colunas com `padEnd` ⇒ a nota (que é só `string[]`)
// sai com cara de TABELA, sem precisar de um novo tipo de bloco. PURO (sem cor/Ink) —
// o estilo fica com a nota. Última coluna NÃO é preenchida (sem espaços à direita).

export interface TableOpts {
  /** Recuo à esquerda de cada linha (default 2 espaços). */
  readonly indent?: string;
  /** Separador entre colunas (default 2 espaços). */
  readonly gap?: string;
  /** Cabeçalho opcional (vira a 1ª linha, alinhado às colunas). */
  readonly headers?: readonly string[];
}

/** Alinha `rows` (cada uma um array de células) em colunas de largura fixa. */
export function tableLines(rows: readonly (readonly string[])[], opts: TableOpts = {}): string[] {
  const indent = opts.indent ?? '  ';
  const gap = opts.gap ?? '  ';
  const all = opts.headers ? [opts.headers, ...rows] : rows;
  if (all.length === 0) return [];

  const cols = Math.max(...all.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c += 1) {
    widths[c] = Math.max(...all.map((r) => (r[c] ?? '').length));
  }

  const fmt = (r: readonly string[]): string =>
    (
      indent +
      r
        .map((cell, c) => (c === r.length - 1 ? (cell ?? '') : (cell ?? '').padEnd(widths[c]!)))
        .join(gap)
    ).replace(/\s+$/, '');

  return all.map(fmt);
}

// TABELA COM BORDAS (box-drawing): o helper PURO mora no @hiperplano/aluy-cli-core (p/ os
// builders portáveis /agents·/skills·/model·/workflows usarem sem cruzar a
// fronteira). O `cli` só RE-EXPORTA — uma única implementação, sem divergir.
export { boxTable, type BoxTableOpts } from '@hiperplano/aluy-cli-core';
