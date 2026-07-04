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
// ESCURA de respiro no fim (o logo repousa calmo em `accentDim` por alguns frames antes de
// o brilho reentrar pela esquerda — laço com pausa, não uma faixa colada). A intensidade de
// cada coluna é o quão PERTO ela está da cabeça (degradê suave, não uma coluna só acesa):
//   · |col−head| ≤ SHIMMER_PEAK ⇒ PICO   → papel `accent`    (âmbar-400, o mais claro/vivo)
//   · |col−head| ≤ SHIMMER_HALO ⇒ HALO    → papel `accentMid` (âmbar-500 — degradê em volta)
//   · senão                     ⇒ FORA    → papel `accentDim` (âmbar calmo — o logo em repouso)
// A marca é ÂMBAR (accent/accentMid/accentDim); o brilho "acende na cabeça e esmaece em
// volta", varrendo o logo, por PAPEL do tema — NUNCA cor crua.
//
// F200c — SOMBRA SINCRONIZADA, em ÂMBAR ESCURO (pedido do dono; F200b tinha sido TEAL, o
// dono preferiu âmbar). A sombra 3D é da MESMA família ÂMBAR da marca, mas distintamente
// MAIS ESCURA que ela (pra ainda ler como SOMBRA), e a MESMA luz que varre a marca atravessa
// a sombra na mesma passada: cada célula de sombra em (r,c) é projetada pela célula da marca
// em (r−1,c−1) (↓→1) — então ela usa o `shimmerAt` daquela COLUNA-FONTE (c−1) p/ escolher o
// SEU próprio degradê ÂMBAR-ESCURO (abaixo do âmbar da marca):
//   · PICO/HALO (nível 2/1) → papel `shadowAmber`    (âmbar-600 escuro — a sombra "acesa")
//   · FORA      (nível 0)   → papel `shadowAmberDim` (âmbar mais escuro — sombra em repouso)
// O tom LIT da sombra (`shadowAmber` = âmbar-600) é o tom MAIS ESCURO que a MARCA usa
// (accentDim), então no MESMO ponto do brilho a sombra é sempre ≤ a marca ⇒ lê como sombra.
// A banda "acesa" da sombra (pico+halo) casa com a região clara da marca (accent+accentMid),
// então MARCA e SOMBRA clareiam JUNTAS onde a luz passa — a luz atravessa as duas na mesma
// varredura, agora as duas em ÂMBAR (contraste por LUMINÂNCIA: marca clara, sombra escura —
// não mais por matiz).
//
// ANTI-FLICKER (EST-0965 / EST-0956 / #95 / #118): a grade tem LARGURA e ALTURA CONSTANTES
// entre frames — o `char` de cada célula (marca `█`, sombra `▒`, vazio ` `) NUNCA muda com o
// frame; SÓ o PAPEL (a cor) de cada célula muda (marca E, agora, sombra). Nada aparece/some,
// nada cresce ou encolhe: o splash NÃO reflui.
//
// REDUCED-MOTION (`theme.animate===false`, a11y §6): SEM shimmer — a marca fica ESTÁTICA num
// tom de realce fixo (`accent`, o logo "aceso") e a SOMBRA fica ESTÁTICA em `shadowAmber` (o
// âmbar escuro médio, sem degradê), pois o movimento nunca carrega significado sozinho. O
// caller (SplashScreen) já cai no <Wordmark> estático quando `!animate`; ainda assim
// `composeShadowedWordmark(frame, animate)` honra o gate (marca toda `accent`, sombra toda
// `shadowAmber`) p/ ser robusto e testável como função pura.
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
 * GLIFO fixo da drop-shadow (▒, meio-tom). ANTES a sombra CICLAVA ░▒▓▒ com o frame — era esse
 * o "pisca" que o dono pediu p/ tirar. O CHAR nunca muda (anti-flicker); é a COR (o papel)
 * que agora shimmeia em sincronia com a marca (F200c, âmbar escuro) — ver `shadowRole`/`composeShadowedWordmark`.
 * Mantido como constante nomeada p/ o teste e p/ uma eventual afinação.
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
 * Meia-largura do HALO (`accentMid`) em volta do pico — o degradê suave. Escolhido MAIOR que
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

/** Intensidade do brilho numa coluna: 2=pico (`accent`) · 1=halo (`accentMid`) · 0=fora (`accentDim`). */
export type ShimmerLevel = 0 | 1 | 2;

/** Papéis (cores do tema) da grade: o degradê ÂMBAR da MARCA (accent/accentMid/accentDim,
 * mesma escala do <BusyPulse>) + o degradê ÂMBAR-ESCURO da SOMBRA 3D (shadowAmber/
 * shadowAmberDim, F200c — mesma família, luminância abaixo da marca). Por PAPEL — nunca
 * cor crua. */
export type ShimmerRole =
  | 'accent'
  | 'accentMid'
  | 'accentDim'
  | 'shadowAmber'
  | 'shadowAmberDim';

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
 * Nível 0 (fora do brilho) é a BASE de repouso do logo: `accentDim` (âmbar escuro) — o
 * brilho ÂMBAR (accent/accentMid) varre por cima dessa base âmbar. */
export function shimmerRole(level: ShimmerLevel): ShimmerRole {
  if (level === 2) return 'accent';
  if (level === 1) return 'accentMid'; // halo = âmbar-500 (degradê ÂMBAR, sem teal)
  return 'accentDim'; // fora do brilho — âmbar calmo (logo em repouso)
}

/**
 * F200c — mapeia a MESMA intensidade de brilho (`shimmerAt` da coluna-fonte da sombra) p/ o
 * degradê ÂMBAR-ESCURO do tema (nunca cor crua). A luz que acende a marca em âmbar-claro
 * acende a sombra em âmbar-escuro, na mesma passada. Degradê de 2 tons: a banda LIT (pico E
 * halo) casa com a região clara da marca (accent+accentMid) ⇒ marca e sombra clareiam juntas
 * na mesma faixa; fora dela a sombra repousa no tom mais escuro. PURO.
 */
export function shadowRole(level: ShimmerLevel): ShimmerRole {
  // pico E halo = a sombra "acesa" (âmbar-600, o tom mais escuro que a MARCA usa ⇒ a sombra
  // é sempre ≤ a marca no mesmo ponto do brilho); a banda casa com accent+accentMid da marca.
  if (level >= 1) return 'shadowAmber';
  return 'shadowAmberDim'; // fora do brilho — âmbar mais escuro ainda (sombra em repouso)
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
 * célula é a marca (`█`, cor pelo brilho da sua COLUNA via `shimmerAt` + `shimmerRole`), uma
 * sombra (`▒`, cor pelo MESMO brilho da coluna-FONTE via `shadowRole`, F200c) ou vazia. A
 * sombra de (r,c) acende quando a célula ACIMA-À-ESQUERDA (r-1,c-1) é preenchida e a própria
 * (r,c) NÃO é (a marca vence a sombra). Grade = (linhas+1) × (largura+1), ESTÁVEL entre frames
 * (anti-flicker: só o PAPEL/cor muda — de marca E, agora, de sombra).
 *
 * `animate` (default true): reduced-motion (`false`) ⇒ SEM shimmer — a marca inteira sai em
 * `accent` (realce estático) e a sombra inteira em `shadowAmber` (o âmbar escuro médio, sem
 * degradê), o movimento não carrega significado sozinho (a11y §6). PURO.
 */
export function composeShadowedWordmark(frame: number, animate = true): Cell[][] {
  const mark = combinedMarkRows();
  const height = mark.length;
  const width = mark.reduce((m, line) => Math.max(m, line.length), 0);

  const filled = (r: number, c: number): boolean => (mark[r]?.[c] ?? ' ') === FILL;
  // Papel da célula da marca na coluna `c`: com animação, deriva do brilho que varre; em
  // reduced-motion, `accent` fixo (logo âmbar aceso, ESTÁTICO, sem shimmer).
  const markRole = (c: number): ShimmerRole =>
    animate ? shimmerRole(shimmerAt(c, frame, width)) : 'accent';
  // F200c — papel da célula de SOMBRA cuja fonte é a coluna `srcCol` (a coluna da MARCA que a
  // projeta, r-1,c-1): com animação, o MESMO shimmerAt() da marca — mas mapeado no degradê
  // ÂMBAR-ESCURO (`shadowRole`), abaixo do âmbar da marca — sincronizando a luz que atravessa
  // marca E sombra na mesma passada; em reduced-motion, `shadowAmber` fixo (âmbar escuro
  // médio, sombra ESTÁTICA).
  const shadowRoleAt = (srcCol: number): ShimmerRole =>
    animate ? shadowRole(shimmerAt(srcCol, frame, width)) : 'shadowAmber';

  const grid: Cell[][] = [];
  for (let r = 0; r < height + 1; r += 1) {
    const row: Cell[] = [];
    for (let c = 0; c < width + 1; c += 1) {
      if (filled(r, c)) {
        row.push({ role: markRole(c), char: FILL });
      } else if (filled(r - 1, c - 1)) {
        // sombra projetada ↓→ pela célula da marca acima-à-esquerda (coluna-fonte c-1): usa o
        // shimmer DAQUELA coluna p/ escolher o tom ÂMBAR-ESCURO (shadowAmber/shadowAmberDim) —
        // a sombra é o mesmo pixel da marca, deslocado, então shimmeia com a MESMA intensidade
        // de quem a projeta. MESMA família âmbar da marca (accent/accentMid/accentDim), porém
        // MAIS ESCURA: o contraste com a marca vem da LUMINÂNCIA e do CHAR (`▒` sombra vs `█`
        // marca) — nunca do CHAR mudando (anti-flicker).
        row.push({ role: shadowRoleAt(c - 1), char: SHADOW_SHADE });
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
