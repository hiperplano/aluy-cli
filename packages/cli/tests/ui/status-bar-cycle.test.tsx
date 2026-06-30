// FATIA 1 (CICLOS/SUBCICLOS) — a StatusBar torna o CICLO DE VIDA DO LOOP visível:
// `↻ ciclo N/M · subciclos K/T` PROMINENTE quando há `cycleProgress`; some no uso
// simples (prop ausente). Espelha o estilo de `status-bar-custom.test.tsx`.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { StatusBar } from '../../src/ui/components/StatusBar.js';

function wrap(node: React.ReactElement) {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

describe('StatusBar — indicador de ciclo (FATIA 1)', () => {
  it('com cycleProgress (ciclo + subciclos) ⇒ mostra `↻ ciclo N/M · subcycles K/T`', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="aluy-strata"
        tokens={0}
        windowPct={0}
        columns={120}
        cycleProgress={{ iteration: 2, max: 5, subcyclesDone: 1, subcyclesTotal: 3 }}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('↻');
    expect(out).toContain('ciclo 2/5');
    expect(out).toContain('subciclos 1/3');
  });

  it('sem subciclos (subcyclesTotal=0) ⇒ mostra só `↻ cycle N/M`, sem `subcycles`', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="aluy-strata"
        tokens={0}
        windowPct={0}
        columns={120}
        cycleProgress={{ iteration: 1, max: 4, subcyclesDone: 0, subcyclesTotal: 0 }}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('ciclo 1/4');
    expect(out).not.toContain('subciclos');
  });

  it('sem cycleProgress (uso simples) ⇒ NÃO mostra o indicador cíclico', () => {
    const { lastFrame } = wrap(
      <StatusBar cwd="/proj" tier="aluy-strata" tokens={0} windowPct={0} columns={120} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('↻');
    expect(out).not.toContain('ciclo');
  });

  it('o indicador NÃO cai no narrow (estado-de-vida do loop, como o tier)', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="aluy-strata"
        tokens={0}
        windowPct={0}
        columns={50}
        cycleProgress={{ iteration: 3, max: 8, subcyclesDone: 2, subcyclesTotal: 4 }}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('ciclo 3/8');
    expect(out).toContain('aluy-strata'); // o tier segue
  });

  it('o indicador acende junto do tier (acompanha o frame vivo)', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="aluy-strata"
        tokens={1200}
        windowPct={10}
        columns={120}
        cycleProgress={{ iteration: 1, max: 3, subcyclesDone: 0, subcyclesTotal: 2 }}
      />,
    );
    const out = plain(lastFrame() ?? '');
    // ciclo e medidores coexistem sem se atropelar (frame não quebra).
    expect(out).toContain('ciclo 1/3');
    expect(out).toContain('subciclos 0/2');
    expect(out).toContain('janela');
  });
});
