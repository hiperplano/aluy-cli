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
 */
export const WORDMARK_MARK_BLOCK: readonly string[] = [
  '  ██   ',
  ' ████  ',
  ' ██ ██ ',
  '██   ██',
  '██   ██',
  '       ', // linha do DESCENDER: o Λ não desce; fica vazia p/ alinhar a grade 6×.
];

/**
 * "luy" em block-art MINÚSCULO (altura-x menor: o topo das letras com altura-x — u,
 * y — fica vazio; só o `l` é ascender de corpo inteiro). A grade tem 6 linhas: a
 * BASELINE é a linha 5 (índice 4 — onde `l` e `u` terminam) e a linha 6 (índice 5)
 * é a do DESCENDER, ABAIXO da baseline. O `y` tem a PERNINHA de verdade: a haste
 * direita não para na baseline — desce uma linha além (o rabo do y, como em fonte
 * real). `l`/`u` deixam a linha do descender vazia. Cor `depth` (a marca do DS).
 */
export const WORDMARK_LUY_BLOCK: readonly string[] = [
  '██                ',
  '██  ██  ██  ██  ██',
  '██  ██  ██  ██  ██',
  '██  ██  ██   █████',
  '██   █████      ██', // BASELINE: l termina, u fecha a tigela, y ainda tem a haste
  '                ██', // DESCENDER: só o y desce (a perninha abaixo da baseline)
];

/**
 * Fallback ASCII do Λ: `/\` escalado (o MESMO `/\` do glifo `aluy`). 5 linhas,
 * baseline na última. `accent`.
 */
export const WORDMARK_MARK_ASCII: readonly string[] = [
  '  /\\  ',
  ' /  \\ ',
  '/    \\',
  '/    \\',
  '/    \\',
  '      ', // linha do DESCENDER (vazia p/ o Λ) — alinha a grade 6× com "luy".
];

/**
 * Fallback ASCII de "luy" (`#`), minúsculo, baseline alinhada. O `y` tem a PERNINHA
 * (descender) na 6ª linha, ABAIXO da baseline — espelha 1:1 o block-art unicode
 * (mesmas colunas, `#` no lugar de `█`). `depth`.
 */
export const WORDMARK_LUY_ASCII: readonly string[] = [
  '##                ',
  '##  ##  ##  ##  ##',
  '##  ##  ##  ##  ##',
  '##  ##  ##   #####',
  '##   #####      ##', // BASELINE
  '                ##', // DESCENDER: a perninha do y
];

/** Espaço (col) entre o Λ e "luy" no wordmark grande. */
const MARK_GAP = '  ';

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
