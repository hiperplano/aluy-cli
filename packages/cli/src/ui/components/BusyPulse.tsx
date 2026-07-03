// F195 (pedido do dono) — <BusyPulse>: o PULSO "trabalhando" da StatusBar.
//
// Um indicador VIVO de trabalho em curso, ADICIONAL ao Λ que pisca (<AluyLoader>) e ao
// verbo vivo (<Working>): uma barrinha de BLOCOS GROSSOS (o glifo `pulseBlock` → █) que
// ENCHE e ESVAZIA da esquerda p/ a direita, em laço, enquanto o agente processa. É o
// "cursor grosso" que o dono pediu ("o | grosso do Claude"), agora como uma barra que
// respira — sinaliza, no rodapé (onde o olho descansa), que há trabalho acontecendo.
//
// PURO / frame-driven (handoff §10.1, igual <Working>/<ProgressBar>): recebe `frame` do
// tick central e deriva TUDO de `frame` — sem `setInterval` aqui.
//
// DEGRADÊ (pedido do dono — "mais cores + maiorzinha ligadas ao tema"): a barra usa os
// TRÊS tons âmbar da marca por PAPEL (nunca cor crua), formando um gradiente: a CABEÇA da
// onda (a célula acesa mais à direita) em `accent` (âmbar-400, o mais claro/vivo), o CORPO
// aceso atrás dela em `depth` (âmbar-500, médio) e as apagadas em `accentDim` (âmbar calmo).
// Assim o pulso "brilha na ponta e esmaece na cauda" — um degradê que respira, não só 2
// cores. A largura subiu p/ `DEFAULT_PULSE_WIDTH` blocos (maior), mantendo 1 LINHA de altura
// de propósito (a altura da StatusBar entra no orçamento da região viva — não engorda).
//
// ANTI-FLICKER (EST-0965/EST-0956): a barra tem LARGURA CONSTANTE — sempre `width`
// blocos desenhados; só a COR de cada célula muda com o `frame` (nada aparece/some).
// Reduced-motion (`theme.animate===false`) ⇒ barra ESTÁTICA (todas as células
// `accentDim`): o sentido "ocupado" fica no VERBO vivo ao lado (a11y §6 — o movimento
// nunca carrega significado sozinho).

import React from 'react';
import { Box } from 'ink';
import { Role, useTheme } from '../theme/index.js';

/**
 * Largura default do pulso (nº de blocos). F195+ (pedido do dono "maiorzinha"): 7 blocos —
 * maior que os 4 originais, mas ainda enxuto o bastante p/ caber na StatusBar sem empurrar
 * os outros campos. Só CRESCE na horizontal (a altura segue 1 linha — ver cabeçalho).
 */
export const DEFAULT_PULSE_WIDTH = 7;

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
 * Papel (cor do tema) de cada célula do pulso, formando o DEGRADÊ. PURA. `i` é o índice da
 * célula (0…width-1) e `lit` o nº de células acesas da esquerda:
 * - `i >= lit`  ⇒ apagada        → `accentDim` (âmbar calmo)
 * - `i === lit-1` ⇒ CABEÇA da onda → `accent` (âmbar-400, o mais vivo)
 * - senão (corpo aceso)          → `depth` (âmbar-500, médio)
 * Resultado: ponta brilhante que esmaece na cauda — degradê de 3 tons, todos por PAPEL.
 */
export function pulseCellRole(i: number, lit: number): 'accent' | 'depth' | 'accentDim' {
  if (i >= lit) return 'accentDim';
  if (i === lit - 1) return 'accent';
  return 'depth';
}

/**
 * A barra de blocos grossos que enche/esvazia enquanto o agente trabalha, agora com DEGRADÊ
 * de 3 tons âmbar (cabeça `accent` → corpo `depth` → apagado `accentDim`, via `pulseCellRole`).
 * Cada célula é o glifo `pulseBlock` (█ → # em ASCII). Largura constante entre frames
 * (anti-flicker) — só a COR de cada célula muda com o `frame`, nada aparece/some.
 */
export function BusyPulse(props: BusyPulseProps): React.ReactElement {
  const theme = useTheme();
  const width = Math.max(1, props.width ?? DEFAULT_PULSE_WIDTH);
  const block = theme.glyph('pulseBlock');
  // Reduced-motion: barra parada (todas apagadas) — o verbo vivo ao lado carrega o sentido.
  const lit = theme.animate ? pulseLit(props.frame ?? 0, width) : 0;

  return (
    <Box>
      {Array.from({ length: width }, (_, i) => (
        <Role key={i} name={pulseCellRole(i, lit)}>
          {block}
        </Role>
      ))}
    </Box>
  );
}
