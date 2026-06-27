// TABELA COM BORDAS (box-drawing) — helper PURO compartilhado pelos builders de
// LISTAGEM (/tools, /mcp, /agents, /skills, /model, /workflows). Decisão do dono:
// listagens com ESTRUTURA visual (borda), não só alinhamento. Última coluna
// PREENCHIDA (caixa fechada). Cada célula pode ser truncada por `maxWidths[c]`
// (com `…`) p/ a caixa não estourar a largura do terminal.
//
// PORTÁVEL (ADR-0053 §8): só formata string — sem Ink, sem `node:*`, sem I/O de
// terminal. Mora no cli-core p/ os builders portáveis (agents/skills/model/...)
// usarem; o pacote `cli` re-exporta p/ o /tools (CLI-side) sem divergir.

export interface BoxTableOpts {
  /** Recuo à esquerda de cada linha (default 2 espaços). */
  readonly indent?: string;
  /** Teto de chars por coluna; estourou ⇒ trunca com `…`. */
  readonly maxWidths?: readonly number[];
}

/** Desenha `headers`+`rows` como tabela com bordas. Retorna as linhas (string[]). */
export function boxTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  opts: BoxTableOpts = {},
): string[] {
  const indent = opts.indent ?? '  ';
  const cols = headers.length;
  const clip = (s: string, c: number): string => {
    const max = opts.maxWidths?.[c];
    if (max !== undefined && s.length > max) return s.slice(0, Math.max(1, max - 1)) + '…';
    return s;
  };
  const cell = (r: readonly string[], c: number): string => clip(r[c] ?? '', c);

  const all = [headers, ...rows];
  const w: number[] = [];
  for (let c = 0; c < cols; c += 1) {
    w[c] = Math.max(...all.map((r) => cell(r, c).length));
  }

  const bar = (l: string, m: string, r: string): string =>
    indent + l + w.map((width) => '─'.repeat(width + 2)).join(m) + r;
  const row = (cells: readonly string[]): string =>
    indent + '│ ' + w.map((width, c) => cell(cells, c).padEnd(width)).join(' │ ') + ' │';

  return [
    bar('┌', '┬', '┐'),
    row(headers),
    bar('├', '┼', '┤'),
    ...rows.map(row),
    bar('└', '┴', '┘'),
  ];
}
