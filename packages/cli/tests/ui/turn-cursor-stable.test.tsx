// EST-0956 (anti-jitter/TUI estável) — <AluyBlock> cursor de LARGURA CONSTANTE.
// EST-0965 — o cursor de trabalho virou o ● GROSSO/ARREDONDADO em AMARELO (antes o
// `▏` branco fininho frenético), com piscar CALMO (ciclo de 10 frames). Os
// invariantes de ALTURA constante seguem valendo — o que muda é o GLIFO e a CADÊNCIA.
//
// BUG: durante o STREAM o cursor aparecia/sumia condicionalmente. Quando some, a
// célula colapsa (largura/altura 0) — e, perto da borda do terminal, liga/desliga o
// WRAP da última linha. A altura da região VIVA oscila ±1 linha a cada frame ⇒ tudo
// abaixo (composer + "esc para interromper") SOBE e DESCE.
//
// FIX: o cursor é SEMPRE renderizado durante o stream; só alterna o conteúdo entre o
// glifo `●` (frames "aceso") e um ESPAÇO (frames "apagado"). A célula nunca colapsa
// ⇒ a ALTURA é estável ⇒ sem jitter. O pisca visual continua, calmo.
//
// NOTA de medição: ink-testing-library faz right-trim de espaços à direita em cada
// linha do `lastFrame()`. A célula "espaço" do cursor desligado some do TEXTO, mas a
// LINHA continua existindo — e é a CONTAGEM DE LINHAS (altura) que estava oscilando e
// causava o jitter. Por isso o invariante aferido aqui é a altura (lineCount), não a
// largura textual da última linha (que o trim distorce).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { AluyBlock } from '../../src/ui/components/TurnBlock.js';

const TRUECOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
function frameOf(node: React.ReactElement): string {
  const theme = resolveTheme({ env: TRUECOLOR });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>).lastFrame() ?? '';
}
// nº de linhas físicas renderizadas (a ALTURA ocupada pelo bloco).
function lineCount(s: string): number {
  return s.split('\n').length;
}

const TEXT = 'resposta em streaming perto da borda';
// EST-0965 — o cursor de trabalho é o ● amarelo. Frames "aceso" (blink < 6) e
// "apagado" (blink >= 6), no ciclo de 10 (~1.2s). frame 0 = aceso; frame 6 = apagado.
const CURSOR = '●';
const FRAME_ON = 0;
const FRAME_OFF = 6;

describe('AluyBlock — cursor de altura constante (anti-jitter, EST-0956/EST-0965)', () => {
  it('streaming: a ALTURA (nº de linhas) é IGUAL no frame aceso (cursor ●) e apagado (espaço)', () => {
    const on = frameOf(<AluyBlock text={TEXT} streaming frame={FRAME_ON} />); // ligado
    const off = frameOf(<AluyBlock text={TEXT} streaming frame={FRAME_OFF} />); // desligado
    expect(lineCount(off)).toBe(lineCount(on));
  });

  it('a linha do cursor é REAL: com cursor há 1 linha a mais que sem streaming (mesmo desligado)', () => {
    // Sem stream NÃO há cursor (nem linha dele). Com stream, ligado OU desligado, a
    // linha do cursor EXISTE — provando que o estado "desligado" não some (largura 0).
    const done = frameOf(<AluyBlock text={TEXT} streaming={false} frame={FRAME_ON} />);
    const on = frameOf(<AluyBlock text={TEXT} streaming frame={FRAME_ON} />);
    const off = frameOf(<AluyBlock text={TEXT} streaming frame={FRAME_OFF} />);
    expect(lineCount(on)).toBe(lineCount(done) + 1);
    expect(lineCount(off)).toBe(lineCount(done) + 1); // <- antes do fix: era == done (cursor sumia)
  });

  it('cursor "aceso" mostra o glifo ●; "apagado" não — o pisca CALMO continua', () => {
    const on = frameOf(<AluyBlock text={TEXT} streaming frame={FRAME_ON} />);
    const off = frameOf(<AluyBlock text={TEXT} streaming frame={FRAME_OFF} />);
    expect(on).toContain(CURSOR);
    expect(off).not.toContain(CURSOR);
  });

  it('NÃO streaming: sem cursor (a célula só existe durante o stream)', () => {
    const done = frameOf(<AluyBlock text={TEXT} streaming={false} frame={FRAME_ON} />);
    expect(done).not.toContain(CURSOR);
  });
});
