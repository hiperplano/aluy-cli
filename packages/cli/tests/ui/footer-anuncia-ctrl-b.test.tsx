// F-BG — o rodapé tem de ANUNCIAR o Ctrl+B onde ele funciona.
//
// Achado ao verificar o fan-out na TUI real (21/09/2026): o rodapé mostrava `esc para o
// pai · F8 para tudo · ctrl-t ver/parar` e nada sobre soltar. A tecla funcionava, mas
// ninguém a descobriria sozinho — e uma afordância que não é anunciada não existe para
// quem usa. Onde ela NÃO age (repouso, decisão), o rodapé não pode prometê-la.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { FooterHints } from '../../src/ui/components/FooterHints.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string) => (s ?? '').replace(ANSI, '');

function texto(state: React.ComponentProps<typeof FooterHints>['state']): string {
  const theme = resolveTheme({ env: ENV });
  const { lastFrame } = render(
    <ThemeProvider theme={theme}>
      <FooterHints state={state} />
    </ThemeProvider>,
  );
  return plain(lastFrame() ?? '');
}

describe('FooterHints — o Ctrl+B é anunciado onde age', () => {
  it('pensando / falando: "ctrl-b soltar" (é onde um comando pode prender o turno)', () => {
    expect(texto('thinking')).toContain('ctrl-b soltar');
    expect(texto('streaming')).toContain('ctrl-b soltar');
  });

  it('trabalho com sub-agentes vivos: "ctrl-b soltar" ao lado do esc/F8', () => {
    const f = texto('work-subagents');
    expect(f).toContain('ctrl-b soltar');
    expect(f).toContain('esc para o pai');
    expect(f).toContain('F8 para tudo');
  });

  it('em repouso e em decisão NÃO promete o que não faz', () => {
    expect(texto('idle')).not.toContain('ctrl-b');
    expect(texto('ask')).not.toContain('ctrl-b');
  });
});
