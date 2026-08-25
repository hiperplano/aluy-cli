// Helper de TABELA-EM-TEXTO das listagens (`/service`, `/mcp`, `/rooms`, `/cron`, …).
//
// Mora no CORE, como o `boxTable`, pelo mesmo motivo: os builders PORTÁVEIS
// (`agents-list`, `skills-list`) precisam dele sem cruzar a fronteira ADR-0053 §8. O
// `cli` só RE-EXPORTA — uma implementação, sem divergir.
//
// PURO: sem cor, sem Ink. Devolve `string[]`, que é o que `pushNote` consome.
//
// POR QUE ESTE DESENHO, e não a borda completa: pedido do dono — "não precisa ser uma
// tabela toda quadriculada, mas as informações deveriam ser organizadas melhor
// visualmente". Uma grade de box-drawing pesa demais para três colunas no meio de uma
// conversa; sem separador nenhum, o cabeçalho se perde entre os dados. A régua sob o
// cabeçalho é o meio-termo.

export interface TableOpts {
  /** Recuo à esquerda de cada linha (default 2 espaços). */
  readonly indent?: string;
  /** Separador entre colunas (default 2 espaços). */
  readonly gap?: string;
  /** Cabeçalho opcional (vira a 1ª linha, alinhado às colunas). */
  readonly headers?: readonly string[];
  /**
   * Régua sob o cabeçalho (`────  ───  ──`). Default `true` quando há `headers`.
   *
   * É o que faz a listagem LER como tabela sem virar grade — pedido do dono: "não
   * precisa ser uma tabela toda quadriculada, mas as informações deveriam ser
   * organizadas melhor visualmente". A borda completa (`boxTable`) pesa demais para
   * uma lista de 3 colunas no meio de uma conversa; sem separador nenhum, o cabeçalho
   * some no meio dos dados.
   */
  readonly rule?: boolean;
  /**
   * Teto de largura por coluna; estourou ⇒ trunca com `…`.
   *
   * EXISTE porque a ausência dele foi um defeito REAL, pego por revisão: ao migrar
   * `/agents` e `/skills` do `boxTable` (que tem `maxWidths`) para cá, o spread do
   * `opts` manteve o campo — e ele virou NO-OP. A truncagem sumiu em silêncio, e os
   * testes seguiram verdes porque nenhuma fixture tinha descrição longa o bastante.
   * Em uso real, um `sobre` comprido estouraria a tabela inteira.
   *
   * Truncar o DESCRITIVO é aceitável; truncar o que IDENTIFICA (nome/id) não — quem
   * chama escolhe, passando teto só nas colunas de texto livre.
   */
  readonly maxWidths?: readonly number[];
}

/** Alinha `rows` (cada uma um array de células) em colunas de largura fixa. */
export function tableLines(rows: readonly (readonly string[])[], opts: TableOpts = {}): string[] {
  const indent = opts.indent ?? '  ';
  const gap = opts.gap ?? '  ';
  const all = opts.headers ? [opts.headers, ...rows] : rows;
  if (all.length === 0) return [];

  const cols = Math.max(...all.map((r) => r.length));
  // Aplica o teto ANTES de medir: a largura da coluna é a do conteúdo JÁ truncado.
  const teto = opts.maxWidths;
  const corta = (cell: string, c: number): string => {
    const max = teto?.[c];
    if (max === undefined || max <= 0 || cell.length <= max) return cell;
    return max <= 1 ? '…' : cell.slice(0, max - 1) + '…';
  };
  const linhasCortadas = all.map((r) => r.map((cell, c) => corta(cell ?? '', c)));
  const widths: number[] = [];
  for (let c = 0; c < cols; c += 1) {
    widths[c] = Math.max(...linhasCortadas.map((r) => (r[c] ?? '').length));
  }

  const fmt = (r: readonly string[]): string =>
    (
      indent +
      r
        .map((cell, c) => (c === r.length - 1 ? (cell ?? '') : (cell ?? '').padEnd(widths[c]!)))
        .join(gap)
    ).replace(/\s+$/, '');

  const linhas = linhasCortadas.map(fmt);
  // A régua entra DEPOIS da formatação, usando as larguras já calculadas — assim ela
  // acompanha exatamente as colunas, inclusive quando uma célula é mais larga que o
  // próprio cabeçalho.
  if (opts.headers !== undefined && opts.rule !== false && linhas.length > 0) {
    const regua =
      indent +
      widths
        .slice(0, cols)
        .map((w) => '─'.repeat(Math.max(1, w)))
        .join(gap);
    linhas.splice(1, 0, regua.replace(/\s+$/, ''));
  }
  return linhas;
}
