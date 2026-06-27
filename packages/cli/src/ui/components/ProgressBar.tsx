// EST-0973 — <ProgressBar>: feedback de PROGRESSO de operações LONGAS na TUI.
//
// O problema (Tiago): ops que demoram alguns segundos — a 1ª é COMPACTAR a conversa
// (`/compact` · `[k]`) — não davam feedback nenhum; a tela parecia TRAVADA. Este é o
// indicador genérico (reutilizável) que enche esse vácuo, em DOIS modos:
//
//   • DETERMINADO  (sabe o %): barra `▰▰▰▱▱` + `N%` + label. Para ops com etapas
//     mensuráveis (ex.: resumir M blocos em lotes ⇒ `m/M`). O % é REAL — derivado de
//     `value/max` (clampado) — NUNCA inventado.
//   • INDETERMINADO (não sabe o %, ex.: 1 chamada ao modelo p/ resumir): spinner
//     calmo (braille `⠋⠙⠹…`) + label + ELAPSED (`compactando a conversa… 0:03`). NÃO
//     finge porcentagem falsa — mostra ATIVIDADE + tempo decorrido, honesto.
//
// PURO / frame-driven (handoff §10.1, igual <Working>/<Spinner>): recebe `frame` (do
// tick central) e, no indeterminado, `elapsedMs` (do tick lento de 1s) por PROP. SEM
// `setInterval` aqui — os testes passam frame/elapsed fixos, sem timers reais.
//
// DEGRADAÇÃO (a11y §6 / EST-0984):
//   • cor: tudo por PAPEL (Role/tokens, ADR-0041); NO_COLOR ⇒ texto sem cor, mas o
//     contraste cheio/vazado + o `N%`/elapsed continuam carregando o sentido.
//   • glifo: `barFull`/`barEmpty` resolvem ▰/▱ → █/░ (SAFE) → `#`/`.` (ASCII); em
//     ASCII a barra ganha colchetes (`[###...] 60%`), o estilo universal de terminal.
//   • movimento: `theme.animate===false` ⇒ braille vira ◷ estático (já no <Spinner>);
//     a barra determinada não depende de movimento (o % carrega). O label sempre ao
//     lado — o glifo/spinner NUNCA carrega significado sozinho.
//
// ANTI-FLICKER (#95/#118): este componente é uma ÚNICA LINHA pequena na região viva.
// Ele NÃO redesenha a tela: anima no tick lento (~8fps de animação coalescido pelo
// sync-output, + 1fps do elapsed), nunca emite `\x1b[2K` próprio. É só mais um nó da
// árvore viva — o anti-flicker da App (overwrite-in-place + BSU/ESU) cobre o resto.

import React from 'react';
import { Box, Text } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import type { TermRole } from '../theme/palette.js';
import { formatElapsed } from '../../session/model.js';

/** Largura default da barra DETERMINADA (nº de células). Curta — cabe em telas estreitas. */
export const DEFAULT_BAR_WIDTH = 12;

/** Razão 0..1 de avanço, clampada. `max<=0` ⇒ 0 (fail-safe — nunca divide por zero nem
 * estoura). PURA. Espelha o `budgetRatio` do DS (mesma disciplina de clamp). */
export function progressRatio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

/** Percentual inteiro (0..100) p/ exibição. PURO. */
export function progressPercent(value: number, max: number): number {
  return Math.round(progressRatio(value, max) * 100);
}

/**
 * Monta a STRING da barra determinada (sem cor): `cheias` × `barFull` + `vazias` ×
 * `barEmpty`, somando exatamente `width` células (anti-jitter EST-0956: largura
 * CONSTANTE entre frames/percentuais). Em ASCII (`unicode=false`) envelopa em
 * `[...]` — o idioma universal de progresso em terminal 7-bit. PURA/testável.
 *
 * O nº de células cheias é `round(ratio*width)`, mas garantimos ≥1 cheia quando há
 * QUALQUER avanço (>0%) e ≤width-1 vazias até 100% — para o olho não ler "0" tendo
 * começado nem "cheio" antes da hora.
 */
export function renderBar(
  ratio: number,
  full: string,
  empty: string,
  width: number,
  unicode: boolean,
): { filled: string; rest: string } {
  const w = Math.max(1, Math.trunc(width));
  const r = Math.max(0, Math.min(1, ratio));
  let filledCount = Math.round(r * w);
  if (r > 0 && filledCount === 0) filledCount = 1; // avanço mínimo visível
  if (r < 1 && filledCount === w) filledCount = w - 1; // não "completa" antes de 100%
  const filled = full.repeat(filledCount);
  const rest = empty.repeat(w - filledCount);
  return unicode ? { filled, rest } : { filled: `[${filled}`, rest: `${rest}]` }; // colchetes ASCII (`[###...]`)
}

export interface ProgressBarProps {
  /** Verbo/descrição da operação (`compactando a conversa`, `baixando anexo`). Sempre
   * presente — carrega o sentido (a barra/spinner é só atividade, a11y §6). */
  readonly label: string;
  /**
   * DETERMINADO: posição corrente da operação (ex.: lote `m` de `M`). Quando definido
   * JUNTO de `max`, renderiza a barra + `N%`. Ausente ⇒ INDETERMINADO (spinner+elapsed).
   */
  readonly value?: number;
  /** DETERMINADO: total da operação (`M`). Veja `value`. */
  readonly max?: number;
  /** INDETERMINADO: tempo decorrido (ms), exibido como `M:SS` (`formatElapsed`). O
   * caller passa `Date.now() - startedAt`; o tick lento de 1s o faz avançar. */
  readonly elapsedMs?: number;
  /** Frame do tick central (puro) — anima o spinner do modo indeterminado. Default 0. */
  readonly frame?: number;
  /** Largura da barra determinada. Default `DEFAULT_BAR_WIDTH`. */
  readonly width?: number;
  /** Papel de cor da parte CHEIA / do spinner. Default `accent`. */
  readonly role?: TermRole;
}

/**
 * Indicador de progresso. Decide o modo pela presença de `value`+`max`:
 *  - ambos definidos ⇒ DETERMINADO (barra + %);
 *  - senão ⇒ INDETERMINADO (spinner + elapsed).
 * Largura visual ESTÁVEL entre frames (a barra tem `width` fixo; o spinner é 1 célula)
 * — nada aparece/some, então o tick não causa jitter horizontal.
 */
export function ProgressBar(props: ProgressBarProps): React.ReactElement {
  const theme = useTheme();
  const role = props.role ?? 'accent';
  const determinate = props.value !== undefined && props.max !== undefined;

  if (determinate) {
    const ratio = progressRatio(props.value!, props.max!);
    const pct = Math.round(ratio * 100);
    const full = theme.glyph('barFull');
    const empty = theme.glyph('barEmpty');
    const width = props.width ?? DEFAULT_BAR_WIDTH;
    const { filled, rest } = renderBar(ratio, full, empty, width, theme.unicode);
    return (
      <Box>
        {/* parte cheia em `accent`; parte vazia esmaecida — o contraste lê o avanço
            mesmo SEM cor (cheio/vazado são glifos distintos). */}
        <Role name={role}>{filled}</Role>
        <Role name="fgDim">{rest}</Role>
        <Text> </Text>
        <Role name={role}>{pct}%</Role>
        <Text> </Text>
        <Role name="fgDim">{props.label}</Role>
      </Box>
    );
  }

  // INDETERMINADO — spinner braille (◷ estático em reduced-motion) + label + elapsed.
  // Reusa os MESMOS frames do <Spinner> (tabela única); não finge %.
  const frames = theme.spinnerFrames;
  const spin = theme.animate ? frames[(props.frame ?? 0) % frames.length]! : theme.glyph('clock');
  const elapsed = props.elapsedMs !== undefined ? formatElapsed(props.elapsedMs) : undefined;
  return (
    <Box>
      <Role name={role}>{spin}</Role>
      <Text> </Text>
      <Role name="fgDim">
        {props.label}…{elapsed !== undefined ? ` ${elapsed}` : ''}
      </Role>
    </Box>
  );
}
