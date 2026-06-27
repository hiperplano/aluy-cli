// Anti-flicker (DoD) — <AluyBlock maxLines>: durante o STREAM, a prévia viva é
// limitada a uma JANELA de cauda (últimas N linhas) + marcador `… (X linhas acima)`.
// Isso mantém a região dinâmica curta — o que permite ao Ink preservar o histórico
// no <Static> (sem clearTerminal a cada frame). Ao FINALIZAR (streaming=false), o
// teto não se aplica: o bloco vai INTEIRO p/ o Static (nada se perde).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { AluyBlock } from '../../src/ui/components/TurnBlock.js';

const TRUECOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
function frame(node: React.ReactElement): string {
  const theme = resolveTheme({ env: TRUECOLOR });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>).lastFrame() ?? '';
}

const LONG = Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`).join('\n');

describe('AluyBlock — janela de cauda na prévia viva (anti-flicker)', () => {
  it('streaming + maxLines: mostra só a CAUDA (últimas linhas), não o topo', () => {
    const out = frame(<AluyBlock text={LONG} streaming maxLines={5} frame={0} />);
    // a cauda aparece…
    expect(out).toContain('linha 30');
    expect(out).toContain('linha 26');
    // …e o topo NÃO (rolou p/ fora da janela viva).
    expect(out).not.toContain('linha 1\n');
    expect(out).not.toContain('linha 10');
  });

  it('streaming + maxLines: marcador `… (N linhas acima)` indica o que rolou', () => {
    const out = frame(<AluyBlock text={LONG} streaming maxLines={5} frame={0} />);
    // 30 linhas, janela 5 ⇒ 25 acima.
    expect(out).toContain('25 linhas acima');
  });

  it('FINALIZADO (streaming=false): o teto NÃO se aplica — o bloco inteiro aparece', () => {
    const out = frame(<AluyBlock text={LONG} streaming={false} maxLines={5} />);
    expect(out).toContain('linha 1');
    expect(out).toContain('linha 30');
    expect(out).not.toContain('linhas acima'); // sem marcador de janela
  });

  it('texto curto (< maxLines): sem janela nem marcador', () => {
    const out = frame(<AluyBlock text={'oi\ntudo bem'} streaming maxLines={5} frame={0} />);
    expect(out).toContain('oi');
    expect(out).toContain('tudo bem');
    expect(out).not.toContain('linhas acima');
  });

  it('sem maxLines: comportamento antigo (sem teto), mesmo streaming', () => {
    const out = frame(<AluyBlock text={LONG} streaming frame={0} />);
    expect(out).toContain('linha 1');
    expect(out).toContain('linha 30');
  });

  // EST-0965 (WRAP) — linhas LARGAS: com `columns` a janela mede a altura VISUAL real.
  it('linhas LARGAS + columns: a janela corta por linhas VISUAIS (menos linhas-fonte cabem)', () => {
    // 4 linhas-fonte de 200 chars (3 visuais cada em col=78). maxLines=4 visuais ⇒
    // cabe só 1 linha-fonte; 3 ficam acima. SEM `columns` (linhas-fonte) caberiam 4.
    const wide = Array.from({ length: 4 }, (_, i) => `W${i} ` + 'x'.repeat(196)).join('\n');
    const out = frame(<AluyBlock text={wide} streaming maxLines={4} columns={80} frame={0} />);
    expect(out).toContain('3 linhas acima'); // 3 linhas-fonte ocultas (não 0)
    expect(out).toContain('W3'); // a cauda (última) aparece
    expect(out).not.toContain('W0'); // o topo rolou p/ fora
  });

  it('NÃO REGRIDE: linhas CURTAS com columns janelam igual a antes (por linha-fonte)', () => {
    const out = frame(<AluyBlock text={LONG} streaming maxLines={5} columns={80} frame={0} />);
    // 30 linhas curtas (não quebram) ⇒ 25 acima, igual ao caso sem columns.
    expect(out).toContain('25 linhas acima');
    expect(out).toContain('linha 30');
  });
});
