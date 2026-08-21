// EST-0948 · spec §2.15 — <NoteBlock>: saída de um slash-command na conversa.
//
// Resposta da TUI a `/help`, `/model`, `/usage`, `/whoami`… Não é fala do agente
// (◇) nem do usuário (▌): é o sistema respondendo. Bloco `◷` dim com título +
// linhas. NUNCA mostra provider/modelo (HG-2) — `/model` só passa o `tier` aqui.

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role } from '../theme/index.js';
import { ROTULO_COLS } from './StatusPanel.js';

export interface NoteBlockProps {
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * F-HEADER-HARMONIA — a nota de boot na MESMA gramática do painel de status.
 *
 * O rodapé já lia como tabela — glifo, rótulo alinhado em coluna, valor à direita
 * (`◕ sessão  local · openrouter · …`). O topo não: o glifo colava na margem, o título
 * ficava sozinho numa linha e o valor caía recuado na linha seguinte. Eram dois sistemas de
 * alinhamento na mesma tela, e é isso que fazia o topo parecer de outro produto.
 *
 * Agora a primeira linha da nota sobe para o lado do rótulo. As demais (quando há) seguem
 * alinhadas SOB o valor, não sob o glifo — a continuação pertence ao valor.
 *
 * `ROTULO_COLS` é o mesmo do `<StatusPanel>`: é a coluna compartilhada que faz o topo e o
 * rodapé lerem como um sistema só. Mudar um sem o outro reabre a divergência.
 */
export function NoteBlock(props: NoteBlockProps): React.ReactElement {
  // Rótulo que NÃO cabe na coluna (`provider` tem 8, a coluna tem 7) empurraria o valor uma
  // coluna à frente e quebraria justamente o alinhamento que esta mudança veio criar — as
  // continuações ficariam numa coluna e a primeira linha em outra. Nesse caso o valor INTEIRO
  // desce, e todas as linhas ficam alinhadas entre si. A coluna vale mais que economizar uma
  // linha.
  const cabeNaColuna = props.title.length <= ROTULO_COLS - 1;
  const linhasAbaixo = cabeNaColuna ? props.lines.slice(1) : props.lines;
  const primeira = cabeNaColuna ? props.lines[0] : undefined;
  return (
    <Box flexDirection="column">
      <Box>
        <Glyph name="clock" role="depth" />
        <Text> </Text>
        <Role name="depth">{props.title.padEnd(ROTULO_COLS - 1, ' ')}</Role>
        <Text> </Text>
        {primeira !== undefined && <Role name="fgDim">{primeira}</Role>}
      </Box>
      {linhasAbaixo.length > 0 && (
        <Box flexDirection="column" paddingLeft={ROTULO_COLS + 1}>
          {linhasAbaixo.map((line, i) => (
            <Role key={i} name="fgDim">
              {line}
            </Role>
          ))}
        </Box>
      )}
    </Box>
  );
}
