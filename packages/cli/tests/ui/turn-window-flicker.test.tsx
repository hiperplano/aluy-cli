// F61 (🔴 anti-flicker) — PROVA RODANDO: uma resposta GRANDE streamada NÃO é
// reprocessada INTEIRA a cada tick. O bug: o <AluyBlock> rodava
// `cleanAluyForDisplay(props.text)` (várias varreduras regex no texto inteiro) +
// `windowTailVisual(full, …)` (split + medição visual de CADA linha) sobre o texto
// acumulado INTEIRO, a cada frame (~120ms, o pulso do cursor). Com output de muitas
// linhas / MBs isso é O(tamanho) por tick ⇒ jank/flicker, "impossível de usar".
//
// O fix: durante o stream o RAW é cortado na CAUDA (`MAX_LIVE_SPEECH_CHARS`) ANTES da
// limpeza+janela. Provamos que (a) o trabalho pesado recebe input BOUNDED (não o texto
// inteiro), (b) o conteúdo VISÍVEL é IDÊNTICO entre dois ticks (frames) com o mesmo
// input, e bounded em altura, e (c) ao FINALIZAR (streaming=false) nada é cortado.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { AluyBlock } from '../../src/ui/components/TurnBlock.js';
import { MAX_LIVE_SPEECH_CHARS } from '../../src/session/live-budget.js';

const TRUECOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
function frame(node: React.ReactElement): string {
  const theme = resolveTheme({ env: TRUECOLOR });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>).lastFrame() ?? '';
}

// Bloco GRANDE: 12000 linhas (≫ qualquer terminal) ⇒ bem acima do cap de 64KB. O bug
// era reprocessar TUDO isso por tick.
const HUGE = Array.from({ length: 12000 }, (_, i) => `linha ${i + 1}`).join('\n');

describe('F61 — output grande streamado não reprocessa o texto inteiro por tick', () => {
  it('PROVA (spy): a limpeza pesada recebe input BOUNDED (≤ cap), não o texto inteiro', async () => {
    // Espiona `cleanAluyForDisplay` no MÓDULO core — é o que varre o texto inteiro.
    const core = await import('@hiperplano/aluy-cli-core');
    const spy = vi.spyOn(core, 'cleanAluyForDisplay');
    try {
      frame(<AluyBlock text={HUGE} streaming maxLines={6} columns={80} frame={0} />);
      expect(spy).toHaveBeenCalled();
      // O comprimento do texto BRUTO é MUITO maior que o cap; cada chamada da limpeza
      // pesada deve receber, no máximo, o cap — NÃO o texto inteiro.
      expect(HUGE.length).toBeGreaterThan(MAX_LIVE_SPEECH_CHARS);
      for (const call of spy.mock.calls) {
        const arg = call[0] as string;
        expect(arg.length).toBeLessThanOrEqual(MAX_LIVE_SPEECH_CHARS);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('PROVA (estabilidade): a saída VISÍVEL é IDÊNTICA e bounded entre 2 ticks (frames)', () => {
    const a = frame(<AluyBlock text={HUGE} streaming maxLines={6} columns={80} frame={0} />);
    const b = frame(<AluyBlock text={HUGE} streaming maxLines={6} columns={80} frame={3} />);
    // O `frame` só muda o pisca do cursor (●/espaço); o CORPO da janela é o mesmo.
    // Removemos a linha do cursor de trabalho p/ comparar só o conteúdo de fala.
    const body = (s: string) => s.replace(/[●]/g, ' ');
    expect(body(a)).toBe(body(b));
    // Bounded: a janela mostra só a cauda — NÃO as 6000 linhas. Altura ≪ 6000.
    expect(a.split('\n').length).toBeLessThan(60);
  });

  it('conteúdo CORRETO: a CAUDA aparece, o topo gigante rolou p/ fora (sem perder o fim)', () => {
    const out = frame(<AluyBlock text={HUGE} streaming maxLines={6} columns={80} frame={0} />);
    expect(out).toContain('linha 12000'); // a última linha (cauda) está visível
    expect(out).toContain('linhas acima'); // o marcador do que rolou p/ cima
    expect(out).not.toContain('linha 1\n'); // o topo não está na janela viva
  });

  it('FINALIZADO (streaming=false): NÃO corta o raw — o bloco inteiro vai p/ o Static', async () => {
    // Texto além do cap, mas FINALIZADO: a limpeza recebe o texto INTEIRO (sem clamp),
    // pois o bloco desce inteiro p/ o scrollback (nada se perde).
    const core = await import('@hiperplano/aluy-cli-core');
    const spy = vi.spyOn(core, 'cleanAluyForDisplay');
    try {
      frame(<AluyBlock text={HUGE} streaming={false} columns={80} />);
      const sawFullText = spy.mock.calls.some((c) => (c[0] as string).length === HUGE.length);
      expect(sawFullText).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
