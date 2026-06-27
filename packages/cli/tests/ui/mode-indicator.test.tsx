// EST-0959 · ADR-0055 — render do INDICADOR DE MODO (glifo+palavra, a11y).
//
// O indicador é SEMPRE visível e INEQUÍVOCO: a PALAVRA do modo carrega o sentido
// (não só a cor). Prova: a palavra aparece em cada modo, inclusive em NO_COLOR
// (mono), e o `unsafe` reusa o banner gritante (não regride o aviso loud).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { ModeIndicator } from '../../src/ui/components/ModeIndicator.js';

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

describe('ModeIndicator — a palavra do modo é sempre visível (a11y)', () => {
  it('plan ⇒ mostra a PALAVRA "PLAN" e a natureza read-only', () => {
    const { lastFrame } = wrap(<ModeIndicator mode="plan" columns={100} />, UTF8);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('PLAN');
    expect(out.toLowerCase()).toMatch(/read-only|só leitura/);
  });

  it('normal ⇒ mostra a PALAVRA "NORMAL"', () => {
    const { lastFrame } = wrap(<ModeIndicator mode="normal" columns={100} />, UTF8);
    expect(plain(lastFrame() ?? '')).toContain('NORMAL');
  });

  it('unsafe ⇒ reusa o banner gritante (PALAVRA "YOLO" + aprovação DESLIGADA)', () => {
    // EST-0959 — o modo interno `unsafe` é exibido como YOLO (nome de produto).
    const { lastFrame } = wrap(<ModeIndicator mode="unsafe" columns={100} />, UTF8);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('YOLO');
    expect(out).toMatch(/DESLIGADA/);
  });

  it('a11y NO_COLOR: a PALAVRA do modo sobrevive sem cor (não depende de cor)', () => {
    // EST-0959 — `unsafe` (identificador interno) é exibido como YOLO.
    const WORD: Record<'plan' | 'normal' | 'unsafe', string> = {
      plan: 'PLAN',
      normal: 'NORMAL',
      unsafe: 'YOLO',
    };
    for (const mode of ['plan', 'normal', 'unsafe'] as const) {
      const { lastFrame } = wrap(<ModeIndicator mode={mode} columns={100} />, NOCOLOR);
      const out = plain(lastFrame() ?? '');
      expect(out.toUpperCase()).toContain(WORD[mode]);
    }
  });

  it('estreito (columns<60): ainda mostra a palavra do modo (sem o caption)', () => {
    const { lastFrame } = wrap(<ModeIndicator mode="plan" columns={40} />, UTF8);
    expect(plain(lastFrame() ?? '')).toContain('PLAN');
  });
});
