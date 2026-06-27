// EST · acabamento TUI — <CodeBlock>: bloco ```lang realçado em PAPÉIS do DS.
//
// Borda/fundo SUTIL no estilo da TUI (mesma família de box do AskDialog, em
// `fgDim` p/ não competir com a fala). Cabeçalho com a linguagem (`depth`) à
// direita do canto. Cada linha de código vira segmentos `{text, role}` via
// highlightToSegments (lib só TOKENIZA; cor é nossa). Fallbacks:
//  - linguagem desconhecida ⇒ um segmento `fg` (texto cru legível).
//  - mono/NO_COLOR ⇒ os papéis não acendem cor (palette MONO) mas a MOLDURA e o
//    cabeçalho `lang` permanecem — o leitor ainda vê "isto é um bloco de código".
//  - ASCII (TERM=linux) ⇒ box vira `+/-/|` (theme.box já degrada).

import React from 'react';
import { Box, Text } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import { highlightToSegments, resolveLanguage } from './highlight.js';

export interface CodeBlockProps {
  readonly code: string;
  readonly lang?: string | undefined;
  /** Cerca ainda aberta (stream no meio do bloco): rótulo "…". */
  readonly open?: boolean;
}

export function CodeBlock(props: CodeBlockProps): React.ReactElement {
  const theme = useTheme();
  const box = theme.box;
  const resolved = resolveLanguage(props.lang);
  // rótulo do cabeçalho: a linguagem resolvida, ou o fence cru, ou "code".
  const label = (resolved ?? props.lang ?? 'code') + (props.open ? ' …' : '');
  const lines = props.code.split('\n');

  return (
    <Box flexDirection="column" paddingY={0}>
      {/* topo: ╭── lang ──╮ (em fgDim, moldura discreta) */}
      <Box>
        <Role name="fgDim">
          {box.topLeft}
          {box.horizontal}{' '}
        </Role>
        <Role name="depth">{label}</Role>
        <Role name="fgDim"> {box.horizontal.repeat(2)}</Role>
      </Box>
      {lines.map((line, i) => (
        <Box key={i}>
          <Role name="fgDim">{box.vertical} </Role>
          <CodeLine line={line} lang={resolved ?? props.lang} />
        </Box>
      ))}
      <Box>
        <Role name="fgDim">
          {box.bottomLeft}
          {box.horizontal.repeat(3)}
        </Role>
      </Box>
    </Box>
  );
}

/** Uma linha de código realçada em segmentos de papel. */
function CodeLine(props: {
  readonly line: string;
  readonly lang: string | undefined;
}): React.ReactElement {
  // linha vazia precisa de um espaço p/ a moldura não colapsar.
  if (props.line === '') return <Text> </Text>;
  const segs = highlightToSegments(props.line, props.lang);
  return (
    <Text>
      {segs.map((s, i) => (
        <Role key={i} name={s.role}>
          {s.text}
        </Role>
      ))}
    </Text>
  );
}
