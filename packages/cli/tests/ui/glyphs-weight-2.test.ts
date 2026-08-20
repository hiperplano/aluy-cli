// F-GLYPH-PESO-2 — o dono viu a amostra de 6 molduras e escolheu a B (borda EXTERNA
// grossa `┏┓┗┛━┃`, separador INTERNO leve `─` com junção `┠┨`) e autorizou
// EXPLICITAMENTE destravar as candidatas de peso que a F-GLYPH-PESO tinha deixado de
// fora (ver header de glyphs.ts): `ok`/`err` (✓✗→✔✘), `window` (□→■), `barFull`/
// `barEmpty` (▰▱→█░, a de MAIOR impacto visual), `normalMode` (◇→◆), `clock` (◷→◕) e
// o `BoxChars` do tema (esquema B). Estes testes travam:
//   1. os 7 glifos NOVOS no perfil NORMAL (e o `resolveTheme` default entregando-os);
//   2. SAFE_GLYPHS/ASCII_GLYPHS INTOCADOS (terminal limitado continua como está);
//   3. NERD_GLYPHS sincronizado nas 4 chaves que não têm ícone Nerd próprio;
//   4. o BoxChars novo (moldura pesada + `innerHorizontal` leve nos separadores);
//   5. `<CodeBlock>`/`<TableBlock>` seguem no box LEVE via `LIGHT_UNICODE_BOX`
//      (conteúdo, não chrome — não regride os snapshots pinados fora do escopo);
//   6. TRAVA DURA de largura: todo char novo é 1 célula (`displayWidth`).

import { describe, expect, it } from 'vitest';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import {
  UNICODE_GLYPHS,
  SAFE_GLYPHS,
  ASCII_GLYPHS,
  NERD_GLYPHS,
  UNICODE_BOX,
  ASCII_BOX,
  LIGHT_UNICODE_BOX,
} from '../../src/ui/theme/glyphs.js';
import { displayWidth } from '../../src/session/visual-lines.js';

const UTF8 = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };

describe('UNICODE_GLYPHS — as 7 trocas de peso (F-GLYPH-PESO-2)', () => {
  it('ok: ✓ → ✔ (2714 HEAVY CHECK MARK)', () => {
    expect(UNICODE_GLYPHS.ok).toBe('✔');
    expect(UNICODE_GLYPHS.ok).not.toBe('✓');
    expect(UNICODE_GLYPHS.ok.codePointAt(0)).toBe(0x2714);
  });

  it('err: ✗ → ✘ (2718 HEAVY BALLOT X)', () => {
    expect(UNICODE_GLYPHS.err).toBe('✘');
    expect(UNICODE_GLYPHS.err).not.toBe('✗');
    expect(UNICODE_GLYPHS.err.codePointAt(0)).toBe(0x2718);
  });

  it('window: □ → ■ (25A0 BLACK SQUARE, preenchido)', () => {
    expect(UNICODE_GLYPHS.window).toBe('■');
    expect(UNICODE_GLYPHS.window).not.toBe('□');
    expect(UNICODE_GLYPHS.window.codePointAt(0)).toBe(0x25a0);
  });

  it('barFull/barEmpty: ▰/▱ → █/░ (medidor CONTÍNUO — maior impacto visual)', () => {
    expect(UNICODE_GLYPHS.barFull).toBe('█');
    expect(UNICODE_GLYPHS.barEmpty).toBe('░');
    expect(UNICODE_GLYPHS.barFull).not.toBe('▰');
    expect(UNICODE_GLYPHS.barEmpty).not.toBe('▱');
    expect(UNICODE_GLYPHS.barFull.codePointAt(0)).toBe(0x2588);
    expect(UNICODE_GLYPHS.barEmpty.codePointAt(0)).toBe(0x2591);
  });

  it('normalMode: ◇ → ◆ (25C6 BLACK DIAMOND, preenchido)', () => {
    expect(UNICODE_GLYPHS.normalMode).toBe('◆');
    expect(UNICODE_GLYPHS.normalMode).not.toBe('◇');
    expect(UNICODE_GLYPHS.normalMode.codePointAt(0)).toBe(0x25c6);
  });

  it('clock: ◷ → ◕ (25D5, mais massa que o quadrante fino)', () => {
    expect(UNICODE_GLYPHS.clock).toBe('◕');
    expect(UNICODE_GLYPHS.clock).not.toBe('◷');
    expect(UNICODE_GLYPHS.clock.codePointAt(0)).toBe(0x25d5);
  });

  it('gauge (F-GLYPH-PESO, rodada anterior) segue ◉ — não regrediu', () => {
    expect(UNICODE_GLYPHS.gauge).toBe('◉');
  });

  it('NÃO tocadas: ask/branch/prompt/broker/tool/you/aluy/cursor seguem iguais', () => {
    expect(UNICODE_GLYPHS.ask).toBe('⚠');
    expect(UNICODE_GLYPHS.branch).toBe('⎇');
    expect(UNICODE_GLYPHS.prompt).toBe('›');
    expect(UNICODE_GLYPHS.broker).toBe('●');
    expect(UNICODE_GLYPHS.tool).toBe('⏺');
    expect(UNICODE_GLYPHS.you).toBe('▌');
    expect(UNICODE_GLYPHS.aluy).toBe('Λ');
    expect(UNICODE_GLYPHS.cursor).toBe('●');
  });

  it('resolveTheme default (UTF-8, sem overrides) já entrega os 7 glifos com peso', () => {
    const t = resolveTheme({ env: UTF8 });
    expect(t.glyph('ok')).toBe('✔');
    expect(t.glyph('err')).toBe('✘');
    expect(t.glyph('window')).toBe('■');
    expect(t.glyph('barFull')).toBe('█');
    expect(t.glyph('barEmpty')).toBe('░');
    expect(t.glyph('normalMode')).toBe('◆');
    expect(t.glyph('clock')).toBe('◕');
  });
});

describe('SAFE_GLYPHS / ASCII_GLYPHS — INTOCADOS (terminal limitado continua como está)', () => {
  it('SAFE_GLYPHS: ok/err/window/barFull/barEmpty/normalMode/clock não mudaram', () => {
    expect(SAFE_GLYPHS.ok).toBe('√');
    expect(SAFE_GLYPHS.err).toBe('x');
    expect(SAFE_GLYPHS.window).toBe('□');
    expect(SAFE_GLYPHS.barFull).toBe('█'); // já era █ desde EST-0973 — não é a troca desta rodada
    expect(SAFE_GLYPHS.barEmpty).toBe('░'); // idem
    expect(SAFE_GLYPHS.normalMode).toBe('◇');
    expect(SAFE_GLYPHS.clock).toBe('o');
  });

  it('ASCII_GLYPHS: idem, intactos', () => {
    expect(ASCII_GLYPHS.ok).toBe('[ok]');
    expect(ASCII_GLYPHS.err).toBe('[x]');
    expect(ASCII_GLYPHS.window).toBe('ctx:');
    expect(ASCII_GLYPHS.barFull).toBe('#');
    expect(ASCII_GLYPHS.barEmpty).toBe('.');
    expect(ASCII_GLYPHS.normalMode).toBe('*');
    expect(ASCII_GLYPHS.clock).toBe('t:');
  });

  it('resolveTheme com ALUY_SAFE_GLYPHS=1 segue entregando o SAFE, não os glifos novos', () => {
    const t = resolveTheme({ env: { ...UTF8, ALUY_SAFE_GLYPHS: '1' } });
    expect(t.glyph('ok')).toBe('√');
    expect(t.glyph('window')).toBe('□');
  });

  it('resolveTheme em TERM=linux segue entregando o ASCII, não os glifos novos', () => {
    const t = resolveTheme({ env: { TERM: 'linux' } });
    expect(t.glyph('ok')).toBe('[ok]');
    expect(t.glyph('window')).toBe('ctx:');
  });
});

describe('NERD_GLYPHS — sincronizado nas chaves SEM ícone Nerd próprio', () => {
  it('window/barFull/barEmpty/normalMode espelham o novo normal (não são troca Nerd)', () => {
    expect(NERD_GLYPHS.window).toBe(UNICODE_GLYPHS.window);
    expect(NERD_GLYPHS.barFull).toBe(UNICODE_GLYPHS.barFull);
    expect(NERD_GLYPHS.barEmpty).toBe(UNICODE_GLYPHS.barEmpty);
    expect(NERD_GLYPHS.normalMode).toBe(UNICODE_GLYPHS.normalMode);
  });

  it('ok/err/clock CONTINUAM os ícones Nerd próprios (PUA) — não viram ✔/✘/◕', () => {
    expect(NERD_GLYPHS.ok.codePointAt(0)).toBe(0xf00c);
    expect(NERD_GLYPHS.err.codePointAt(0)).toBe(0xf00d);
    expect(NERD_GLYPHS.clock.codePointAt(0)).toBe(0xf017);
  });
});

describe('BoxChars — moldura ESQUEMA B (borda pesada + separador interno leve)', () => {
  it('UNICODE_BOX: borda EXTERNA pesada (┏┓┗┛━┃) e tês grossa→leve (┠┨)', () => {
    expect(UNICODE_BOX.topLeft).toBe('┏');
    expect(UNICODE_BOX.topRight).toBe('┓');
    expect(UNICODE_BOX.bottomLeft).toBe('┗');
    expect(UNICODE_BOX.bottomRight).toBe('┛');
    expect(UNICODE_BOX.horizontal).toBe('━');
    expect(UNICODE_BOX.vertical).toBe('┃');
    expect(UNICODE_BOX.teeLeft).toBe('┠');
    expect(UNICODE_BOX.teeRight).toBe('┨');
  });

  it('UNICODE_BOX.innerHorizontal (campo NOVO) é LEVE (─) — distinto da borda', () => {
    expect(UNICODE_BOX.innerHorizontal).toBe('─');
    expect(UNICODE_BOX.innerHorizontal).not.toBe(UNICODE_BOX.horizontal);
  });

  it('ASCII_BOX: innerHorizontal existe e é igual ao horizontal (sem peso em 7-bit)', () => {
    expect(ASCII_BOX.innerHorizontal).toBe('-');
    expect(ASCII_BOX.innerHorizontal).toBe(ASCII_BOX.horizontal);
    // o resto do ASCII_BOX não regrediu.
    expect(ASCII_BOX.topLeft).toBe('+');
    expect(ASCII_BOX.vertical).toBe('|');
  });

  it('resolveTheme default entrega a moldura pesada + o innerHorizontal leve', () => {
    const t = resolveTheme({ env: UTF8 });
    expect(t.box.topLeft).toBe('┏');
    expect(t.box.horizontal).toBe('━');
    expect(t.box.innerHorizontal).toBe('─');
  });

  it('LIGHT_UNICODE_BOX preserva o desenho ANTIGO (arredondado) — p/ CodeBlock/TableBlock', () => {
    expect(LIGHT_UNICODE_BOX.topLeft).toBe('╭');
    expect(LIGHT_UNICODE_BOX.topRight).toBe('╮');
    expect(LIGHT_UNICODE_BOX.bottomLeft).toBe('╰');
    expect(LIGHT_UNICODE_BOX.bottomRight).toBe('╯');
    expect(LIGHT_UNICODE_BOX.horizontal).toBe('─');
    expect(LIGHT_UNICODE_BOX.vertical).toBe('│');
    expect(LIGHT_UNICODE_BOX.teeLeft).toBe('├');
    expect(LIGHT_UNICODE_BOX.teeRight).toBe('┤');
    expect(LIGHT_UNICODE_BOX.innerHorizontal).toBe('─');
  });
});

describe('TRAVA DURA — todo char novo é largura 1 (displayWidth, session/visual-lines.ts)', () => {
  const NEW_GLYPHS: readonly [string, string][] = [
    ['ok (✔)', UNICODE_GLYPHS.ok],
    ['err (✘)', UNICODE_GLYPHS.err],
    ['window (■)', UNICODE_GLYPHS.window],
    ['barFull (█)', UNICODE_GLYPHS.barFull],
    ['barEmpty (░)', UNICODE_GLYPHS.barEmpty],
    ['normalMode (◆)', UNICODE_GLYPHS.normalMode],
    ['clock (◕)', UNICODE_GLYPHS.clock],
  ];
  it.each(NEW_GLYPHS)('glifo %s tem displayWidth === 1', (_label, glyph) => {
    expect(displayWidth(glyph)).toBe(1);
    // e 1 code point só (sem par surrogate/combinante escondido).
    expect([...glyph].length).toBe(1);
  });

  const NEW_BOX_CHARS: readonly [string, string][] = [
    ['topLeft (┏)', UNICODE_BOX.topLeft],
    ['topRight (┓)', UNICODE_BOX.topRight],
    ['bottomLeft (┗)', UNICODE_BOX.bottomLeft],
    ['bottomRight (┛)', UNICODE_BOX.bottomRight],
    ['horizontal (━)', UNICODE_BOX.horizontal],
    ['vertical (┃)', UNICODE_BOX.vertical],
    ['teeLeft (┠)', UNICODE_BOX.teeLeft],
    ['teeRight (┨)', UNICODE_BOX.teeRight],
    ['innerHorizontal (─)', UNICODE_BOX.innerHorizontal],
  ];
  it.each(NEW_BOX_CHARS)('borda %s tem displayWidth === 1', (_label, ch) => {
    expect(displayWidth(ch)).toBe(1);
    expect([...ch].length).toBe(1);
  });
});
