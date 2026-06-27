// EST-0957 · spec §4.2 — <AttachChips>: marcadores dos arquivos anexados ao turno.
//
// Quando o usuário anexa `@arquivo`(s), cada um vira um CHIP `@caminho` acima do
// composer, ANTES do envio (CA-3/CA-5: removível). Multi-anexo ⇒ vários chips. O
// chip do índice "ativo" (último/foco de remoção) ganha o prefixo `›` (a11y). O
// chip TRUNCADO mostra um `~` discreto (o conteúdo foi cortado pelo teto). Pura
// apresentação — a lista e a remoção são do orquestrador (App). Tokens-only.

import React from 'react';
import { Box, Text } from 'ink';
import { Role } from '../theme/index.js';

/** Um chip de arquivo anexado. */
export interface AttachChip {
  readonly path: string;
  /** `true` se o conteúdo foi truncado pelo teto de chars. */
  readonly truncated?: boolean;
}

export interface AttachChipsProps {
  readonly chips: readonly AttachChip[];
  /** Índice do chip "ativo" (backspace remove este). -1 = nenhum. */
  readonly active?: number;
}

export function AttachChips(props: AttachChipsProps): React.ReactElement | null {
  if (props.chips.length === 0) return null;
  const active = props.active ?? -1;
  return (
    <Box flexWrap="wrap">
      {props.chips.map((chip, i) => {
        const isActive = i === active;
        return (
          <Box key={chip.path} marginRight={1}>
            <Role name={isActive ? 'accent' : 'depth'}>
              {isActive ? '› ' : ''}@{chip.path}
              {chip.truncated ? '~' : ''}
            </Role>
            <Text> </Text>
            <Role name="fgDim">[⌫]</Role>
          </Box>
        );
      })}
    </Box>
  );
}
