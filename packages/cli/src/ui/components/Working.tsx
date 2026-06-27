// EST-0948 · spec §2.4/§2.6/§3.6 — <Working>: a "vau" (onda ～ + verbo vivo).
//
// O coração do eixo 2. Renderiza o glifo do papel + uma BANDA de onda `～` em que
// o brilho CORRE da esquerda p/ a direita (cada frame um `～` vira `accent`, os
// demais `accentDim`) + o VERBO vivo (`pensando…`, `rodando npm test…`,
// `lendo session.ts…`). Usado em DOIS estados:
//   - `thinking` (pré-1º-token): glifo `◇` (aluy) + onda + `pensando…`
//   - tool in-flight: glifo `◌` (anel) + onda + gerúndio (`rodando…`)
//
// PURO (handoff §10.1): recebe `frame` por prop e deriva tudo de `frame % n`. Sem
// `setInterval` aqui — o tick é central (useTick na App). Fallback (a11y §6):
//   - `theme.animate === false` ⇒ onda ESTÁTICA (`accentDim`), só o verbo carrega.
// O movimento NUNCA carrega sentido sozinho — o verbo está sempre ao lado.

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';
import type { GlyphName } from '../theme/glyphs.js';
import { AluyLoader } from './AluyLoader.js';

/** Largura da banda de onda (nº de `～`). 3 em telas normais (spec §3.6). */
const WAVE_WIDTH = 3;

export interface WorkingProps {
  /** Frame do tick central (puro). Default 0 (estático). */
  readonly frame?: number;
  /** Verbo vivo ao lado da onda (`pensando`, `rodando npm test`, `lendo x.ts`). */
  readonly label: string;
  /** Glifo do papel à esquerda (`aluy` p/ thinking, `toolInflight` p/ tool). */
  readonly glyph?: GlyphName;
  /** Papel de cor do glifo. Default `accent` (thinking) — `depth` p/ tool. */
  readonly glyphRole?: 'accent' | 'depth';
  /** Largura da banda (telas estreitas reduzem p/ 2 — spec §5.1). Default 3. */
  readonly width?: number;
}

/**
 * Renderiza a onda como uma sequência de `～`, com o glifo `waveHead` (›) marcando
 * a posição corrente do brilho. `animate=false` ⇒ banda inteira em `accentDim`
 * (estática). Caso contrário, a posição `frame % width` é a "cabeça" (accent).
 */
export function Working(props: WorkingProps): React.ReactElement {
  const theme = useTheme();
  const width = props.width ?? WAVE_WIDTH;
  const frame = props.frame ?? 0;
  const glyph = props.glyph ?? 'aluy';
  const glyphRole = props.glyphRole ?? 'accent';
  const animate = theme.animate;

  const wave = theme.glyph('wave');
  const head = theme.glyph('waveHead');
  const headPos = animate ? frame % width : -1; // -1 ⇒ sem cabeça (estático)

  return (
    <Box>
      {/* EST-0984 — quando o papel é o Aluy (`thinking`/pré-stream), a marca Λ
          ANIMA (desenha+respira) no lugar do glifo estático. Para `toolInflight`
          (○) e demais papéis segue o glifo estático. */}
      {glyph === 'aluy' ? <AluyLoader frame={frame} /> : <Glyph name={glyph} role={glyphRole} />}
      <Text> </Text>
      {/* a banda de onda: cada célula é accent (cabeça) ou accentDim (corpo) */}
      {Array.from({ length: width }, (_, i) =>
        i === headPos ? (
          <Role key={i} name="accent">
            {head}
          </Role>
        ) : (
          <Role key={i} name="accentDim">
            {wave}
          </Role>
        ),
      )}
      <Text> </Text>
      <Role name="fgDim">{props.label}…</Role>
    </Box>
  );
}
