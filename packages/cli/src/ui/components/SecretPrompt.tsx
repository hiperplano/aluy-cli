// ADR 0005 — <SecretPrompt>: o campo MASCARADO do `/secret`. Desenha só `•` (um por
// caractere) e a contagem; o valor em si NUNCA chega a este componente — a App guarda o
// texto num ref fora do estado do React e só entrega o COMPRIMENTO.

import React from 'react';
import { Box } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import { PickerFrame } from './PickerFrame.js';

export interface SecretPromptProps {
  readonly name: string;
  /** Quantos caracteres já foram digitados/colados (o valor nunca é passado). */
  readonly length: number;
  readonly save: boolean;
  readonly columns?: number;
}

/** Só bolinhas, limitadas à largura (o resto vira a contagem). PURA. */
export function maskDots(length: number, maxDots: number): string {
  return '•'.repeat(Math.max(0, Math.min(length, maxDots)));
}

export function SecretPrompt(props: SecretPromptProps): React.ReactElement {
  const theme = useTheme();
  const maxDots = Math.max(8, (props.columns ?? 80) - 24);
  return (
    <PickerFrame {...(props.columns !== undefined ? { columns: props.columns } : {})}>
      <Box>
        <Role name="fg">segredo ${props.name}</Role>
        <Role name="fgDim">
          {props.save ? ' · será salvo cifrado neste projeto' : ' · só nesta sessão'}
        </Role>
      </Box>
      <Box>
        <Role name="depth">{theme.glyph('prompt')} </Role>
        <Role name="fg">{maskDots(props.length, maxDots)}</Role>
        <Role name="accent">{theme.glyph('cursor')}</Role>
        {props.length > 0 && <Role name="fgDim"> ({props.length})</Role>}
      </Box>
      <Box>
        <Role name="fgDim">
          cole ou digite — nada aparece na tela, no chat nem no histórico · enter confirma · esc
          cancela
        </Role>
      </Box>
    </PickerFrame>
  );
}
