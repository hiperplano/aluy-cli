// F195 — <BusyPulse>: o PULSO "trabalhando" da StatusBar (blocos grossos que enchem/
// esvaziam). Provas: a onda triangular é PURA e estável (anti-flicker), o componente
// desenha SEMPRE `width` blocos (largura constante) e a StatusBar só o mostra quando
// `busy` (e não em narrow).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import {
  BusyPulse,
  pulseLit,
  pulseCellRole,
  DEFAULT_PULSE_WIDTH,
} from '../../src/ui/components/BusyPulse.js';
import { StatusBar } from '../../src/ui/components/StatusBar.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => (s ?? '').replace(ANSI, '');

function wrap(
  node: React.ReactElement,
  env: NodeJS.ProcessEnv = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' },
) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

describe('pulseLit — onda TRIANGULAR pura (enche 1→w, esvazia w→1)', () => {
  it('sobe até a largura e desce de volta (respira, não "pula")', () => {
    // w=4 ⇒ período 6: 1,2,3,4,3,2, e repete.
    expect(pulseLit(0, 4)).toBe(1);
    expect(pulseLit(1, 4)).toBe(2);
    expect(pulseLit(2, 4)).toBe(3);
    expect(pulseLit(3, 4)).toBe(4); // cheio
    expect(pulseLit(4, 4)).toBe(3); // esvazia
    expect(pulseLit(5, 4)).toBe(2);
    expect(pulseLit(6, 4)).toBe(1); // recomeça
  });

  it('nunca estoura os limites [1..width] p/ qualquer frame', () => {
    for (let f = -20; f <= 40; f += 1) {
      const lit = pulseLit(f, 5);
      expect(lit).toBeGreaterThanOrEqual(1);
      expect(lit).toBeLessThanOrEqual(5);
    }
  });

  it('normaliza frame negativo / não-finito (fail-safe, sem NaN)', () => {
    expect(pulseLit(-1, 4)).toBeGreaterThanOrEqual(1);
    expect(pulseLit(Number.NaN, 4)).toBe(1);
    expect(pulseLit(10, 1)).toBe(1); // largura 1 ⇒ sempre 1
  });
});

describe('BusyPulse — componente (largura constante = anti-flicker)', () => {
  it('desenha SEMPRE `width` blocos grossos (█) — nada aparece/some entre frames', () => {
    for (const f of [0, 1, 3, 7]) {
      const out = plain(wrap(<BusyPulse frame={f} width={4} />).lastFrame() ?? '');
      expect((out.match(/█/g) ?? []).length).toBe(4);
    }
  });

  it('largura default = DEFAULT_PULSE_WIDTH', () => {
    const out = plain(wrap(<BusyPulse frame={0} />).lastFrame() ?? '');
    expect((out.match(/█/g) ?? []).length).toBe(DEFAULT_PULSE_WIDTH);
  });

  it('ASCII (TERM=linux): degrada p/ `#` (sem █) — ainda largura constante', () => {
    const out = plain(wrap(<BusyPulse frame={2} width={4} />, { TERM: 'linux' }).lastFrame() ?? '');
    expect(out).not.toContain('█');
    expect((out.match(/#/g) ?? []).length).toBe(4);
  });
});

describe('StatusBar — pulso de trabalho no fim da barra (F195)', () => {
  const base = {
    cwd: '~/proj',
    tier: 'granito',
    windowPct: 22,
    tokens: 8200,
    budgetPct: 31,
    columns: 100,
  } as const;

  it('busy=true (largo): a barra ganha o pulso de blocos grossos (█) ao fim', () => {
    const out = plain(wrap(<StatusBar {...base} busy frame={3} />).lastFrame() ?? '');
    expect(out).toContain('█'); // o pulso (nenhum outro glifo da barra é █)
  });

  it('busy ausente/false: SEM pulso (idle não desenha blocos)', () => {
    const out = plain(wrap(<StatusBar {...base} />).lastFrame() ?? '');
    expect(out).not.toContain('█');
  });

  it('narrow (<60 col): o pulso CAI (supplementar; tier/⚠ têm prioridade)', () => {
    const out = plain(wrap(<StatusBar {...base} columns={50} busy frame={3} />).lastFrame() ?? '');
    expect(out).not.toContain('█');
  });
});

// F195+ — degradê de 3 tons (pedido do dono "mais cores + maiorzinha"): cabeça `accent`,
// corpo `depth`, apagado `accentDim`; e a largura default subiu p/ 7.
describe('pulseCellRole — degradê de 3 tons', () => {
  it('cabeça da onda (i===lit-1) = accent; corpo aceso = depth; apagado = accentDim', () => {
    const lit = 4;
    expect(pulseCellRole(3, lit)).toBe('accent'); // cabeça (última acesa)
    expect(pulseCellRole(2, lit)).toBe('accentMid'); // corpo (âmbar do meio)
    expect(pulseCellRole(0, lit)).toBe('accentMid'); // corpo (âmbar do meio)
    expect(pulseCellRole(4, lit)).toBe('accentDim'); // apagada
    expect(pulseCellRole(6, lit)).toBe('accentDim'); // apagada
  });

  it('lit===1 ⇒ a única acesa é a cabeça (accent); lit===0 ⇒ tudo accentDim', () => {
    expect(pulseCellRole(0, 1)).toBe('accent');
    expect(pulseCellRole(1, 1)).toBe('accentDim');
    expect(pulseCellRole(0, 0)).toBe('accentDim');
  });

  it('a largura default do pulso é 7 (maior)', () => {
    expect(DEFAULT_PULSE_WIDTH).toBe(7);
  });
});
