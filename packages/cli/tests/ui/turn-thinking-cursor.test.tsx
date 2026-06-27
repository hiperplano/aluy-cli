// EST-0965 — o CURSOR DE TRABALHO do <AluyBlock>: ● GROSSO/ARREDONDADO em AMARELO
// (papel `accent` do DS, NUNCA hex cru), piscar CALMO (~1.2s, não os ~250ms
// frenéticos do antigo `▏`). DoD FRUGAL (sem modelo): snapshots de glifo/cor/cadência
//   (a) streaming ⇒ glifo ● amarelo (SGR do accent presente em truecolor);
//   (b) NO_COLOR ⇒ ● degrada SEM SGR de cor (a11y: a cor não carrega o significado);
//   (c) ALUY_SAFE_GLYPHS ⇒ fallback seguro continua ● (cobertura universal);
//   (d) ASCII (TERM=linux) ⇒ fallback `*` (sem tofu);
//   (e) piscar CALMO: aceso por VÁRIOS frames seguidos (não alterna a cada frame) e a
//       ALTURA não muda entre aceso/apagado (sem `\x1b[2K` novo — não regride #95/#118).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { AluyBlock } from '../../src/ui/components/TurnBlock.js';
import { TRUECOLOR_DARK } from '../../src/ui/theme/palette.js';

const TRUECOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
const NOCOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
const SAFE = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', ALUY_SAFE_GLYPHS: '1' };
const ASCIITERM = { TERM: 'linux' }; // sem UTF-8 ⇒ glifos ASCII

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}
function frameOf(env: NodeJS.ProcessEnv, node: React.ReactElement): string {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>).lastFrame() ?? '';
}
function lineCount(s: string): number {
  return s.split('\n').length;
}

const TEXT = 'pensando…';
// O hex AMARELO do papel `accent` do tema DARK (DS). O cursor de trabalho DEVE sair
// deste TOKEN — nunca um hex cru espalhado no componente.
const ACCENT_HEX = (TRUECOLOR_DARK.accent.color ?? '').replace('#', '');

describe('AluyBlock — cursor de TRABALHO ● amarelo (token DS) — EST-0965', () => {
  it('(a) truecolor: streaming mostra ● e o pinta com a COR accent do DS (SGR amarelo)', () => {
    const raw = frameOf(TRUECOLOR, <AluyBlock text={TEXT} streaming frame={0} />);
    expect(plain(raw)).toContain('●'); // glifo grosso/arredondado
    // o SGR truecolor do accent (#DDA13F → 221;161;63) precisa estar no output CRU —
    // prova que o ● sai do TOKEN do tema, não sem cor.
    expect(ACCENT_HEX).not.toBe('');
    expect(raw).toMatch(/221;161;63/); // 0xDD,0xA1,0x3F = accent dark
  });

  it('(b) NO_COLOR: ● aparece mas SEM SGR de cor (degrada — a cor não carrega sentido)', () => {
    const raw = frameOf(NOCOLOR, <AluyBlock text={TEXT} streaming frame={0} />);
    expect(plain(raw)).toContain('●'); // o glifo continua (significado mora nele)
    // nenhum SGR de COR de primeiro plano (38;2;… truecolor nem 30-37 amarelo ansi).
    const FG_TRUECOLOR = new RegExp(ESC + '\\[[0-9;]*38;2;');
    const FG_ANSI_BASIC = new RegExp(ESC + '\\[[0-9;]*3[0-7]m');
    expect(raw).not.toMatch(FG_TRUECOLOR);
    expect(raw).not.toMatch(FG_ANSI_BASIC); // sem cor de fg ANSI básica
  });

  it('(c) ALUY_SAFE_GLYPHS: o fallback seguro continua ● (cobertura universal)', () => {
    const out = plain(frameOf(SAFE, <AluyBlock text={TEXT} streaming frame={0} />));
    expect(out).toContain('●');
  });

  it('(d) ASCII (TERM=linux): degrada p/ `*` (sem tofu, sem ●)', () => {
    const out = plain(frameOf(ASCIITERM, <AluyBlock text={TEXT} streaming frame={0} />));
    expect(out).toContain('*');
    expect(out).not.toContain('●');
  });

  it('(e) piscar CALMO: aceso por VÁRIOS frames seguidos (não alterna a cada frame)', () => {
    // Com o ciclo de 10 frames (aceso nos 6 primeiros), os frames 0..5 mostram o ● e
    // 6..9 não — ao contrário do antigo `frame % 2` (alternava TODO frame, frenético).
    const on = [0, 1, 2, 3, 4, 5].map((f) =>
      plain(frameOf(TRUECOLOR, <AluyBlock text={TEXT} streaming frame={f} />)).includes('●'),
    );
    const off = [6, 7, 8, 9].map((f) =>
      plain(frameOf(TRUECOLOR, <AluyBlock text={TEXT} streaming frame={f} />)).includes('●'),
    );
    expect(on.every(Boolean)).toBe(true); // aceso 6 frames seguidos ⇒ calmo
    expect(off.every((v) => v === false)).toBe(true); // apagado o resto do ciclo
  });

  it('(e) anti-jitter: a ALTURA é a mesma no frame aceso e no apagado (sem redesenho/2K)', () => {
    const on = frameOf(TRUECOLOR, <AluyBlock text={TEXT} streaming frame={0} />);
    const off = frameOf(TRUECOLOR, <AluyBlock text={TEXT} streaming frame={6} />);
    expect(lineCount(off)).toBe(lineCount(on));
  });

  it('sem animação (reduced-motion): o ● fica ESTÁVEL (sempre aceso, sem piscar)', () => {
    // theme.animate=false ⇒ cursorOn sempre true (independe do frame).
    const a = plain(
      frameOf({ ...TRUECOLOR, ALUY_NO_ANIM: '1' }, <AluyBlock text={TEXT} streaming frame={0} />),
    );
    const b = plain(
      frameOf({ ...TRUECOLOR, ALUY_NO_ANIM: '1' }, <AluyBlock text={TEXT} streaming frame={6} />),
    );
    expect(a).toContain('●');
    expect(b).toContain('●'); // mesmo no frame que SERIA apagado, fica aceso
  });
});
