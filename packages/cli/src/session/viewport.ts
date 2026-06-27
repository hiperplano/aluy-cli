// EST-1000 · ADR-0076 §4 — VIEWPORT/scroll PRÓPRIO de uma região gerida (PURO, testável).
//
// Como a conversa e o log NÃO vivem mais no scrollback NATIVO do terminal (perde-se em
// alt-screen, ADR-0076 §4), cada região precisa de scroll PRÓPRIO: pgup/pgdn/↑↓ rolam
// um OFFSET sobre as linhas da região, com indicador "N acima/abaixo". Esta é a
// aritmética pura desse offset — sem React, sem I/O, espelhando a mecânica do
// `<ActivityLog>` (cauda + scrollOffset) generalizada p/ qualquer região.
//
// CONVENÇÃO (igual ao ActivityLog): `offset === 0` = COLADO NA CAUDA (o fim, "ao vivo");
// crescer o offset rola p/ CIMA (vê linhas mais antigas). O offset é CLAMPADO em
// `[0, maxOffset]` onde `maxOffset = max(0, total - visible)`. Acima do topo não rola.

/** Quanto uma tecla move o offset. ↑/↓ = 1 linha; pgup/pgdn = uma "página" (visible-1). */
export type ScrollKey = 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end';

/** A janela visível resolvida: o intervalo de linhas a exibir + os indicadores. */
export interface Viewport {
  /** Índice da 1ª linha visível (inclusive). */
  readonly start: number;
  /** Índice após a última linha visível (exclusive). */
  readonly end: number;
  /** Quantas linhas estão ESCONDIDAS acima da janela (indicador `↑N`). */
  readonly hiddenAbove: number;
  /** Quantas linhas estão ESCONDIDAS abaixo (indicador `↓N`; 0 ⇒ colado na cauda). */
  readonly hiddenBelow: number;
  /** O offset EFETIVO (clampado) — útil p/ o caller persistir o estado coerente. */
  readonly offset: number;
}

/**
 * Resolve a janela visível da CAUDA p/ `total` linhas, `visible` linhas de altura e um
 * `offset` (0 = cauda). CLAMPA o offset em `[0, total-visible]`. Determinístico.
 *
 * Espelha o `<ActivityLog>`: `end = total - offset`, `start = max(0, end - visible)`.
 */
export function resolveViewport(total: number, visible: number, offset: number): Viewport {
  const room = Math.max(0, visible);
  const maxOffset = Math.max(0, total - room);
  const off = Math.min(Math.max(0, Math.trunc(offset)), maxOffset);
  const end = total - off;
  const start = Math.max(0, end - room);
  return {
    start,
    end,
    hiddenAbove: start,
    hiddenBelow: total - end,
    offset: off,
  };
}

/**
 * Aplica uma tecla de scroll ao offset corrente, devolvendo o NOVO offset clampado.
 * PURO. `visible` define o passo de página (uma página = visible-1, p/ manter 1 linha
 * de contexto entre páginas, como num pager).
 *
 *  · `up`/`down`     — ±1 (down em direção à cauda, ou seja, DIMINUI o offset).
 *  · `pageUp`/`Down` — ±(visible-1).
 *  · `home`          — topo absoluto (offset = total - visible, máximo).
 *  · `end`           — cauda (offset = 0, "ao vivo").
 */
export function scrollOffset(
  key: ScrollKey,
  offset: number,
  total: number,
  visible: number,
): number {
  const room = Math.max(1, visible);
  const page = Math.max(1, room - 1);
  const maxOffset = Math.max(0, total - room);
  let next = offset;
  switch (key) {
    case 'up':
      next = offset + 1; // p/ CIMA = vê linhas mais antigas = MAIOR offset.
      break;
    case 'down':
      next = offset - 1; // p/ BAIXO = em direção à cauda = MENOR offset.
      break;
    case 'pageUp':
      next = offset + page;
      break;
    case 'pageDown':
      next = offset - page;
      break;
    case 'home':
      next = maxOffset;
      break;
    case 'end':
      next = 0;
      break;
  }
  return Math.min(Math.max(0, next), maxOffset);
}
