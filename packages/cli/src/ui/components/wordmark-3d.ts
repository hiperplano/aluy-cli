// Splash "3D": SOMBRA ANSI ANIMADA sob o wordmark `Λluy` (pedido do dono). É
// EXCLUSIVO da <SplashScreen> — o <Wordmark> compartilhado (splash + HEADER) segue
// ESTÁTICO (anti-flicker EST-0965): animar a marca no header seria ruído. Aqui, só
// na tela de boot, damos PROFUNDIDADE: uma drop-shadow deslocada (↓→ 1 célula) que
// "respira" — o TOM da sombra cicla ░ → ▒ → ▓ → ▒ com o `frame` do tick central.
//
// Por que respirar o TOM (e não mover a sombra): mudar o OFFSET a cada frame moveria
// células e causaria jitter/flicker. Variar só a INTENSIDADE da sombra (mesmas
// células) dá a sensação de luz viva sem redesenhar a marca — calmo, estável.
//
// PURO (ADR-0053 §8): só compõe uma grade de células {role,char}. Sem Ink/IO/tempo
// real (o `frame` chega por prop, handoff §10.1). Cores SEMPRE por papel do DS
// (`accent` p/ a marca, `depth` p/ a sombra) — nunca cor crua. Fallback: sem Unicode
// (ascii) NÃO há 3D (o `█` é a base do efeito) ⇒ o caller usa o <Wordmark> estático.

import { WORDMARK_MARK_BLOCK, WORDMARK_LUY_BLOCK } from './Wordmark.js';

/** Caractere de preenchimento da marca (block-art). */
const FILL = '█';
/** Coluna(s) entre o Λ e "luy" — espelha o MARK_GAP do <Wordmark>. */
const GAP = '  ';

/** Tons da sombra, do mais sutil ao mais denso — o ciclo "respira" por eles. */
export const SHADOW_SHADES = ['░', '▒', '▓'] as const;

/** Uma célula da grade composta: o papel do DS + o glifo. `null` = vazio (espaço). */
export interface Cell {
  readonly role: 'accent' | 'depth' | null;
  readonly char: string;
}

/**
 * O TOM da sombra em função do `frame` (respiração ░▒▓▒ em laço de 4). PURO. Cadência
 * lenta (deriva do tick ~8fps) ⇒ pulso calmo. `frame` negativo é normalizado.
 */
export function shadowShade(frame: number): string {
  // Laço de 4 passos: 0=░ 1=▒ 2=▓ 3=▒ (sobe e desce — respira, não "pula" de ▓ p/ ░).
  const cycle = [0, 1, 2, 1];
  const n = ((Math.trunc(frame) % cycle.length) + cycle.length) % cycle.length;
  return SHADOW_SHADES[cycle[n]!]!;
}

/** As linhas combinadas (Λ + GAP + luy) da marca block-art, como strings. */
function combinedMarkRows(): string[] {
  const rows = Math.max(WORDMARK_MARK_BLOCK.length, WORDMARK_LUY_BLOCK.length);
  const out: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    out.push(`${WORDMARK_MARK_BLOCK[r] ?? ''}${GAP}${WORDMARK_LUY_BLOCK[r] ?? ''}`);
  }
  return out;
}

/**
 * Compõe a grade do wordmark COM sombra 3D para um dado `frame`. Cada célula é a
 * marca (`accent` `█`), uma sombra (`depth`, tom que respira, deslocada ↓→1) ou vazia.
 * A sombra de (r,c) acende quando a célula ACIMA-À-ESQUERDA (r-1,c-1) é preenchida e a
 * própria (r,c) NÃO é (a marca vence a sombra). Grade = (linhas+1) × (largura+1).
 * PURO: mesma entrada ⇒ mesma saída.
 */
export function composeShadowedWordmark(frame: number): Cell[][] {
  const mark = combinedMarkRows();
  const height = mark.length;
  const width = mark.reduce((m, line) => Math.max(m, line.length), 0);
  const shade = shadowShade(frame);

  const filled = (r: number, c: number): boolean => (mark[r]?.[c] ?? ' ') === FILL;

  const grid: Cell[][] = [];
  for (let r = 0; r < height + 1; r += 1) {
    const row: Cell[] = [];
    for (let c = 0; c < width + 1; c += 1) {
      if (filled(r, c)) {
        row.push({ role: 'accent', char: FILL });
      } else if (filled(r - 1, c - 1)) {
        // sombra projetada ↓→ pela célula da marca acima-à-esquerda.
        row.push({ role: 'depth', char: shade });
      } else {
        row.push({ role: null, char: ' ' });
      }
    }
    grid.push(row);
  }
  return grid;
}

/**
 * Agrupa uma linha de células em SEGMENTOS consecutivos de MESMO papel (p/ a UI emitir
 * um <Text> por papel, não um por célula). PURO. Células vazias viram segmento `null`.
 */
export function rowSegments(row: readonly Cell[]): { role: 'accent' | 'depth' | null; text: string }[] {
  const segs: { role: 'accent' | 'depth' | null; text: string }[] = [];
  for (const cell of row) {
    const last = segs[segs.length - 1];
    if (last && last.role === cell.role) last.text += cell.char;
    else segs.push({ role: cell.role, text: cell.char });
  }
  return segs;
}
