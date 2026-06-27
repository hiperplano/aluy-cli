// F88 (anti-flicker) — `windowAround`: a JANELA deslizante compartilhada dos overlays.
//
// Vários overlays/pickers (SlashMenu à parte — ele é ciente de altura) listam coleções
// que podem crescer (sessões, checkpoints, providers, nós da árvore, grants). Sem teto,
// num inline a lista despeja inteira ⇒ a região dinâmica passa de `rows` ⇒ o Ink entra no
// caminho full-screen (`outputHeight>=rows` em `ink.js`, `clearTerminal` por frame) ⇒
// flicker (visível sobretudo no console do Windows). Esta função recorta a coleção numa
// janela de `maxRows` itens CENTRADA no selecionado, e o componente desenha indicadores
// de "↑N/↓N" (ou "… N a mais") pelo `start`/tamanho do slice.
//
// PURA (sem Ink/React) — testável isolada; era duplicada em CommandPalette/FilePicker e nos
// pickers novos (History/Rewind/Provider), no FlowTreeView e no PermissionsPanel. Uma só
// fonte agora. Os callers fazem `Math.max(1, …)` no `maxRows` antes de chamar.

/** Uma janela: o sub-conjunto visível + o índice absoluto do 1º item visível. */
export interface ListWindow<T> {
  /** Índice ABSOLUTO (na coleção original) do 1º item do `slice` — base p/ `↑N` e a seleção. */
  readonly start: number;
  /** O sub-conjunto visível (≤ `maxRows` itens). */
  readonly slice: readonly T[];
}

/**
 * Janela CENTRADA no `selected`. Dois modos:
 *
 *  · SEM `rowHeight` (default) — janela de `maxRows` ITENS (estilo `windowOf` da paleta).
 *    Caminho histórico, INALTERADO.
 *
 *  · COM `rowHeight` (F89/wrap-aware) — `maxRows` é um orçamento de LINHAS VISUAIS, e a
 *    janela empacota itens em torno do `selected` enquanto a soma das alturas (`rowHeight`)
 *    couber. Resolve o estouro em terminais ESTREITOS (cols < ~80): lá cada entrada QUEBRA
 *    em ≥2 linhas visuais, então contar ITENS subestimava a altura ⇒ a região estourava
 *    `rows` ⇒ flicker. Em telas largas, `rowHeight` devolve 1 p/ cada entrada ⇒ a janela é
 *    IDÊNTICA ao caminho por-item (provado: a expansão alternada up-first com altura 1 dá o
 *    mesmo `start` do `selected - floor(maxRows/2)`), então o caso comum fica intacto.
 *
 * Quando tudo cabe devolve a coleção inteira (`start: 0`). `selected` fora de [0, len) é
 * tolerado (clampa). PURA.
 */
export function windowAround<T>(
  items: readonly T[],
  selected: number,
  maxRows: number,
  rowHeight?: (item: T) => number,
): ListWindow<T> {
  if (rowHeight === undefined) {
    // ── caminho por-ITEM (histórico, inalterado) ──────────────────────────────
    if (items.length <= maxRows) return { start: 0, slice: items };
    let start = selected - Math.floor(maxRows / 2);
    if (start < 0) start = 0;
    if (start + maxRows > items.length) start = items.length - maxRows;
    return { start, slice: items.slice(start, start + maxRows) };
  }

  // ── caminho por-LINHA-VISUAL (wrap-aware) ───────────────────────────────────
  const n = items.length;
  if (n === 0) return { start: 0, slice: items };
  const h = (i: number): number => Math.max(1, Math.floor(rowHeight(items[i]!)));
  let total = 0;
  for (let i = 0; i < n; i += 1) total += h(i);
  if (total <= maxRows) return { start: 0, slice: items };

  const sel = Math.max(0, Math.min(selected, n - 1));
  let start = sel;
  let end = sel + 1; // [start, end)
  let used = h(sel); // ao menos o selecionado (mesmo se > maxRows: 1 item clipado)
  // Expansão ALTERNADA (up-first) — espelha `windowSlashEntries`; com altura 1 reproduz
  // EXATAMENTE o `floor`-centramento do caminho por-item (logo cols≥80 fica byte-a-byte).
  let goUp = true;
  let grew = true;
  while (grew) {
    grew = false;
    const tryUp = (): boolean => {
      if (start > 0 && used + h(start - 1) <= maxRows) {
        start -= 1;
        used += h(start);
        return true;
      }
      return false;
    };
    const tryDown = (): boolean => {
      if (end < n && used + h(end) <= maxRows) {
        used += h(end);
        end += 1;
        return true;
      }
      return false;
    };
    grew = goUp ? tryUp() || tryDown() : tryDown() || tryUp();
    goUp = !goUp;
  }
  return { start, slice: items.slice(start, end) };
}
