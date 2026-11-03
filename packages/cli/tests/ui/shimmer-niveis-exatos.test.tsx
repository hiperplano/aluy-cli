// Auditoria — valores EXATOS do brilho (largura da banda, halo, cauda, frame negativo,
// offset de trechos) e o detalhe `(fase · ↓ tokens · s)` ao lado do verbo na caixa da resposta.
// Os testes antigos só provavam que a banda "anda" (níveis diferentes); mudar a largura do halo
// ou o deslocamento passava despercebido.

import React from 'react';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { ShimmerText, shimmerTextLevels } from '../../src/ui/components/ShimmerText.js';
import { AluyBlock } from '../../src/ui/components/TurnBlock.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

let nivel = chalk.level;
beforeEach(() => {
  nivel = chalk.level;
  chalk.level = 3;
});
afterEach(() => {
  chalk.level = nivel;
});

const truecolor = resolveTheme({
  env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
});

function tela(el: React.ReactElement, theme = truecolor): string {
  const r = render(
    <ThemeProvider theme={theme}>
      <Box>{el}</Box>
    </ThemeProvider>,
  );
  const f = r.lastFrame() ?? '';
  r.unmount();
  return f;
}

describe('shimmerTextLevels · valores exatos', () => {
  it('cabeça na coluna 5 de 10: pico em 4-6, halo em 2-3 e 7-8, repouso no resto', () => {
    expect(shimmerTextLevels(10, 5).join('')).toBe('0011222110');
  });

  it('cabeça na borda: o pico e o halo são cortados pelo texto (largura constante)', () => {
    expect(shimmerTextLevels(10, 0).join('')).toBe('2211000000');
    expect(shimmerTextLevels(10, 9).join('')).toBe('0000001122');
  });

  it('a cauda: a cabeça sai do texto por 6 colunas antes de recomeçar (período = largura + 6)', () => {
    // frame 13 de período 16: cabeça na coluna 13 ⇒ a coluna 9 já está a 4 de distância
    expect(shimmerTextLevels(10, 13).join('')).toBe('0000000000');
    expect(shimmerTextLevels(10, 16).join('')).toBe(shimmerTextLevels(10, 0).join(''));
  });

  it('frame NEGATIVO volta ao fim do período (módulo positivo), não a uma cabeça fantasma', () => {
    // -1 ≡ 15 (período 16): cabeça longe do texto ⇒ tudo em repouso
    expect(shimmerTextLevels(10, -1).join('')).toBe('0000000000');
    expect(shimmerTextLevels(10, -1).join('')).toBe(shimmerTextLevels(10, 15).join(''));
  });

  it('largura zero ⇒ vazio', () => {
    expect(shimmerTextLevels(0, 3)).toEqual([]);
  });
});

describe('ShimmerText · trechos de um conjunto contínuo (offset/total)', () => {
  it('o 2º trecho usa as colunas CERTAS do conjunto: com offset difere de sem offset', () => {
    const comOffset = tela(<ShimmerText text="abc" frame={8} offset={6} total={12} />);
    const semOffset = tela(<ShimmerText text="abc" frame={8} total={12} />);
    expect(plain(comOffset)).toBe('abc');
    expect(comOffset).not.toBe(semOffset);
  });
});

describe('caixa da resposta · detalhe ao lado do verbo', () => {
  const claro = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  const f = (el: React.ReactElement): string =>
    plain(render(<ThemeProvider theme={claro}>{el}</ThemeProvider>).lastFrame() ?? '');

  it('streaming com verbo e detalhe: `⋯ Verbo… (fase · ↓ tokens · s)`', () => {
    const out = f(
      <AluyBlock
        text=""
        streaming
        reasoning="hmm"
        verbo="Costurando"
        detalhe="(pensando · ↓ 1,2k tokens · 12s)"
        frame={2}
        isCurrent
      />,
    );
    expect(out).toContain('⋯ Costurando… (pensando · ↓ 1,2k tokens · 12s)');
  });

  it('streaming com verbo e SEM detalhe: só o verbo', () => {
    const out = f(
      <AluyBlock text="" streaming reasoning="hmm" verbo="Costurando" frame={2} isCurrent />,
    );
    expect(out).toContain('⋯ Costurando…');
    expect(out).not.toContain('(');
  });
});
