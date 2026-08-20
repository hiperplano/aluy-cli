// EST-0982 · ADR-0063 (CONTABILIDADE) — <TurnFooter>: o resumo do TURNO do agente
// PRINCIPAL (tokens + duração), estilo Claude Code.
//
// O Tiago pediu a contabilidade "estilo Claude Code": tokens E tempo por agente E o
// total do turno/sessão. O bloco `[sub-agentes]` já mostra por filho (EST-0969 +
// tempo desta estória); este rodapé mostra o AGENTE PRINCIPAL — o que o Claude Code
// faz no fim do turno (`⏺ 12.3k tokens · 2 tools · 4.1s`).
//
// É LEITURA/DISPLAY puro (ADR-0063 §4 / GS-C: contabilidade não dispara efeito novo,
// não vaza segredo — são só contadores do budget/broker + o relógio). Apresentação
// pura (papéis do DS); a fonte do dado é o controller (`turnAccounting`).

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role } from '../theme/index.js';
import { abbreviateCount, formatDuration, type TurnAccountingView } from '../../session/model.js';

export interface TurnFooterProps {
  readonly accounting: TurnAccountingView;
  /**
   * F-RECAP (pedido do dono: "um recap na linha inferior do que fez") — resumo do que o
   * turno FEZ (`buildTurnRecap`). O rodapé de hoje informa CUSTO (tokens/tools/duração),
   * que responde "quanto gastou" e não "o que aconteceu"; num turno com dez tools o dono
   * teria de reler o histórico para saber que arquivo foi tocado. Ausente ⇒ rodapé
   * idêntico ao de hoje (turno de conversa pura não inventa recap).
   */
  readonly recap?: string;
}

export function TurnFooter(props: TurnFooterProps): React.ReactElement {
  const a = props.accounting;
  const parts: string[] = [`${abbreviateCount(a.tokens)} tokens`];
  if (a.toolCalls > 0) parts.push(`${a.toolCalls} tools`);
  parts.push(formatDuration(a.durationMs));
  // O recap vem DEPOIS do custo: quem varre o rodapé procura primeiro o número, e o
  // resumo é a leitura que se faz quando o número chama atenção.
  if (props.recap !== undefined && props.recap !== '') parts.push(props.recap);
  return (
    <Box paddingLeft={2}>
      {/* `done` (concluído) ⇒ ✓; `live` (turno correndo) ⇒ ◷ relógio. */}
      {a.live ? <Glyph name="clock" role="depth" /> : <Glyph name="ok" role="success" />}
      <Text> </Text>
      <Role name="fgDim">{parts.join(' · ')}</Role>
    </Box>
  );
}
