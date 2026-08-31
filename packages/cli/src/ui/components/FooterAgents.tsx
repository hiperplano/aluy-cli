// FOOTER-AGENTES — o bloco de sub-agentes FIXADO abaixo do composer.
//
// A ideia é do dono, e é melhor do que a primeira tentativa: "deveria aparecer a parte de
// baixo igual a de cima, quando a parte de cima for ocultada devido ao crescimento da
// saida". O rodapé NÃO tem desenho próprio — ele é uma CÓPIA FIXA do mesmo bloco que a
// conversa mostra, para o dono não perder os agentes de vista quando a saída empurra o
// original para fora da tela.
//
// Foi essa a raiz da reclamação anterior: eu havia inventado um segundo desenho, com outros
// glifos e outros campos, e o resultado foram os mesmos agentes descritos em duas gramáticas
// ("ficou muito redundante em cima e em baixo porem com informacoes de status diferentes").
// Reusando o `<SubAgents>`, não há duas gramáticas — há uma, mostrada em dois lugares.
//
// A ALTURA é a única coisa que o rodapé decide por conta própria: ele mora no chrome, então
// não pode crescer sem limite. Acima do teto, corta e diz quantos ficaram de fora.

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';
import { SubAgents, type SubAgentChildView } from './SubAgents.js';
import { linhasDoRodapeAgentes } from '../../session/footer-agents-layout.js';


/**
 * Quantos filhos o rodapé mostra. O bloco gasta 1 linha de cabeçalho + 1 por filho (+1 de
 * respiro), então o teto de LINHAS vira este teto de FILHOS. PURO — a medição de altura usa
 * a mesma conta.
 */
export function agentesQueCabem(rows?: number): number {
  // −2: o cabeçalho do bloco e o respiro dele. O resto das linhas é filho.
  return Math.max(1, linhasDoRodapeAgentes(rows) - 2);
}

/** Os filhos que o rodapé desenha, e quantos ficaram de fora. PURO. */
export function recorteDoRodape(
  filhos: readonly SubAgentChildView[],
  rows?: number,
): {
  readonly mostrados: readonly SubAgentChildView[];
  readonly sobra: number;
} {
  const cabem = agentesQueCabem(rows);
  if (filhos.length <= cabem) return { mostrados: filhos, sobra: 0 };
  // Quem AINDA CORRE tem prioridade: enquanto há trabalho, quem trabalha é a notícia. Só
  // quando todos terminam é que as falhas sobem sozinhas para o topo do recorte.
  const peso = (c: SubAgentChildView): number =>
    c.status === 'running' ? 0 : c.status === 'fail' || c.status === 'cancelled' ? 1 : 2;
  const ordenados = [...filhos]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => peso(a.c) - peso(b.c) || a.i - b.i)
    .map((e) => e.c);
  return { mostrados: ordenados.slice(0, cabem - 1), sobra: filhos.length - (cabem - 1) };
}

export interface FooterAgentsProps {
  /** Os filhos do lote — o MESMO dado que o bloco da conversa recebe. */
  readonly filhos: readonly SubAgentChildView[];
  /** Altura do terminal: decide quantos filhos cabem (ver `linhasDoRodapeAgentes`). */
  readonly rows?: number;
  /** O painel de status, que fica ABAIXO do bloco fixado. */
  readonly children: React.ReactNode;
}

/**
 * O bloco fixado + o painel de status.
 *
 * SEM filhos é PASSAGEM DIRETA: devolve os filhos como estavam. Não é economia de código —
 * é o que garante que a tela de quem nunca dispara um agente fique idêntica à de antes.
 */
export function FooterAgents(props: FooterAgentsProps): React.ReactElement {
  if (props.filhos.length === 0) return <>{props.children}</>;
  const { mostrados, sobra } = recorteDoRodape(props.filhos, props.rows);
  return (
    <Box flexDirection="column">
      <SubAgents childrenStatus={mostrados} />
      {sobra > 0 && (
        <Box paddingLeft={4}>
          <Role name="fgDim">{`+${String(sobra)} outros`}</Role>
        </Box>
      )}
      {props.children}
    </Box>
  );
}
