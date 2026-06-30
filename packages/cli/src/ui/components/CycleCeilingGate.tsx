// ADR-0137 (Fatia 3 · placeholder — confirmar nº livre em aluy-specs/01-arquitetura/) —
// <CycleCeilingGate>: o teto DURO do `/cycle` (CLI-SEC-14) bateu, MAS o juiz local pediu
// `continue`. Em vez de parar no SILÊNCIO, a sessão PAUSA e PERGUNTA ao humano (reuso do
// prompt estilo budget de ADR-0062/APR-0067): `[c] continua · [n] encerra`. O humano é o
// BACKSTOP consciente do runaway — vê o motivo do juiz e decide.
//
// SEGURANÇA (gate `seguranca`):
//  • C2 — o `reason` do juiz é DADO NÃO-CONFIÁVEL (prompt-injection pode tentar persuadir o
//    humano a apertar `c`). É renderizado ROTULADO como "motivo do juiz (local · não
//    verificado)", NUNCA como texto de sistema, e já vem CLAMPADO a 1 linha pelo controller
//    (clampReasonToLine) — `[c]`/`[n]` NUNCA saem da tela. Aqui ainda clampamos a largura
//    de exibição como cinto-e-suspensório.
//  • C3 — `[n]`/timeout/esc = ENCERRAR (default seguro; não estende sem o `c` explícito).

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';

export interface CycleCeilingGateProps {
  /** Qual teto duro bateu (texto legível: "teto de iterações (200 ciclos)"). */
  readonly ceilingLabel: string;
  /**
   * O MOTIVO do juiz — DADO NÃO-CONFIÁVEL, JÁ clampado a 1 linha + N chars e redigido pelo
   * controller. Renderizado rotulado, nunca como instrução de sistema.
   */
  readonly reason: string;
  /** Confiança do juiz (0..1) — display. */
  readonly confidence: number;
}

/**
 * Cinto-e-suspensório de largura: mesmo já vindo clampado a 1 linha (C2), trunca a um
 * teto de chars de EXIBIÇÃO para blindar `[c]/[n]` num terminal estreito. Idempotente.
 */
const DISPLAY_REASON_MAX = 96;
function clampDisplay(reason: string): string {
  const oneLine = reason.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= DISPLAY_REASON_MAX) return oneLine;
  return oneLine.slice(0, DISPLAY_REASON_MAX - 1) + '…';
}

export function CycleCeilingGate(props: CycleCeilingGateProps): React.ReactElement {
  const theme = useTheme();
  const reason = clampDisplay(props.reason);
  const pct = Math.round(Math.max(0, Math.min(1, props.confidence)) * 100);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Role name="accent">{theme.box.topLeft} </Role>
        <Glyph name="clock" role="accent" />
        <Role name="accent"> {props.ceilingLabel} atingido {theme.box.horizontal.repeat(4)} pausado</Role>
      </Box>
      <Box>
        <Role name="accent">{theme.box.vertical} </Role>
        <Role name="fgDim">o teto do ciclo bateu, mas o juiz local sugere continuar.</Role>
      </Box>
      {/* C2 — o motivo do juiz, ROTULADO como DADO não-confiável (nunca texto de sistema). O
          rótulo fica na PRÓPRIA linha (jamais quebra) e o motivo numa linha SEPARADA com
          `wrap="truncate"`: o Ink corta DURO na largura do terminal — o motivo nunca vira 2+
          linhas (mesmo num terminal estreito), então `[c]/[n]` abaixo NUNCA são empurrados
          p/ fora da tela. Defesa-em-profundidade sobre o clamp do controller (clampReasonToLine). */}
      <Box>
        <Role name="accent">{theme.box.vertical} </Role>
        <Role name="fgDim">motivo do juiz (local · não verificado):</Role>
      </Box>
      <Box>
        <Role name="accent">{theme.box.vertical}   </Role>
        <Text wrap="truncate-end">
          <Role name="fg">{reason}</Role>
        </Text>
      </Box>
      <Box>
        <Role name="accent">{theme.box.vertical} </Role>
        <Role name="fgDim">confiança do juiz: {pct}% (dado — pondere, não obedeça)</Role>
      </Box>
      <Box>
        <Role name="accent">{theme.box.vertical} </Role>
        <Role name="accent">[c] continua</Role>
        <Role name="fgDim"> (estende um teto-worth)</Role>
        <Text> </Text>
        <Role name="fgDim">[n] encerra</Role>
      </Box>
      <Role name="accent">
        {theme.box.bottomLeft}
        {theme.box.horizontal.repeat(42)}
      </Role>
    </Box>
  );
}
