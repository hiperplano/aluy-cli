// EST-0948 (composer/sessão) — <Composer> renderiza o cursor NA POSIÇÃO (não só no
// fim) e com LARGURA CONSTANTE (anti-jitter EST-0956/0984). Cobertura:
//   (a) cursor no FIM ⇒ o ● GROSSO segue o texto (1 coluna; EST-0965: mesma grossura
//       do thinkingCursor amarelo, mas BRANCO/fg — só a cor difere);
//   (b) cursor NO MEIO ⇒ a barra NÃO aparece (o char sob o cursor vai em inverse, sem
//       coluna extra) — o texto contíguo permanece íntegro;
//   (c) cursor no INÍCIO ⇒ o realce cai no 1º char, texto íntegro;
//   (d) largura textual ESTÁVEL ao andar com o cursor pelo meio (sem jitter);
//   (e) composer INATIVO ⇒ sem cursor.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { Composer } from '../../src/ui/components/Composer.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
// EST-0965 — o cursor do composer agora é ● (GROSSO/arredondado), a MESMA grossura do
// thinkingCursor amarelo de trabalho; o que muda é a COR (composer = branco/fg).
const CURSOR = '●';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}
function frameOf(node: React.ReactElement): string {
  const theme = resolveTheme({ env: ENV });
  return plain(render(<ThemeProvider theme={theme}>{node}</ThemeProvider>).lastFrame() ?? '');
}

describe('Composer — cursor renderizado NA posição (EST-0948)', () => {
  it('(a) cursor no FIM ⇒ a barra ▏ segue o texto', () => {
    const out = frameOf(<Composer value="abcd" cursorPos={4} active showCursor />);
    expect(out).toContain('abcd' + CURSOR);
  });

  it('(b) cursor NO MEIO ⇒ a barra de FIM some (o char sob o cursor é realçado, sem coluna extra)', () => {
    // pos 2 de "abcd": o cursor está sobre o "c"; NÃO há barra-de-fim depois do "d".
    const out = frameOf(<Composer value="abcd" cursorPos={2} active showCursor />);
    expect(out).not.toContain('abcd' + CURSOR); // a barra de fim não aparece no meio
    // o texto completo continua presente e legível (a, b, c, d todos lá).
    expect(out.replace(new RegExp(CURSOR, 'g'), '')).toContain('abcd');
  });

  it('(c) cursor no INÍCIO ⇒ texto íntegro, sem barra de fim', () => {
    const out = frameOf(<Composer value="abcd" cursorPos={0} active showCursor />);
    expect(out).toContain('abcd');
    expect(out).not.toContain('abcd' + CURSOR);
  });

  it('(d) LARGURA constante: andar com o cursor pelo MEIO não muda a largura do texto', () => {
    // A medição: a 1ª linha (sem trailing trim distorcer o miolo) tem o MESMO
    // comprimento de texto visível com o cursor em posições internas diferentes.
    const widthAt = (pos: number): number => {
      const out = frameOf(<Composer value="abcdef" cursorPos={pos} active showCursor />);
      const firstLine = out.split('\n')[0] ?? '';
      // remove o glifo de cursor p/ comparar só o "esqueleto" de texto.
      return firstLine.replace(new RegExp(CURSOR, 'g'), '').length;
    };
    const w2 = widthAt(2);
    const w3 = widthAt(3);
    const w4 = widthAt(4);
    expect(w3).toBe(w2);
    expect(w4).toBe(w2);
  });

  it('(e) composer INATIVO ⇒ sem cursor (foco saiu)', () => {
    const out = frameOf(<Composer value="abcd" cursorPos={2} active={false} showCursor />);
    expect(out).not.toContain(CURSOR);
    expect(out).toContain('abcd');
  });

  it('back-compat: sem cursorPos ⇒ cursor no FIM (append-only de antes)', () => {
    const out = frameOf(<Composer value="abc" active showCursor />);
    expect(out).toContain('abc' + CURSOR);
  });

  it('EST-0965 — o cursor do composer tem a MESMA GROSSURA do thinkingCursor (mesmo glifo ●)', () => {
    const theme = resolveTheme({ env: ENV });
    // o Tiago: "a grossura do amarelo (thinking) e do branco (composer) devem ser as
    // mesmas, grossinho" ⇒ MESMO glifo; a cor é que separa os papéis.
    expect(theme.glyph('cursor')).toBe(theme.glyph('thinkingCursor'));
    expect(theme.glyph('cursor')).toBe('●');
  });

  it('EST-0965 — fallback degrada IGUAL ao thinkingCursor (SAFE ●, ASCII *)', () => {
    const safe = resolveTheme({ env: { ...ENV, ALUY_SAFE_GLYPHS: '1' } });
    expect(safe.glyph('cursor')).toBe(safe.glyph('thinkingCursor'));
    const ascii = resolveTheme({ env: { TERM: 'linux' } });
    expect(ascii.glyph('cursor')).toBe(ascii.glyph('thinkingCursor'));
    expect(ascii.glyph('cursor')).toBe('*');
  });
});
