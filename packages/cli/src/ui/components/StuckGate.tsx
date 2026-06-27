// EST-0969 (watchdog de TRAVAMENTO · pausa-pede-direção) — <StuckGate>: o agente
// está girando sem ir a lugar nenhum (mesma tool/erro/turno-vazio/sem-progresso). A
// sessão PAUSA e PEDE DIREÇÃO ao usuário, em vez de girar em silêncio, repetir ou
// morrer no teto. Resume O QUE travou (a tool/erro/padrão) p/ o usuário decidir com
// contexto. NÃO é um diálogo de permissão (a catraca segue intocada) — é só um
// pedido de direção acionável: `[r]` redirecionar (digite a nova instrução),
// `[c]` continuar mesmo assim, `[n]` encerrar.

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';

export interface StuckGateProps {
  /** Qual padrão de travamento disparou (define a frase do "parece travado em X"). */
  readonly kind: 'same-tool-call' | 'same-tool-error' | 'empty-turns' | 'no-progress';
  /** Quantas repetições/voltas estéreis ao disparar (o "4×" do aviso). */
  readonly count: number;
  /** Amostra CURTA e SEGURA (nome da tool / assinatura do erro / rótulo do padrão). */
  readonly sample: string;
  /**
   * EST-0969 — `true` quando o usuário escolheu `[r]` e o composer está aberto p/ a
   * nova direção: o gate mostra a dica de digitar+Enter em vez do menu de teclas.
   */
  readonly redirecting?: boolean;
}

/** Frase HUMANA do que travou — DADO, sem texto cru/segredo (já vem clampado). */
function describe(kind: StuckGateProps['kind'], count: number, sample: string): string {
  switch (kind) {
    case 'same-tool-call':
      return `o agente repetiu a tool "${sample}" ${count}× sem avançar.`;
    case 'same-tool-error':
      return `a mesma falha se repetiu ${count}× seguidas (${sample}).`;
    case 'empty-turns':
      return `o agente respondeu vazio ${count}× seguidas (sem texto nem ação).`;
    case 'no-progress':
      return `${count} iterações sem avanço real (nenhum arquivo/edição/comando novo).`;
  }
}

export function StuckGate(props: StuckGateProps): React.ReactElement {
  const theme = useTheme();
  const what = describe(props.kind, props.count, props.sample);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Role name="accent">{theme.box.topLeft} </Role>
        <Glyph name="clock" role="accent" />
        <Role name="accent"> parece travado {theme.box.horizontal.repeat(6)} pausado</Role>
      </Box>
      <Box>
        <Role name="accent">{theme.box.vertical} </Role>
        <Role name="fg">{what}</Role>
      </Box>
      {props.redirecting ? (
        <Box>
          <Role name="accent">{theme.box.vertical} </Role>
          <Role name="accent">[r] </Role>
          <Role name="fgDim">digite a nova instrução e tecle Enter (esc cancela).</Role>
        </Box>
      ) : (
        <>
          <Box>
            <Role name="accent">{theme.box.vertical} </Role>
            <Role name="fgDim">o agente pausou para você decidir o rumo.</Role>
          </Box>
          <Box>
            <Role name="accent">{theme.box.vertical} </Role>
            <Role name="accent">[r] redirecionar</Role>
            <Role name="fgDim"> (dar uma nova instrução)</Role>
          </Box>
          <Box>
            <Role name="accent">{theme.box.vertical} </Role>
            <Role name="accent">[c] continuar mesmo assim</Role>
            <Text> </Text>
            <Role name="fgDim">[n] encerrar</Role>
          </Box>
        </>
      )}
      <Role name="accent">
        {theme.box.bottomLeft}
        {theme.box.horizontal.repeat(42)}
      </Role>
    </Box>
  );
}
