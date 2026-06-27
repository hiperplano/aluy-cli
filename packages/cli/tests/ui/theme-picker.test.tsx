// EST-0966 — render do <ThemePicker> (ink-testing-library) + prova de que a PALETA
// muda quando o ThemeProvider troca de tema (DoD: componentes re-renderizam com o
// tema novo). Cobre: lista dark+light, marcador do ativo (●) e do selecionado (›),
// dica de teclas, e a troca da cor crua emitida (ANSI) ao re-prover o tema.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider, Role } from '../../src/ui/theme/context.js';
import { resolveThemeByName } from '../../src/ui/theme/themes.js';
import { ThemePicker } from '../../src/ui/components/ThemePicker.js';
import { THEMES } from '../../src/ui/theme/themes.js';

const TRUE_ENV = { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

function wrap(node: React.ReactElement, themeName = 'aluy-dark') {
  const theme = resolveThemeByName(themeName, { env: TRUE_ENV });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

describe('ThemePicker — seletor de tema', () => {
  it('mostra a dica de teclas (↑↓/enter/esc) e o verbo "trocar"', () => {
    const { lastFrame } = wrap(
      <ThemePicker themes={THEMES} selected={0} currentTheme="aluy-dark" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('↑↓');
    expect(out).toContain('trocar tema');
  });

  it('lista os 3 temas (dark + light + slate) com rótulo e resumo (PT-BR)', () => {
    const { lastFrame } = wrap(
      <ThemePicker themes={THEMES} selected={0} currentTheme="aluy-dark" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Aluy Dark');
    expect(out).toContain('Aluy Light');
    expect(out).toContain('Aluy Slate'); // EST-1010: o 3º tema do web
    expect(out).toContain('creme'); // resumo do light (fundo --stone-50)
    expect(out).toContain('terra escura'); // resumo do slate
  });

  it('marca o tema ATIVO com ● e o selecionado com › (a11y: não só cor)', () => {
    const { lastFrame } = wrap(
      <ThemePicker themes={THEMES} selected={1} currentTheme="aluy-dark" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('●'); // ativo (dark)
    expect(out).toContain('›'); // selecionado (light)
  });
});

describe('a PALETA muda ao trocar de tema (re-render)', () => {
  // O `accent` é o amber #DDA13F no dark e o âmbar-escuro #82530F no light. O Ink
  // emite a cor como ANSI truecolor (`38;2;R;G;B`). Provar que o MESMO componente
  // emite cor DIFERENTE sob cada provider = a paleta repinta tudo na troca.
  const dark = resolveThemeByName('aluy-dark', { env: TRUE_ENV });
  const light = resolveThemeByName('aluy-light', { env: TRUE_ENV });

  it('o mesmo <Role name="accent"> emite cor distinta sob dark vs light', () => {
    const darkFrame = render(
      <ThemeProvider theme={dark}>
        <Role name="accent">aluy</Role>
      </ThemeProvider>,
    ).lastFrame();
    const lightFrame = render(
      <ThemeProvider theme={light}>
        <Role name="accent">aluy</Role>
      </ThemeProvider>,
    ).lastFrame();
    // dark accent = #DDA13F → 221;161;63 ; light accent = #82530F → 130;83;15
    expect(darkFrame).toContain('221;161;63');
    expect(lightFrame).toContain('130;83;15');
    expect(darkFrame).not.toBe(lightFrame);
  });

  it('o ThemePicker em si repinta: o item selecionado tem cor diferente entre temas', () => {
    const darkOut =
      render(
        <ThemeProvider theme={dark}>
          <ThemePicker themes={THEMES} selected={0} currentTheme="aluy-dark" />
        </ThemeProvider>,
      ).lastFrame() ?? '';
    const lightOut =
      render(
        <ThemeProvider theme={light}>
          <ThemePicker themes={THEMES} selected={0} currentTheme="aluy-light" />
        </ThemeProvider>,
      ).lastFrame() ?? '';
    // o texto plano é o mesmo (mesma lista), mas os bytes ANSI de cor diferem.
    expect(plain(darkOut)).toContain('Aluy Dark');
    expect(plain(lightOut)).toContain('Aluy Dark');
    expect(darkOut).not.toBe(lightOut);
    expect(darkOut).toContain('221;161;63'); // accent dark no item selecionado
    expect(lightOut).toContain('130;83;15'); // accent light no item selecionado
  });
});
