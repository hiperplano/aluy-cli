// F195 (pedido do dono) — <BusyPulse>: o PULSO "trabalhando" da StatusBar.
//
// Um indicador VIVO de trabalho em curso, ADICIONAL ao Λ que pisca (<AluyLoader>) e ao
// verbo vivo (<Working>): uma barrinha de BLOCOS GROSSOS (o glifo `pulseBlock` → █) que
// ENCHE e ESVAZIA da esquerda p/ a direita, em laço, enquanto o agente processa. É o
// "cursor grosso" que o dono pediu ("o | grosso do Claude"), agora como uma barra que
// respira — sinaliza, no rodapé (onde o olho descansa), que há trabalho acontecendo.
//
// PURO / frame-driven (handoff §10.1, igual <Working>/<ProgressBar>): recebe `frame` do
// tick central e deriva TUDO de `frame` — sem `setInterval` aqui. As células ACESAS são
// `accent` (âmbar da marca) e as apagadas `accentDim` (âmbar calmo) — cor SEMPRE por
// PAPEL (nunca cor crua).
//
// ANTI-FLICKER (EST-0965/EST-0956): a barra tem LARGURA CONSTANTE — sempre `width`
// blocos desenhados; só a COR de cada célula muda com o `frame` (nada aparece/some).
// Reduced-motion (`theme.animate===false`) ⇒ barra ESTÁTICA (todas as células
// `accentDim`): o sentido "ocupado" fica no VERBO vivo ao lado (a11y §6 — o movimento
// nunca carrega significado sozinho).

import React from 'react';
import { Box } from 'ink';
import { Role, useTheme } from '../theme/index.js';

/** Largura default do pulso (nº de blocos). Curta — cabe na StatusBar sem empurrar campos. */
export const DEFAULT_PULSE_WIDTH = 4;

/**
 * Nº de células ACESAS (da esquerda) em função do `frame` — uma onda TRIANGULAR que sobe
 * de 1 até `width` e desce de volta a 1 (a barra "enche e esvazia", respira). PURA.
 * `frame` negativo/não-finito é normalizado (fail-safe). `width<=1` ⇒ sempre 1.
 */
export function pulseLit(frame: number, width: number): number {
  const w = Math.max(1, Math.trunc(width));
  if (w === 1) return 1;
  const f = Number.isFinite(frame) ? Math.trunc(frame) : 0;
  const period = 2 * (w - 1); // sobe (w-1 passos) + desce (w-1 passos)
  const p = ((f % period) + period) % period;
  return p < w ? p + 1 : 2 * w - 1 - p; // 1..w..2 → triângulo
}

export interface BusyPulseProps {
  /** Frame do tick central (puro). Default 0 (estático). */
  readonly frame?: number;
  /** Nº de blocos da barra. Default `DEFAULT_PULSE_WIDTH`. */
  readonly width?: number;
}

/**
 * A barrinha de blocos grossos que enche/esvazia enquanto o agente trabalha. Cada célula
 * é o glifo `pulseBlock` (█ → # em ASCII); as `lit` da esquerda em `accent`, o resto em
 * `accentDim`. Largura constante entre frames (anti-flicker) — só a cor pulsa.
 */
export function BusyPulse(props: BusyPulseProps): React.ReactElement {
  const theme = useTheme();
  const width = Math.max(1, props.width ?? DEFAULT_PULSE_WIDTH);
  const block = theme.glyph('pulseBlock');
  // Reduced-motion: barra parada (todas apagadas) — o verbo vivo ao lado carrega o sentido.
  const lit = theme.animate ? pulseLit(props.frame ?? 0, width) : 0;

  return (
    <Box>
      {Array.from({ length: width }, (_, i) =>
        i < lit ? (
          <Role key={i} name="accent">
            {block}
          </Role>
        ) : (
          <Role key={i} name="accentDim">
            {block}
          </Role>
        ),
      )}
    </Box>
  );
}
