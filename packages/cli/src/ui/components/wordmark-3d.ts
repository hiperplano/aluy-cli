// F198 — SHIMMER/GLINT do wordmark `Λluy` no SPLASH (pedido do dono): TROCA o antigo
// "pisca-pisca" (a sombra que respirava ░▒▓▒ com o frame — o único estado de cor que
// alternava, lido como blink) por um BRILHO que DESLIZA da ESQUERDA p/ a DIREITA sobre a
// marca, em laço — uma luz varrendo o logo, mais elegante que o pisca.
//
// É EXCLUSIVO da <SplashScreen> — o <Wordmark> compartilhado (splash + HEADER) segue
// ESTÁTICO (anti-flicker EST-0965): animar a marca no header seria ruído. Aqui, só na
// tela de boot, a marca ganha PROFUNDIDADE (uma drop-shadow ↓→1) + o glint horizontal.
//
// COMO O BRILHO VARRE (função pura `shimmerAt`, handoff §10.1 — igual ao `pulseLit` do
// <BusyPulse>): a "cabeça" do brilho é uma COLUNA que anda com o `frame` do tick central
//   head = (frame · SHIMMER_SPEED) mod (width + SHIMMER_TAIL)
// varrendo da col 0 até a última coluna da marca e recomeçando. `SHIMMER_TAIL` é a margem
// de respiro no fim (o logo repousa calmo em `fg` — a base BRANCA — por alguns frames antes
// de o brilho reentrar pela esquerda — laço com pausa, não uma faixa colada). A intensidade
// de cada coluna é o quão PERTO ela está da cabeça (degradê suave, não uma coluna só acesa):
//   · |col−head| ≤ SHIMMER_PEAK ⇒ PICO   → papel `accent`    (âmbar-400, o mais claro/vivo)
//   · |col−head| ≤ SHIMMER_HALO ⇒ HALO    → papel `accentMid` (âmbar-500 — degradê em volta)
//   · senão                     ⇒ FORA    → papel `fg`        (BRANCO — a base/repouso do logo)
// A marca em REPOUSO é BRANCA (`fg`, o papel de texto do tema); o BRILHO ÂMBAR (accent/
// accentMid) desliza por cima dela, por PAPEL do tema — NUNCA cor crua (pedido do dono: o
// wordmark é branco, a luz que varre é que é âmbar).
//
// ANTI-FLICKER (EST-0965 / EST-0956 / #95 / #118): a grade tem LARGURA e ALTURA CONSTANTES
// entre frames — o `char` de cada célula (marca `█`, sombra `▒`, vazio ` `) NUNCA muda com o
// frame; SÓ o PAPEL (a cor) de cada célula da marca muda. Nada aparece/some, nada cresce ou
// encolhe: o splash NÃO reflui. (Por isso a sombra deixou de respirar — o tom dela agora é
// FIXO; o movimento vive só na COR da marca.)
//
// REDUCED-MOTION (`theme.animate===false`, a11y §6): SEM shimmer — a marca fica ESTÁTICA no
// tom de BASE (`fg`, branco), coerente com o repouso: sem brilho, o logo é só a marca branca,
// pois o movimento nunca carrega significado sozinho. O caller (SplashScreen) já cai no
// <Wordmark> estático quando `!animate`; ainda assim `composeShadowedWordmark(frame, animate)`
// honra o gate (marca toda `fg`) p/ ser robusto e testável como função pura.
//
// PURO (ADR-0053 §8): só compõe uma grade de células {role,char}. Sem Ink/IO/tempo real (o
// `frame` chega por prop, handoff §10.1). Fallback: sem Unicode (ascii) NÃO há 3D (o `█` é a
// base do efeito) ⇒ o caller usa o <Wordmark> estático (que já degrada p/ `/\`+`#`).

import { WORDMARK_MARK_BLOCK, WORDMARK_LUY_BLOCK } from './Wordmark.js';

/** Caractere de preenchimento da marca (block-art). */
const FILL = '█';
/** Coluna(s) entre o Λ e "luy" — espelha o MARK_GAP do <Wordmark> (1 col de respiro). */
const GAP = ' ';

/**
 * Tom FIXO da drop-shadow (▒, meio-tom). ANTES a sombra CICLAVA ░▒▓▒ com o frame — era esse
 * o "pisca" que o dono pediu p/ tirar. Agora a sombra é chrome ESTÁTICO (tom constante entre
 * frames): dá profundidade 3D sem introduzir NENHUM movimento próprio (o brilho vive só na
 * marca). Mantido como constante nomeada p/ o teste e p/ uma eventual afinação.
 */
export const SHADOW_SHADE = '▒';

/**
 * Velocidade do brilho: quantas COLUNAS a cabeça anda por frame. O tick do splash é lento
 * (~320ms), então 1 col/frame varreria o logo em ~12s (glacial) — 3 col/frame dá um laço
 * calmo de ~4s, ainda legível como um deslize (o halo largo cobre os saltos, ver abaixo).
 * Afinável: ↑ mais rápido, ↓ mais suave.
 */
export const SHIMMER_SPEED = 3;

/** Meia-largura da BANDA de PICO (`accent`): `SHIMMER_PEAK*2+1` colunas no auge do brilho. */
export const SHIMMER_PEAK = 1;

/**
 * Meia-largura do HALO (`depth`) em volta do pico — o degradê suave. Escolhido MAIOR que
 * `SHIMMER_SPEED` de propósito: como a cabeça salta `SHIMMER_SPEED` colunas por frame, um halo
 * mais largo faz os brilhos de frames consecutivos se SOBREPOREM ⇒ o olho lê um DESLIZE
 * contínuo, não uma luz "pulando" de coluna em coluna (suaviza os saltos do tick lento).
 */
export const SHIMMER_HALO = 4;

/**
 * Margem ESCURA no fim do ciclo (colunas "fantasma" além da largura da marca): enquanto a
 * cabeça as percorre, NENHUMA coluna real está no brilho ⇒ o logo repousa todo em `accentDim`
 * por alguns frames. É a PAUSA calma entre varreduras (laço com respiro), > `SHIMMER_HALO` p/
 * a saída pela direita ser completa antes da reentrada pela esquerda.
 */
export const SHIMMER_TAIL = 8;

/** Intensidade do brilho numa coluna: 2=pico (`accent`) · 1=halo (`accentMid`) · 0=fora/repouso (`fg`). */
export type ShimmerLevel = 0 | 1 | 2;

/** Papéis (cores do tema) da marca: `fg` é a base BRANCA de repouso; `accent`/`accentMid` são
 * o brilho ÂMBAR que varre por cima. */
export type ShimmerRole = 'accent' | 'accentMid' | 'accentDim' | 'fg';

/** Uma célula da grade composta: o papel do DS + o glifo. `null` = vazio (espaço). */
export interface Cell {
  readonly role: ShimmerRole | null;
  readonly char: string;
}

/**
 * A COLUNA da "cabeça" do brilho para um `frame`, varrendo `0 … width+SHIMMER_TAIL-1` e
 * recomeçando. PURO. `frame` negativo/não-finito é normalizado (fail-safe). A cabeça anda
 * `SHIMMER_SPEED` colunas por frame; o período inclui a `SHIMMER_TAIL` (pausa escura).
 */
export function shimmerHead(frame: number, width: number): number {
  const w = Math.max(1, Math.trunc(width));
  const period = w + SHIMMER_TAIL;
  const f = Number.isFinite(frame) ? Math.trunc(frame) : 0;
  return (((f * SHIMMER_SPEED) % period) + period) % period;
}

/**
 * A INTENSIDADE do brilho na coluna `col` para um `frame` (o coração do efeito). Deriva da
 * distância da coluna à cabeça do brilho: pico no centro, halo suave em volta, escuro fora.
 * PURO. Quando a cabeça está na margem `SHIMMER_TAIL` (além de `width`), toda coluna real
 * fica FORA ⇒ nível 0 (a pausa calma). `frame`/`col`/`width` não-finitos são normalizados.
 */
export function shimmerAt(col: number, frame: number, width: number): ShimmerLevel {
  const head = shimmerHead(frame, width);
  const c = Number.isFinite(col) ? Math.trunc(col) : 0;
  const dist = Math.abs(c - head);
  if (dist <= SHIMMER_PEAK) return 2; // pico — âmbar mais claro
  if (dist <= SHIMMER_HALO) return 1; // halo — degradê em volta
  return 0; // fora do brilho — âmbar calmo (logo em repouso)
}

/** Mapeia a intensidade do brilho p/ o PAPEL do tema (nunca cor crua). PURO.
 * Nível 0 (fora do brilho) é a BASE de repouso do logo: `fg` (BRANCO) — o brilho ÂMBAR
 * (accent/accentMid) varre por cima dessa base (pedido do dono). */
export function shimmerRole(level: ShimmerLevel): ShimmerRole {
  if (level === 2) return 'accent';
  if (level === 1) return 'accentMid'; // halo = âmbar-500 (degradê ÂMBAR, sem teal — pedido do dono)
  return 'fg'; // fora do brilho — base BRANCA do logo em repouso
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
 * Compõe a grade do wordmark COM sombra 3D e o BRILHO horizontal para um dado `frame`. Cada
 * célula é a marca (`█`, cor pelo brilho da sua COLUNA via `shimmerAt`), uma sombra (`depth`,
 * tom FIXO `SHADOW_SHADE`, deslocada ↓→1) ou vazia. A sombra de (r,c) acende quando a célula
 * ACIMA-À-ESQUERDA (r-1,c-1) é preenchida e a própria (r,c) NÃO é (a marca vence a sombra).
 * Grade = (linhas+1) × (largura+1), ESTÁVEL entre frames (anti-flicker: só a COR da marca muda).
 *
 * `animate` (default true): reduced-motion (`false`) ⇒ SEM brilho — a marca inteira sai em
 * `accent` (realce estático), o movimento não carrega significado sozinho (a11y §6). PURO.
 */
export function composeShadowedWordmark(frame: number, animate = true): Cell[][] {
  const mark = combinedMarkRows();
  const height = mark.length;
  const width = mark.reduce((m, line) => Math.max(m, line.length), 0);

  const filled = (r: number, c: number): boolean => (mark[r]?.[c] ?? ' ') === FILL;
  // Papel da célula da marca na coluna `c`: com animação, deriva do brilho que varre; em
  // reduced-motion, `fg` fixo (logo branco ESTÁTICO, coerente com a base de repouso).
  const markRole = (c: number): ShimmerRole =>
    animate ? shimmerRole(shimmerAt(c, frame, width)) : 'fg';

  const grid: Cell[][] = [];
  for (let r = 0; r < height + 1; r += 1) {
    const row: Cell[] = [];
    for (let c = 0; c < width + 1; c += 1) {
      if (filled(r, c)) {
        row.push({ role: markRole(c), char: FILL });
      } else if (filled(r - 1, c - 1)) {
        // sombra projetada ↓→ pela célula da marca acima-à-esquerda (tom FIXO — não respira).
        // Sombra 3D em âmbar ESCURO (accentDim) — fica como está mesmo com a marca agora
        // branca (`fg`) em repouso: a sombra NÃO acompanha a mudança de cor da base, só o
        // brilho (accent/accentMid) varre por cima do branco. Contraste com a marca vem do
        // CHAR (`▒` sombra vs `█` marca).
        row.push({ role: 'accentDim', char: SHADOW_SHADE });
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
export function rowSegments(row: readonly Cell[]): { role: ShimmerRole | null; text: string }[] {
  const segs: { role: ShimmerRole | null; text: string }[] = [];
  for (const cell of row) {
    const last = segs[segs.length - 1];
    if (last && last.role === cell.role) last.text += cell.char;
    else segs.push({ role: cell.role, text: cell.char });
  }
  return segs;
}
