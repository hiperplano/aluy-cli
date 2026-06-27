// EST-0958 — render do <BangBlock> (bloco de saída do `!comando`) e do indicador
// de MODO SHELL no <Composer>. a11y (§3.3): o estado vem SEMPRE com a palavra ao
// lado do glifo (nunca só cor) — provado também em NO_COLOR (mono).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { BangBlock } from '../../src/ui/components/BangBlock.js';
import { Composer } from '../../src/ui/components/Composer.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}
function wrap(node: React.ReactElement, env: NodeJS.ProcessEnv) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}
const UTF8 = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const NOCOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };

describe('BangBlock — bloco de saída do `!comando`', () => {
  it('ok ⇒ mostra `$ <cmd>`, a palavra "ok" e a saída', () => {
    const { lastFrame } = wrap(
      <BangBlock command="ls -la" status="ok" output={'a.txt\nb.txt'} />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('$ ls -la');
    expect(out).toContain('ok');
    expect(out).toContain('a.txt');
    expect(out).toContain('saída');
  });

  it('blocked ⇒ a palavra "bloqueado" acompanha o glifo (catraca negou)', () => {
    const { lastFrame } = wrap(
      <BangBlock command="rm -rf build" status="blocked" output="negado pela política" />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('$ rm -rf build');
    expect(out).toContain('bloqueado');
    expect(out).toContain('negado pela política');
  });

  it('a11y — em NO_COLOR (mono) o estado ainda é legível pela PALAVRA', () => {
    const { lastFrame } = wrap(<BangBlock command="pwd" status="err" output="erro X" />, NOCOLOR);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('erro'); // não depende de cor
  });
});

describe('Composer — indicador de MODO SHELL (`!`)', () => {
  it('com `!` no início, mostra o selo "shell" (Enter roda, não fala)', () => {
    const { lastFrame } = wrap(
      <Composer value="!git status" active shellMode showCursor={false} />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('shell');
    expect(out).toContain('!git status');
    expect(out.toLowerCase()).toContain('catraca'); // deixa claro que passa pela catraca
  });

  it('sem shellMode, o composer é o prompt normal (sem selo shell)', () => {
    const { lastFrame } = wrap(<Composer value="oi" active showCursor={false} />, UTF8);
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('shell');
  });
});
