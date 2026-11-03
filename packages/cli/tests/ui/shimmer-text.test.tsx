// SHIMMER — o brilho da cor Aluy varrendo os agentes RODANDO (e o rótulo `pensando…`).
//
// No harness o Ink não emite código de cor (stdout não é TTY), então a PROVA de movimento
// é feita (a) na função pura `shimmerTextLevels` e (b) forçando o nível de cor do chalk
// para capturar os escapes ANSI reais do componente.

import React from 'react';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { ShimmerText, shimmerTextLevels } from '../../src/ui/components/ShimmerText.js';
import { SubAgents, type SubAgentChildView } from '../../src/ui/components/SubAgents.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

const truecolor = (): ReturnType<typeof resolveTheme> =>
  resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' } });

let nivel = chalk.level;
beforeEach(() => {
  nivel = chalk.level;
  chalk.level = 3;
});
afterEach(() => {
  chalk.level = nivel;
});

function tela(el: React.ReactElement, theme = truecolor()): string {
  const r = render(
    <ThemeProvider theme={theme}>
      <Box>{el}</Box>
    </ThemeProvider>,
  );
  const f = r.lastFrame() ?? '';
  r.unmount();
  return f;
}

const rodando: SubAgentChildView = { label: 'rust', status: 'running' };
const pronto: SubAgentChildView = { label: 'go', status: 'done', summary: '1.2k tokens' };
const falho: SubAgentChildView = { label: 'py', status: 'fail', stop: 'error' };
const pausado: SubAgentChildView = { label: 'js', status: 'cancelled', stop: 'paused' };

describe('shimmerTextLevels (puro)', () => {
  it('a banda ANDA: níveis diferentes entre frames, mesma largura', () => {
    const a = shimmerTextLevels(14, 2);
    const b = shimmerTextLevels(14, 6);
    expect(a).toHaveLength(14);
    expect(b).toHaveLength(14);
    expect(a.join('')).not.toBe(b.join(''));
    expect(a.includes(2)).toBe(true);
  });
  it('é periódico e tolera frame inválido', () => {
    expect(shimmerTextLevels(10, 3).join('')).toBe(shimmerTextLevels(10, 3 + 16).join(''));
    expect(shimmerTextLevels(10, Number.NaN)).toHaveLength(10);
  });
});

describe('<SubAgents> shimmer', () => {
  it('agente RODANDO: os escapes de cor mudam entre frames; o TEXTO não muda', () => {
    const f1 = tela(<SubAgents childrenStatus={[rodando]} frame={2} />);
    const f2 = tela(<SubAgents childrenStatus={[rodando]} frame={8} />);
    expect(f1).not.toBe(f2);
    expect(plain(f1)).toBe(plain(f2));
    expect(plain(f1)).toContain('[rust]');
    expect(plain(f1)).toContain('rodando');
  });

  it('terminado/falho/pausado: ESTÁTICO (idêntico em qualquer frame)', () => {
    for (const c of [pronto, falho, pausado]) {
      const f1 = tela(<SubAgents childrenStatus={[c]} frame={2} />);
      const f2 = tela(<SubAgents childrenStatus={[c]} frame={8} />);
      expect(f1).toBe(f2);
    }
  });

  it('settled (scrollback) nunca brilha', () => {
    const f1 = tela(<SubAgents childrenStatus={[rodando]} settled frame={2} />);
    const f2 = tela(<SubAgents childrenStatus={[rodando]} settled frame={8} />);
    expect(f1).toBe(f2);
  });

  it('só o filho rodando varia quando há mistura', () => {
    const linhas = (frame: number): string[] =>
      tela(<SubAgents childrenStatus={[rodando, pronto]} frame={frame} />).split('\n');
    const a = linhas(2);
    const b = linhas(8);
    const iPronto = a.findIndex((l) => plain(l).includes('[go]'));
    const iRodando = a.findIndex((l) => plain(l).includes('[rust]'));
    expect(a[iPronto]).toBe(b[iPronto]);
    expect(a[iRodando]).not.toBe(b[iRodando]);
  });
});

describe('degradação', () => {
  it('NO_COLOR ⇒ texto PLANO, sem nenhum escape, igual em qualquer frame', () => {
    const mono = resolveTheme({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8' } });
    const f1 = tela(<ShimmerText text="pensando…" frame={2} />, mono);
    const f2 = tela(<ShimmerText text="pensando…" frame={5} />, mono);
    expect(f1).toBe('pensando…');
    expect(f2).toBe('pensando…');
  });

  it('ansi16 ⇒ alternância negrito/dim: varia com o frame e usa bold/dim', () => {
    const t = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm' } });
    const f1 = tela(<ShimmerText text="pensando…" frame={1} />, t);
    const f2 = tela(<ShimmerText text="pensando…" frame={7} />, t);
    expect(f1).not.toBe(f2);
    expect(f1).toContain(ESC + '[1m'); // negrito
    expect(f1).toContain(ESC + '[2m'); // dim
    expect(plain(f1)).toBe('pensando…');
  });

  it('reduced-motion (animate=false) ⇒ estático', () => {
    const t = resolveTheme({
      env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      animate: false,
    });
    const f1 = tela(<ShimmerText text="pensando…" frame={1} />, t);
    const f2 = tela(<ShimmerText text="pensando…" frame={7} />, t);
    expect(f1).toBe(f2);
  });
});
