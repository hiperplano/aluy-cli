// EST-0948 · spec §2.15 — <NoteBlock>: saída de um slash-command na conversa.
//
// Resposta da TUI a `/help`, `/model`, `/usage`, `/whoami`… Não é fala do agente
// (◇) nem do usuário (▌): é o sistema respondendo. Bloco `◷` dim com título +
// linhas. NUNCA mostra provider/modelo (HG-2) — `/model` só passa o `tier` aqui.

import React from 'react';
import { Box } from 'ink';
import { Glyph, Role } from '../theme/index.js';

export interface NoteBlockProps {
  readonly title: string;
  readonly lines: readonly string[];
}

export function NoteBlock(props: NoteBlockProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Glyph name="clock" role="depth" />
        <Role name="depth"> {props.title}</Role>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {props.lines.map((line, i) => (
          <Role key={i} name="fgDim">
            {line}
          </Role>
        ))}
      </Box>
    </Box>
  );
}
