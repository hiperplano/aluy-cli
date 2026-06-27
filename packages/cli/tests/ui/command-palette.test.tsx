// EST-0961 — render do <CommandPalette> (ink-testing-library). Cobre: dica de
// teclas, lista filtrada, realce do match, prefixo › no selecionado (a11y),
// estado vazio e a busca exibida. Tokens-only (papéis do DS).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { CommandPalette } from '../../src/ui/components/CommandPalette.js';
import { filterPalette } from '../../src/slash/commands.js';

function wrap(node: React.ReactElement) {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

describe('CommandPalette — render da paleta de comandos', () => {
  it('mostra a dica de teclas (↑↓/enter/esc)', () => {
    const { lastFrame } = wrap(<CommandPalette hits={filterPalette('')} selected={0} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('↑↓');
    expect(out).toContain('executa');
    expect(out).toContain('esc fecha');
  });

  it('lista os comandos (vazia ⇒ tudo, dentro da janela)', () => {
    const { lastFrame } = wrap(<CommandPalette hits={filterPalette('')} selected={0} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('/model');
    // `/effort` (alto na lista) substitui o antigo assert de `/theme`: a lista de comandos
    // CRESCEU (/effort, /mcp reconnect/reload) e a paleta tem janela INTERNA (comandos fora
    // dela alcançam-se digitando p/ filtrar) — cravar um comando do FIM (/theme) virou brittle.
    expect(out).toContain('/effort');
  });

  it('expõe a AÇÃO "trocar modo" (não-slash) quando buscada', () => {
    const { lastFrame } = wrap(
      <CommandPalette hits={filterPalette('modo')} selected={0} query="modo" />,
    );
    expect(plain(lastFrame() ?? '')).toContain('trocar modo');
  });

  it('filtra pela query fuzzy', () => {
    const { lastFrame } = wrap(
      <CommandPalette hits={filterPalette('theme')} selected={0} query="theme" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('/theme');
    expect(out).not.toContain('/login');
  });

  it('marca o item selecionado com o prefixo › (a11y: não só cor)', () => {
    const { lastFrame } = wrap(<CommandPalette hits={filterPalette('')} selected={0} />);
    expect(plain(lastFrame() ?? '')).toContain('›');
  });

  it('exibe a busca digitada', () => {
    const { lastFrame } = wrap(
      <CommandPalette hits={filterPalette('mod')} selected={0} query="mod" />,
    );
    expect(plain(lastFrame() ?? '')).toContain('mod');
  });

  it('lista vazia mostra "nenhum comando casa"', () => {
    const { lastFrame } = wrap(<CommandPalette hits={[]} selected={0} query="zzz" />);
    expect(plain(lastFrame() ?? '')).toContain('nenhum comando casa');
  });

  it('janela: muitos itens NÃO despejam a lista toda (mostra o resumo "… a mais")', () => {
    const { lastFrame } = wrap(
      <CommandPalette hits={filterPalette('')} selected={0} maxRows={3} />,
    );
    expect(plain(lastFrame() ?? '')).toContain('a mais');
  });
});
