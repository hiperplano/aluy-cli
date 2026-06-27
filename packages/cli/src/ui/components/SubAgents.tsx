// EST-0969 (display) · spec §sub-agentes — <SubAgents>: o INDICADOR COMPACTO dos
// sub-agentes paralelos.
//
// O bug que isto resolve: sub-agentes paralelos NÃO devem despejar os tokens crus
// de cada filho na região viva (interleava → lixo ilegível, "Usar Go?rust", "fGomt").
// Em vez disso, um bloco estável `⊕ N sub-agentes:` com uma linha de STATUS por
// filho (`[rust] ◷ rodando` → `[rust] ✓ pronto · 1.2k tokens · 3 tools`), atualizado
// quando cada um inicia/termina — NUNCA o corpo/stream do filho.
//
// a11y (§3.3): o estado vem SEMPRE com a PALAVRA ao lado do glifo (`rodando`/`pronto`/
// `falhou`), nunca só pela cor. Bloco ESTÁVEL (sem jitter): só muda na transição de
// um filho (início/fim), não a cada token — então não treme como o stream.

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role } from '../theme/index.js';

/** Espelha `SubAgentChild` do model (sem importar o tipo p/ manter o componente puro). */
export interface SubAgentChildView {
  readonly label: string;
  // EST-0982 — `cancelled` quando o usuário PAROU este filho (cessar≠falha).
  readonly status: 'running' | 'done' | 'fail' | 'cancelled';
  readonly summary?: string;
  readonly stop?: 'final' | 'limit' | 'timeout' | 'error' | 'cancelled';
}

export interface SubAgentsProps {
  /**
   * Os filhos a exibir (status por filho). Nome `childrenStatus` (não `children`) p/
   * NÃO colidir com a prop `children` do React — aqui é DADO de status, não nós JSX.
   */
  readonly childrenStatus: readonly SubAgentChildView[];
}

/** Palavra do estado (a11y): glifo NUNCA sozinho. `timeout`/`limit` ⇒ palavra honesta. */
function statusWord(child: SubAgentChildView): string {
  if (child.status === 'running') return 'rodando';
  if (child.status === 'done') return 'pronto';
  // EST-0982 — PARADO pelo usuário: cessar≠falha (a11y honesta).
  if (child.status === 'cancelled') return 'parado';
  // fail: distingue o motivo p/ o usuário (teto vs timeout vs erro).
  switch (child.stop) {
    case 'timeout':
      return 'timeout';
    case 'limit':
      return 'teto';
    default:
      return 'falhou';
  }
}

/** UMA linha de filho: `  [rust] ◷ rodando` / `  [rust] ✓ pronto · 1.2k tokens · 3 tools`. */
function ChildLine(props: { readonly child: SubAgentChildView }): React.ReactElement {
  const c = props.child;
  const word = statusWord(c);
  const glyph =
    c.status === 'running' ? (
      <Glyph name="clock" role="depth" />
    ) : c.status === 'done' ? (
      <Glyph name="ok" role="success" />
    ) : c.status === 'cancelled' ? (
      // PARADO pelo usuário (cessar≠falha): glifo neutro `dim`, não `danger`.
      <Glyph name="err" role="fgDim" />
    ) : (
      <Glyph name="err" role="danger" />
    );
  const wordRole = c.status === 'done' ? 'success' : c.status === 'fail' ? 'danger' : 'fgDim';
  return (
    <Box paddingLeft={2}>
      <Role name="accent">[{c.label}]</Role>
      <Text> </Text>
      {glyph}
      <Text> </Text>
      <Role name={wordRole}>{word}</Role>
      {c.summary !== undefined && c.status !== 'running' && (
        <Role name="fgDim"> · {c.summary}</Role>
      )}
    </Box>
  );
}

export function SubAgents(props: SubAgentsProps): React.ReactElement {
  const items = props.childrenStatus;
  const total = items.length;
  const running = items.filter((c) => c.status === 'running').length;
  // Cabeçalho compacto: `⊕ 3 sub-agentes:` (com `(N rodando)` enquanto há vivos).
  const headTail = running > 0 ? ` (${running} rodando)` : '';
  return (
    <Box flexDirection="column" paddingLeft={2} paddingBottom={1}>
      <Box>
        <Glyph name="subagents" role="accent" />
        <Role name="fg">
          {' '}
          {total} sub-agente{total === 1 ? '' : 's'}:
        </Role>
        {headTail !== '' && <Role name="fgDim">{headTail}</Role>}
      </Box>
      {items.map((c, i) => (
        <ChildLine key={`${c.label}:${i}`} child={c} />
      ))}
    </Box>
  );
}
