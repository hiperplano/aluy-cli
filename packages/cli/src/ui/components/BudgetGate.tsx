// EST-0948 · spec §2.12 · CLI-SEC-8 — <BudgetGate>: teto de sessão (PAUSA, não bloqueio).
//
// Tetos client-side (iterações/tool-calls + budget local) são anti-runaway: ao
// atingir, o agente PARA e PERGUNTA — nunca continua em silêncio. O usuário
// escolhe continuar (novo teto) ou encerrar. O `⛁ % da janela` é o sinal
// server-side; aqui o gate client-side. Consome o `stop:{kind:'limit'}` do loop
// (EST-0944) e o budget da EST-0947.
//
// EST-0973 — quando o teto chega, o gate agora oferece COMPACTAR (`[k]`): resume o
// contexto e RETOMA o loop na hora, em vez de só avisar. Só aparece quando há o que
// compactar (`canCompact`) — conversa curta não ganha a opção (no-op honesto).

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';

export interface BudgetGateProps {
  readonly reason: string;
  readonly toolCalls: number;
  readonly tokens: number;
  readonly windowPct: number;
  /**
   * EST-0948 — % do TETO DA SESSÃO de tokens consumido (pode passar de 100% quando o
   * último turno estoura: "130% do teto"). Mostrado em vez do número cru (legível).
   */
  readonly budgetPct?: number;
  /** EST-0948 — o TETO de tokens da sessão (texto legível). Ausente ⇒ sem teto de tokens. */
  readonly maxTokens?: number;
  /** EST-0973 — há histórico a compactar? Controla a oferta `[k] compactar`. */
  readonly canCompact?: boolean;
}

/** EST-0948 — abrevia o teto de tokens p/ texto legível no gate (`1M`, `200k`). */
function abbreviateCeiling(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function BudgetGate(props: BudgetGateProps): React.ReactElement {
  const theme = useTheme();
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Role name="accent">{theme.box.topLeft} </Role>
        <Glyph name="clock" role="accent" />
        <Role name="accent"> teto da sessão {theme.box.horizontal.repeat(6)} pausado</Role>
      </Box>
      <Box>
        <Role name="accent">{theme.box.vertical} </Role>
        <Role name="fg">{props.reason}</Role>
      </Box>
      {/* EST-0948 — consumo em % do teto da sessão (legível), com o teto em texto. O
          número cru de tokens fica no `reason`/detalhe. */}
      {props.budgetPct !== undefined && (
        <Box>
          <Role name="accent">{theme.box.vertical} </Role>
          <Glyph name="clock" role="accent" />
          <Role name="accent"> {props.budgetPct}% do teto da sessão</Role>
          {props.maxTokens !== undefined && (
            <Role name="fgDim"> (teto: {abbreviateCeiling(props.maxTokens)} tokens)</Role>
          )}
        </Box>
      )}
      <Box>
        <Role name="accent">{theme.box.vertical} </Role>
        <Role name="fgDim">o agente pausou para você decidir.</Role>
      </Box>
      <Box>
        <Role name="accent">{theme.box.vertical} </Role>
        <Glyph name="window" role="fgDim" />
        <Role name="fgDim"> janela: {props.windowPct}% usada</Role>
      </Box>
      {props.canCompact && (
        <Box>
          <Role name="accent">{theme.box.vertical} </Role>
          <Role name="accent">[k] compactar</Role>
          <Role name="fgDim"> resume a conversa e continua (libera a janela)</Role>
        </Box>
      )}
      <Box>
        <Role name="accent">{theme.box.vertical} </Role>
        <Role name="accent">[c] continuar (+50 iterações)</Role>
        <Text> </Text>
        <Role name="fgDim">[n] encerrar</Role>
      </Box>
      <Role name="accent">
        {theme.box.bottomLeft}
        {theme.box.horizontal.repeat(42)}
      </Role>
    </Box>
  );
}
