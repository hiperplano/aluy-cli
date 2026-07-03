// EST-0988 — WORDMARK compartilhado: a marca grande "Λluy" é FONTE ÚNICA p/ a
// splash (<Boot>) E o banner do header (<Header>). Extraído do Boot (EST-0948) pra
// que as duas telas NUNCA divirjam — uma letra muda aqui, muda nos dois lugares.
//
// EST-0989 — a marca passou de "ALUY" (tudo MAIÚSCULO) p/ "Λluy": o glifo `aluy`
// (Λ — o triângulo-sem-base, A MESMA marca do loader/header/thinking) como o "A",
// em destaque (role `accent`), seguido de "luy" em letras MINÚSCULAS (block-art,
// altura-x menor, na cor de marca `depth`). O Λ aqui é o glifo `aluy` escalado —
// não diverge do <AluyLoader>/<Glyph name="aluy">.
//
// FALLBACK obrigatório (herdado do Boot):
//   - sem Unicode (TERM=linux / locale não-UTF-8 / --ascii) ⇒ wordmark ASCII
//     (`/\` p/ o Λ + `#` p/ "luy") — o `/\` é o MESMO fallback ASCII do glifo `aluy`;
//   - largura < MIN_WORDMARK_COLS ⇒ degrada p/ o nome compacto `Λ luy` (`/\ luy`).
// As cores saem SEMPRE de papel semântico (Λ `accent`, "luy" `depth` — a marca do
// DS), nunca cor crua. É chrome ESTÁTICO: não anima, largura/altura estável
// (anti-flicker EST-0965).

import React from 'react';
import { Box } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import { ALUY_MARK_UNICODE, ALUY_MARK_ASCII } from '../theme/glyphs.js';

/**
 * O Λ grande (block-art, escala 2×) — o glifo `aluy` (a MARCA) como capital. 6
 * linhas (a 6ª é a linha do DESCENDER, vazia p/ o Λ — alinha a grade com "luy",
 * cujo `y` tem perninha). Baseline na 5ª linha (índice 4). Renderizado em `accent`
 * (destaque), separado de "luy" p/ poder colorir a marca diferente do nome.
 *
 * FORMA (F195 — fidelidade ao logo do site): a marca oficial é uma LAMBDA de ÁPICE
 * AFIADO no topo que ABRE (splay) em duas pernas diagonais retas até uma BASE LARGA — a
 * base é bem mais aberta que o meio, os pés vão aos CANTOS (não um triângulo estreito/
 * simétrico "A"). Peso de traço consistente. Grade 14× (PAR — topo LIMPO e simétrico): o
 * ápice cresce `██` (2 células centradas, linha 0) → `████` (4 células, PAR, linha 1) e SÓ
 * então as pernas ABREM (linhas 2-4) até os cantos na baseline (linha 4, ~8 de vão). É um
 * grau menos largo/espalhado que a rodada de base 16 (topo simétrico > largura máxima). 5
 * linhas de corpo; a baseline (índice 4) segue ALINHADA com o "luy". Totalmente simétrica.
 */
export const WORDMARK_MARK_BLOCK: readonly string[] = [
  '      ██      ', // ÁPICE afiado (2 células centradas, no topo — linha 0)
  '     ████     ', // cresce SIMÉTRICO (4 células, par) — topo limpo antes de abrir
  '   ███  ███   ', // o interior ABRE — as duas pernas se separam
  ' ███      ███ ', // pernas espalhando em diagonal (splay)
  '███        ███', // BASELINE (índice 4): pés nos CANTOS — alinha com l/u/y do "luy"
  '              ', // linha do DESCENDER: o Λ não desce; fica vazia p/ alinhar a grade 6×.
];

/**
 * "luy" em block-art MINÚSCULO (altura-x menor: o topo das letras com altura-x — u,
 * y — fica vazio; só o `l` é ascender de corpo inteiro). A grade tem 7 linhas: a
 * BASELINE é a linha 5 (índice 4 — onde `l` e `u` terminam) e as linhas 6-7 (índices
 * 5-6) são o DESCENDER do `y`, ABAIXO da baseline. O `y` tem o RABO CURVADO de verdade
 * (F195, pedido do dono): a haste direita desce abaixo da baseline (linha 5) e o rabo
 * CURVA/GANCHA p/ a ESQUERDA no fim (linha 6) — o gancho arredondado do "y" do logo,
 * não uma haste reta. `l`/`u` deixam as linhas do descender vazias. Cor `depth`.
 */
export const WORDMARK_LUY_BLOCK: readonly string[] = [
  '██                ',
  '██  ██  ██  ██  ██',
  '██  ██  ██  ██  ██',
  '██  ██  ██   █████',
  '██   █████      ██', // BASELINE: l termina, u fecha a tigela, y ainda tem a haste
  '                ██', // DESCENDER 1: a haste do y desce reto abaixo da baseline
  '            █████ ', // DESCENDER 2: o RABO curva/gancha p/ a ESQUERDA (gancho do y)
];

/**
 * Fallback ASCII do Λ: `/\` escalado (o MESMO `/\` do glifo `aluy`). A grade 14× (PAR)
 * espelha a lambda do bloco Unicode — ápice `/\` centrado (linha 0) que ABRE em diagonais
 * retas até uma BASE LARGA (pés nos cantos) na linha 4 (baseline, alinhada com "luy"); a
 * 6ª linha é o descender (vazia p/ o Λ). `accent`.
 */
export const WORDMARK_MARK_ASCII: readonly string[] = [
  '      /\\      ',
  '     /  \\     ',
  '   /      \\   ',
  ' /          \\ ',
  '/            \\',
  '              ', // linha do DESCENDER (vazia p/ o Λ) — alinha a grade 6× com "luy".
];

/**
 * Fallback ASCII de "luy" (`#`), minúsculo, baseline alinhada. O `y` tem o RABO CURVADO
 * (descender de 2 linhas): a haste desce (linha 5) e GANCHA p/ a ESQUERDA no fim (linha 6)
 * — espelha 1:1 o block-art unicode (mesmas colunas, `#` no lugar de `█`). `depth`.
 */
export const WORDMARK_LUY_ASCII: readonly string[] = [
  '##                ',
  '##  ##  ##  ##  ##',
  '##  ##  ##  ##  ##',
  '##  ##  ##   #####',
  '##   #####      ##', // BASELINE
  '                ##', // DESCENDER 1: a haste do y desce reto
  '            ##### ', // DESCENDER 2: o rabo gancha p/ a ESQUERDA
];

/** Espaço (col) entre o Λ e "luy" no wordmark grande. 1 col de respiro (pedido do dono:
 * o "luy" estava longe demais do Λ) — o pé direito do Λ fica a 1 coluna do "luy". PAR com
 * o GAP do <wordmark-3d> (splash 3D) p/ as duas telas não divergirem (FONTE ÚNICA). */
const MARK_GAP = ' ';

/** Largura mínima (col) p/ o wordmark grande. Abaixo disso, nome compacto `Λ luy`. */
export const MIN_WORDMARK_COLS = 28;

/** Altura (linhas) do wordmark grande — usada p/ reservar chrome (anti-flicker). */
export const WORDMARK_ROWS = WORDMARK_MARK_BLOCK.length;

export interface WordmarkProps {
  /** Largura do terminal — abaixo de MIN_WORDMARK_COLS degrada p/ `Λ luy`. */
  readonly columns?: number;
}

/**
 * A MARCA grande "Λluy": Λ (glifo `aluy`, em `accent`) como o "A" + "luy"
 * minúsculo (em `depth`). Unicode `█` ⇒ ASCII `/\`+`#` ⇒ compacto `Λ luy`.
 * PURO/ESTÁTICO: mesma saída p/ a mesma largura+tema (não anima).
 */
export function Wordmark(props: WordmarkProps): React.ReactElement {
  const theme = useTheme();
  const columns = props.columns ?? 80;
  const tooNarrow = columns < MIN_WORDMARK_COLS;
  const mark = theme.unicode ? ALUY_MARK_UNICODE : ALUY_MARK_ASCII;

  if (tooNarrow) {
    // Degradação p/ telas estreitas: Λ (accent) + nome minúsculo (depth), 1 linha.
    return (
      <Box>
        <Role name="accent">{mark}</Role>
        <Role name="accent"> luy</Role>
      </Box>
    );
  }

  const markRows = theme.unicode ? WORDMARK_MARK_BLOCK : WORDMARK_MARK_ASCII;
  const luyRows = theme.unicode ? WORDMARK_LUY_BLOCK : WORDMARK_LUY_ASCII;

  // Λ (accent) e "luy" (depth) lado a lado — duas colunas pra colorir a marca
  // diferente do nome. Baseline já alinhada nas grades (última linha).
  return (
    <Box flexDirection="row">
      <Box flexDirection="column">
        {markRows.map((line, i) => (
          <Role key={i} name="accent">
            {line}
          </Role>
        ))}
      </Box>
      <Box flexDirection="column">
        {luyRows.map((line, i) => (
          <Role key={i} name="accent">
            {MARK_GAP + line}
          </Role>
        ))}
      </Box>
    </Box>
  );
}
