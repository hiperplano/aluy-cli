// EST-0965 (fix --unsafe) — ÂNCORA da altura do `<ModeIndicator>` no orçamento.
//
// O orçamento anti-flicker (live-budget.ts) reserva linhas p/ o `<ModeIndicator>`
// do rodapé: `MODE_INDICATOR_BASE_ROWS` (1, já no LIVE_CHROME_ROWS) p/ plan/normal e
// `UNSAFE_INDICATOR_ROWS` (2) p/ o BANNER de unsafe. Se essas constantes divergirem
// da altura REAL do componente, a região viva volta a estourar `rows` em `--unsafe`
// (o flicker). Então RENDERIZAMOS o `<ModeIndicator>` de verdade (Ink testing) e
// afirmamos que a altura medida bate com a constante — o teste quebra se o banner
// mudar de forma (mais texto, borda, multi-linha) e força revisar o orçamento.
//
// Por que a largura crítica: o <UnsafeBanner> é uma <Box> com a frase longa
// (~81 colunas). Em larguras MÉDIAS (60–80 col) ela QUEBRA p/ 2 linhas — o pior
// caso, e o que `UNSAFE_INDICATOR_ROWS` precisa cobrir.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { ModeIndicator } from '../../src/ui/components/ModeIndicator.js';
import { MODE_INDICATOR_BASE_ROWS, UNSAFE_INDICATOR_ROWS } from '../../src/session/live-budget.js';
import type { SessionMode } from '@aluy/cli-core';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');
const env = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

/**
 * Altura RENDERIZADA (linhas não-vazias) do `<ModeIndicator>` numa <Box> de largura
 * fixa `cols` — é como o Ink quebra o texto no terminal real. Tira linhas em branco
 * de borda que o frame possa acrescentar.
 */
function renderedHeight(mode: SessionMode, cols: number): number {
  const theme = resolveTheme({ env });
  const { lastFrame } = render(
    <ThemeProvider theme={theme}>
      <Box width={cols} flexDirection="column">
        <ModeIndicator mode={mode} columns={cols} />
      </Box>
    </ThemeProvider>,
  );
  return plain(lastFrame() ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '').length;
}

describe('ModeIndicator — âncora de altura p/ o orçamento anti-flicker (EST-0965)', () => {
  it('plan/normal ocupam MODE_INDICATOR_BASE_ROWS (1 linha) em qualquer largura', () => {
    for (const cols of [40, 60, 80, 100, 120]) {
      expect(renderedHeight('plan', cols), `plan cols=${cols}`).toBe(MODE_INDICATOR_BASE_ROWS);
      expect(renderedHeight('normal', cols), `normal cols=${cols}`).toBe(MODE_INDICATOR_BASE_ROWS);
    }
  });

  it('unsafe (banner): no PIOR caso de largura bate em UNSAFE_INDICATOR_ROWS — e nunca o excede', () => {
    // A frase longa quebra p/ 2 linhas em larguras médias (60–80 col). O orçamento
    // reserva UNSAFE_INDICATOR_ROWS (2) — a altura real NUNCA pode passar disso, ou
    // a viva estoura `rows` em --unsafe (o flicker que esta EST corrige).
    let maxObserved = 0;
    for (const cols of [40, 50, 60, 70, 80, 100, 120]) {
      const h = renderedHeight('unsafe', cols);
      expect(h, `unsafe cols=${cols} excede a reserva`).toBeLessThanOrEqual(UNSAFE_INDICATOR_ROWS);
      maxObserved = Math.max(maxObserved, h);
    }
    // E a reserva não é folgada demais: ALGUMA largura realiza o pior caso (2 linhas).
    expect(maxObserved).toBe(UNSAFE_INDICATOR_ROWS);
  });
});
