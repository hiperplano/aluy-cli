// EST-0965 — LAYOUT de tabela (PURO, sem React/Ink): calcula a largura de cada
// coluna RESPEITANDO a largura do terminal e TRUNCA o conteúdo p/ caber, sem
// estourar. Separado do <TableBlock> p/ ser 100% testável (e p/ o orçamento de
// altura anti-flicker poder medir a tabela sem renderizar).
//
// Filosofia: a tabela NUNCA pode exceder `columns` (senão o terminal re-flui e a
// célula quebra em várias linhas visuais → fura o orçamento → pisca, #69). Então:
//  1. largura NATURAL de cada coluna = máx(displayWidth) do header + células.
//  2. se a soma (+ gutters) couber em `columns`, usa a natural (sem truncar).
//  3. se NÃO couber, encolhe as colunas MAIS LARGAS primeiro (water-filling), até
//     caber; cada célula que passar da largura da coluna é truncada com `…`.
//  4. piso de 1 col por coluna: tabela larguíssima em terminal estreito ainda
//     cabe (degrada graciosamente, não explode).

import { displayWidth } from '../../session/visual-lines.js';

/** Gutter (espaços) entre colunas adjacentes — ` │ ` ou `   ` ocupa 3 colunas. */
export const COL_GUTTER = 3;
/** Largura mínima de UMA coluna (pelo menos cabe o `…`). */
const MIN_COL = 1;

/**
 * Trunca `text` p/ caber em `width` colunas de exibição, pondo `…` (1 col) no fim
 * se cortar. Mede por displayWidth (CJK/emoji = 2 cols). Itera por code point p/
 * não partir um par surrogate. `width<=0` ⇒ string vazia.
 */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  // precisa cortar: reserva 1 col p/ o `…`.
  const budget = width - 1;
  let acc = '';
  let used = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (used + w > budget) break;
    acc += ch;
    used += w;
  }
  return acc + '…';
}

/**
 * Pad de `text` até `width` colunas de exibição segundo o alinhamento. Assume que
 * `text` já cabe em `width` (use truncateToWidth antes). left = pad à direita;
 * right = pad à esquerda; center = divide a sobra (extra à direita).
 */
export function padCell(text: string, width: number, align: 'left' | 'center' | 'right'): string {
  const pad = Math.max(0, width - displayWidth(text));
  if (pad === 0) return text;
  if (align === 'right') return ' '.repeat(pad) + text;
  if (align === 'center') {
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + text + ' '.repeat(pad - l);
  }
  return text + ' '.repeat(pad);
}

/**
 * Decide a largura de CADA coluna (em colunas de exibição) p/ uma tabela com `cols`
 * colunas, dados os textos do header + corpo, cabendo em `columns` (largura útil já
 * descontada de qualquer indent). Devolve um array de larguras (mesmo nº de colunas).
 *
 *  • naturalWidth[c] = máx displayWidth de header[c] e de cada rows[r][c].
 *  • total = Σ natural + gutters((cols-1)*COL_GUTTER). Cabe ⇒ usa natural.
 *  • Não cabe ⇒ "water-filling": reduz repetidamente a(s) coluna(s) mais larga(s)
 *    em 1 col até a soma caber, respeitando o piso MIN_COL por coluna.
 *  • `columns<=0` (largura desconhecida) ⇒ usa a natural (sem truncar) — degradação
 *    graciosa, igual ao comportamento "sem wrap conhecido" do resto da TUI.
 */
export function computeColumnWidths(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  cols: number,
  columns: number,
): number[] {
  const natural: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = displayWidth(header[c] ?? '');
    for (const row of rows) w = Math.max(w, displayWidth(row[c] ?? ''));
    natural.push(Math.max(MIN_COL, w));
  }
  if (!columns || columns <= 0) return natural;

  const gutters = cols > 0 ? (cols - 1) * COL_GUTTER : 0;
  const avail = Math.max(cols * MIN_COL, columns - gutters);
  let sum = natural.reduce((a, b) => a + b, 0);
  if (sum <= avail) return natural;

  // Water-filling: a cada passo, encolhe a coluna mais larga (acima do piso) em 1.
  const widths = [...natural];
  let guard = sum * 2 + 10; // teto de segurança contra loop (nunca deve atingir).
  while (sum > avail && guard-- > 0) {
    // acha a coluna mais larga que ainda pode encolher.
    let idx = -1;
    let max = MIN_COL;
    for (let c = 0; c < cols; c++) {
      if (widths[c]! > max) {
        max = widths[c]!;
        idx = c;
      }
    }
    if (idx < 0) break; // todas no piso — não dá p/ encolher mais.
    widths[idx]! -= 1;
    sum -= 1;
  }
  return widths;
}
