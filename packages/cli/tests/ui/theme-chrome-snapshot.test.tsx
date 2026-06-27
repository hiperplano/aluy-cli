// EST-1010 · /theme — SNAPSHOT do CHROME nos 3 temas do web (light/dark/slate).
//
// DoD: "snapshot dos 3 temas (chrome com a paleta de cada)". Renderiza o <Header>
// (marca Λ + `Aluy Cli` + tier + ◍ broker — compacto, EST-0989) sob cada tema
// RESOLVIDO em truecolor e congela o frame
// CRU (com os códigos SGR), provando que cada tema pinta a SUA paleta — o accent
// âmbar de cada um, o `fg`/`fgDim`/`depth` distintos. Os snapshots inline também
// documentam, em um lugar só, as cores efetivas que cada tema emite no terminal.
//
// Por que truecolor: é o modo que separa os 3 temas (a paleta por tema). Em ansi16 os
// escuros (dark/slate) colapsam na MESMA degradação — coberto à parte (esc-seq de cor
// genérica), aqui o foco é a paleta fiel ao web.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveThemeByName, THEMES } from '../../src/ui/theme/themes.js';
import { Header } from '../../src/ui/components/Header.js';

const TRUE_ENV = { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

function renderHeader(themeName: string): string {
  const theme = resolveThemeByName(themeName, { env: TRUE_ENV });
  // compacto (rows baixo) ⇒ header de 1 linha `Λ aluy <tier> · ◍ broker` — estável,
  // sem o wordmark multilinha (cujo ASCII-art faria o snapshot frágil a colunas).
  const { lastFrame } = render(
    <ThemeProvider theme={theme}>
      <Header tier="aluy-deep" columns={80} rows={10} />
    </ThemeProvider>,
  );
  return lastFrame() ?? '';
}

/** Extrai os hex `38;2;R;G;B` (truecolor SGR) presentes no frame, em ordem. */
function truecolorHexes(frame: string): string[] {
  const out: string[] = [];
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[[0-9;]*?38;2;(\d+);(\d+);(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(frame)) !== null) {
    const hex = [m[1], m[2], m[3]]
      .map((n) => Number(n).toString(16).padStart(2, '0').toUpperCase())
      .join('');
    out.push(`#${hex}`);
  }
  return out;
}

describe('chrome (<Header>) nos 3 temas do web — snapshot da paleta', () => {
  it('os 3 temas existem (light/dark/slate)', () => {
    expect(THEMES.map((t) => t.name)).toEqual(['aluy-dark', 'aluy-light', 'aluy-slate']);
  });

  it('dark — accent âmbar #DDA13F + fgDim neutro + depth ciano', () => {
    const hexes = truecolorHexes(renderHeader('aluy-dark'));
    expect(hexes).toContain('#DDA13F'); // accent (Λ)
    expect(hexes).toContain('#8A7F6D'); // fgDim (label `aluy`)
    expect(hexes).toContain('#5BA8A2'); // depth (◍ broker)
  });

  it('light — accent escurecido #82530F (AA no creme) + fg quase-preto', () => {
    const hexes = truecolorHexes(renderHeader('aluy-light'));
    expect(hexes).toContain('#82530F'); // accent escurecido p/ AA
    expect(hexes).toContain('#1A1712'); // fg (tier)
    expect(hexes).not.toContain('#DDA13F'); // NÃO usa o âmbar claro do dark
  });

  it('slate — accent âmbar #DDA13F (= dark) mas fgDim AREIA #B0A593 (warm)', () => {
    const hexes = truecolorHexes(renderHeader('aluy-slate'));
    expect(hexes).toContain('#DDA13F'); // mesmo accent do dark
    expect(hexes).toContain('#B0A593'); // fgDim areia (≠ dark neutro)
    expect(hexes).not.toContain('#8A7F6D'); // NÃO o fgDim neutro do dark
  });

  it('snapshot da PALETA truecolor de cada tema (chrome do header)', () => {
    const palettes = Object.fromEntries(
      THEMES.map((t) => [t.name, { bg: t.bg, header: truecolorHexes(renderHeader(t.name)) }]),
    );
    expect(palettes).toMatchInlineSnapshot(`
      {
        "aluy-dark": {
          "bg": "#070707",
          "header": [
            "#DDA13F",
            "#F2EEE8",
            "#8A7F6D",
            "#F2EEE8",
            "#8A7F6D",
            "#5BA8A2",
          ],
        },
        "aluy-light": {
          "bg": "#F4ECDC",
          "header": [
            "#82530F",
            "#1A1712",
            "#544B3C",
            "#1A1712",
            "#544B3C",
            "#2E6E69",
          ],
        },
        "aluy-slate": {
          "bg": "#0E0C09",
          "header": [
            "#DDA13F",
            "#F2EEE8",
            "#B0A593",
            "#F2EEE8",
            "#B0A593",
            "#5BA8A2",
          ],
        },
      }
    `);
  });
});
