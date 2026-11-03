// Auditoria — menu de `/` sem correspondência: diz o que foi digitado ("para /xyz"); sem texto
// digitado não repete "para /"; com resultados não mostra o aviso.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { SlashMenu } from '../../src/ui/components/SlashMenu.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');

function tela(props: Record<string, unknown>): string {
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } })}>
      <SlashMenu {...({ commands: [], selected: 0, ...props } as never)} />
    </ThemeProvider>,
  );
  const f = plain(r.lastFrame());
  r.unmount();
  return f;
}

describe('SlashMenu sem correspondência', () => {
  it('diz "nenhum comando encontrado para /xyz" com o que foi digitado', () => {
    expect(tela({ query: 'xyz' })).toContain('nenhum comando encontrado para /xyz');
  });

  it('o texto digitado é aparado (espaços não viram "para /  xyz  ")', () => {
    expect(tela({ query: '  xyz  ' })).toContain('nenhum comando encontrado para /xyz');
  });

  it('sem texto digitado não acrescenta o "para /"', () => {
    const f = tela({ query: '' });
    expect(f).toContain('nenhum comando encontrado');
    expect(f).not.toContain('para /');
  });
});
