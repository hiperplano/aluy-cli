// EST-0984 — <AluyLoader>: a marca Λ do Aluy "desenha + respira" no terminal.
//
// Espelha o feel do loader web do DS (AluyGlyph/AluyLoader + chat.css): duas pernas
// que montam (esquerda→direita) e respiram (accent↔accentDim). Aqui travamos:
//   - render: `Λ` (U+039B) quando o terminal é capaz; `/\` no fallback ASCII;
//   - ANTI-JITTER (EST-0956): largura/altura ESTÁVEL entre frames (só a cor muda);
//   - o pulso/respiro existe (cores diferem entre frames do ciclo);
//   - reduced-motion (animate=false) ⇒ marca SÓLIDA (sem movimento), sentido intacto;
//   - substitui o `◇` como MARCA (o glifo `aluy` virou Λ).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import {
  AluyLoader,
  legRole,
  ALUY_LOADER_CYCLE,
  ALUY_LOADER_RIGHT_DELAY,
} from '../../src/ui/components/AluyLoader.js';

const UTF8 = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
const ASCII = { TERM: 'linux' };
const NOANIM = { ...UTF8, ALUY_NO_ANIM: '1' };

function frameOf(env: NodeJS.ProcessEnv, node: React.ReactElement): string {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>).lastFrame() ?? '';
}
// largura "visível" da última (única) linha, ignorando códigos ANSI de cor.
function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  const noAnsi = s.replace(/\[[0-9;]*m/g, '');
  return [...noAnsi.split('\n').pop()!].length;
}
function lineCount(s: string): number {
  return s.split('\n').length;
}

describe('AluyLoader — render por capacidade (Λ vs /\\)', () => {
  it('Unicode capaz ⇒ renderiza Λ (U+039B), substituindo o ◇ como marca', () => {
    const out = frameOf(UTF8, <AluyLoader frame={0} />);
    expect(out).toContain('Λ');
    expect(out).not.toContain('◇');
  });

  it('fallback ASCII ⇒ renderiza as duas pernas /\\', () => {
    const out = frameOf(ASCII, <AluyLoader frame={0} />);
    expect(out).toContain('/');
    expect(out).toContain('\\');
    expect(out).not.toContain('Λ');
  });
});

describe('AluyLoader — anti-jitter (largura/altura estável entre frames)', () => {
  it('Unicode: a LARGURA visível é igual em TODOS os frames do ciclo', () => {
    const widths = Array.from({ length: ALUY_LOADER_CYCLE * 2 }, (_, f) =>
      visibleWidth(frameOf(UTF8, <AluyLoader frame={f} />)),
    );
    const w0 = widths[0]!;
    for (const w of widths) expect(w).toBe(w0);
  });

  it('ASCII: a LARGURA visível das pernas /\\ é estável (sempre 2 células)', () => {
    const widths = Array.from({ length: ALUY_LOADER_CYCLE * 2 }, (_, f) =>
      visibleWidth(frameOf(ASCII, <AluyLoader frame={f} />)),
    );
    for (const w of widths) expect(w).toBe(2);
  });

  it('a ALTURA (nº de linhas) é 1 e estável em todos os frames', () => {
    for (let f = 0; f < ALUY_LOADER_CYCLE * 2; f++) {
      expect(lineCount(frameOf(UTF8, <AluyLoader frame={f} />))).toBe(1);
      expect(lineCount(frameOf(ASCII, <AluyLoader frame={f} />))).toBe(1);
    }
  });
});

describe('AluyLoader — pulso/respiro (cores mudam ao longo do ciclo)', () => {
  it('legRole alterna accent (1ª metade) ↔ accentDim (2ª metade)', () => {
    expect(legRole(0, 0)).toBe('accent');
    expect(legRole(ALUY_LOADER_CYCLE / 2, 0)).toBe('accentDim');
    // perna direita monta DEPOIS (atraso): no frame 0 ainda está no fim do ciclo.
    expect(legRole(0, ALUY_LOADER_RIGHT_DELAY)).toBe('accentDim');
    expect(legRole(ALUY_LOADER_RIGHT_DELAY, ALUY_LOADER_RIGHT_DELAY)).toBe('accent');
  });

  it('a SAÍDA renderizada difere entre a fase "acesa" e a "apagada" (há pulso)', () => {
    const lit = frameOf(UTF8, <AluyLoader frame={0} />); // accent
    const dim = frameOf(UTF8, <AluyLoader frame={ALUY_LOADER_CYCLE / 2} />); // accentDim
    expect(lit).not.toBe(dim); // cor diferente ⇒ bytes ANSI diferentes
  });

  it('ASCII: a perna esquerda acende ANTES da direita (montagem L→R)', () => {
    // no frame 0: esquerda accent, direita ainda accentDim (atraso) ⇒ assimetria.
    expect(legRole(0, 0)).toBe('accent');
    expect(legRole(0, ALUY_LOADER_RIGHT_DELAY)).toBe('accentDim');
  });
});

describe('AluyLoader — reduced-motion (marca sólida, sem movimento)', () => {
  it('animate=false ⇒ Λ SÓLIDO e IDÊNTICO em qualquer frame', () => {
    const a = frameOf(NOANIM, <AluyLoader frame={0} />);
    const b = frameOf(NOANIM, <AluyLoader frame={3} />);
    expect(a).toContain('Λ');
    expect(a).toBe(b); // congelado: sem pulso
  });
});
