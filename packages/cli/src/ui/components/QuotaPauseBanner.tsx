// PAUSA POR COTA — banner "pausado — cota esgotada" com contagem regressiva e as escolhas.
//
// O agente NÃO morreu: está esperando a cota liberar (o trabalho fica na memória e numa foto
// em disco). O banner diz isso, mostra quando volta e oferece: esperar (padrão, automático),
// tentar agora, ou parar salvando. O texto vem de `quotaPauseLines` (puro, testado); aqui só
// a decoração e o relógio de 1s.

import React, { useEffect, useState } from 'react';
import { Box } from 'ink';
import type { QuotaPauseView } from '@hiperplano/aluy-cli-core';
import { Glyph, Role } from '../theme/index.js';
import {
  QUOTA_PAUSE_CHOICES,
  quotaPauseLinha,
  quotaPauseLines,
} from '../../session/quota-pause-session.js';

export interface QuotaPauseBannerProps {
  readonly view: QuotaPauseView;
  /** Relógio injetável (teste). */
  readonly now?: () => number;
}

export function QuotaPauseBanner(props: QuotaPauseBannerProps): React.ReactElement {
  const clock = props.now ?? ((): number => Date.now());
  const [nowMs, setNowMs] = useState<number>(clock());
  useEffect(() => {
    const t = setInterval(() => setNowMs(clock()), 1000);
    return () => clearInterval(t);
  }, []);
  const [title, ...rest] = quotaPauseLines(props.view, nowMs);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Glyph name="clock" role="accent" />
        <Role name="accent"> {title}</Role>
      </Box>
      {rest.map((l, i) => (
        <Box key={i} paddingLeft={2}>
          <Role name="fg">{l}</Role>
        </Box>
      ))}
      <Box paddingLeft={2}>
        <Role name="fgDim">{QUOTA_PAUSE_CHOICES}</Role>
      </Box>
    </Box>
  );
}

/**
 * F9 — a presentação de PAUSA: uma linha estática no lugar da linha de trabalho (sem shimmer,
 * sem segundos de turno). O relógio de 1s só atualiza a contagem regressiva.
 */
export function QuotaPauseLine(
  props: QuotaPauseBannerProps & { readonly columns?: number },
): React.ReactElement {
  const clock = props.now ?? ((): number => Date.now());
  const [nowMs, setNowMs] = useState<number>(clock());
  useEffect(() => {
    const t = setInterval(() => setNowMs(clock()), 1000);
    return () => clearInterval(t);
  }, []);
  const max = props.columns !== undefined ? Math.max(20, props.columns - 4) : undefined;
  return (
    <Box>
      <Glyph name="clock" role="accent" />
      <Role name="accent"> {quotaPauseLinha(props.view, nowMs, max)}</Role>
    </Box>
  );
}
