// EST-0984 — endurecimento dos glifos "sujos" no Terminator + perfil SEGURO.
//
// O Tiago via "caracteres sujos" (tofu) no Terminator: glifos Unicode sem cobertura
// na fonte. Estes testes travam (1) que o conjunto DEFAULT não usa mais os chars de
// RISCO listados, (2) que há um perfil SEGURO opt-in (ALUY_SAFE_GLYPHS/--ascii) que
// é REALMENTE limpo, e (3) que NO_COLOR/ASCII/16-cores seguem intactos.

import { describe, expect, it } from 'vitest';
import { resolveTheme, detectSafeGlyphs } from '../../src/ui/theme/theme.js';
import {
  UNICODE_GLYPHS,
  SAFE_GLYPHS,
  ASCII_GLYPHS,
  ALUY_MARK_UNICODE,
  ALUY_MARK_ASCII,
} from '../../src/ui/theme/glyphs.js';

const UTF8 = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };

/** Os chars de RISCO que o Tiago sinalizou — NÃO podem estar no default Unicode. */
const RISKY_CHARS = [
  '～', // FF5E fullwidth tilde (largura ambígua)
  '◌', // 25CC dotted circle
  '⛁', // 26C1 white draughts king (emoji-ish)
  '⊕', // 2295 circled plus
  '◍', // 25CD circle with vertical fill
];

describe('glyphs default (Unicode) — sem os chars de risco (EST-0984)', () => {
  it('nenhum glifo DEFAULT usa um dos caracteres "sujos" sinalizados', () => {
    const used = Object.values(UNICODE_GLYPHS);
    for (const risky of RISKY_CHARS) {
      expect(used).not.toContain(risky);
    }
  });

  it('as TROCAS específicas estão no lugar (antes→depois)', () => {
    expect(UNICODE_GLYPHS.wave).toBe('~'); // ～ → ~
    expect(UNICODE_GLYPHS.toolInflight).toBe('○'); // ◌ → ○
    expect(UNICODE_GLYPHS.window).toBe('□'); // ⛁ → □
    expect(UNICODE_GLYPHS.subagents).toBe('+'); // ⊕ → +
    expect(UNICODE_GLYPHS.broker).toBe('●'); // ◍ → ●
  });

  it('a marca `aluy` agora é o Λ do logo (não o losango ◇)', () => {
    expect(UNICODE_GLYPHS.aluy).toBe('Λ');
    expect(UNICODE_GLYPHS.aluy).not.toBe('◇');
    // o ◇ permanece SÓ no indicador de modo normal (catraca) — coerência mantida.
    expect(UNICODE_GLYPHS.normalMode).toBe('◇');
  });
});

describe('perfil SEGURO opt-in (ALUY_SAFE_GLYPHS / --ascii) — EST-0984', () => {
  it('detectSafeGlyphs: env ALUY_SAFE_GLYPHS liga; override vence', () => {
    expect(detectSafeGlyphs({ ALUY_SAFE_GLYPHS: '1' })).toBe(true);
    expect(detectSafeGlyphs({})).toBe(false);
    expect(detectSafeGlyphs({ ALUY_SAFE_GLYPHS: '1' }, false)).toBe(false); // --no override
    expect(detectSafeGlyphs({}, true)).toBe(true); // --ascii override
  });

  it('ALUY_SAFE_GLYPHS=1 em UTF-8 ⇒ usa SAFE_GLYPHS (e marca o flag)', () => {
    const t = resolveTheme({ env: { ...UTF8, ALUY_SAFE_GLYPHS: '1' } });
    expect(t.unicode).toBe(true);
    expect(t.safeGlyphs).toBe(true);
    expect(t.glyph('toolInflight')).toBe('○');
    expect(t.glyph('aluy')).toBe('Λ');
    // o spinner cai nos frames ASCII (braille tem cobertura irregular).
    expect(t.spinnerFrames).toEqual(['-', '\\', '|', '/']);
  });

  it('--ascii (override safeGlyphs) liga o perfil seguro mesmo sem env', () => {
    const t = resolveTheme({ env: UTF8, safeGlyphs: true });
    expect(t.safeGlyphs).toBe(true);
  });

  it('o SAFE não contém nenhum char de risco e nem ⏺ (cobertura fraca)', () => {
    const used = Object.values(SAFE_GLYPHS);
    for (const risky of [...RISKY_CHARS, '⏺']) {
      expect(used).not.toContain(risky);
    }
  });

  it('SAFE é irrelevante em ASCII puro (TERM=linux vence ⇒ safeGlyphs=false)', () => {
    const t = resolveTheme({ env: { TERM: 'linux', ALUY_SAFE_GLYPHS: '1' } });
    expect(t.unicode).toBe(false);
    expect(t.safeGlyphs).toBe(false); // sem Unicode, o ASCII puro já é o piso
    expect(t.glyph('toolInflight')).toBe('.'); // conjunto ASCII
  });
});

describe('fallbacks intactos (NO_COLOR / ASCII / 16-cores) — não regredir', () => {
  it('TERM=linux ⇒ ASCII puro; a marca aluy é `/\\`', () => {
    const t = resolveTheme({ env: { TERM: 'linux' } });
    expect(t.unicode).toBe(false);
    expect(t.glyph('aluy')).toBe(ALUY_MARK_ASCII);
    expect(t.glyph('aluy')).toBe('/\\');
    expect(ASCII_GLYPHS.aluy).toBe('/\\');
  });

  it('NO_COLOR ⇒ mono mas glifos ainda resolvem (significado no glifo+palavra)', () => {
    const t = resolveTheme({ env: { NO_COLOR: '1', ...UTF8 } });
    expect(t.colorMode).toBe('mono');
    // unicode segue ligado (NO_COLOR é sobre COR, não sobre fonte): default hardened.
    expect(t.glyph('window')).toBe('□');
  });

  it('16-cores (ansi16) ⇒ glifos default endurecidos, sem regressão', () => {
    const t = resolveTheme({ env: { TERM: 'xterm-256color', LANG: 'pt_BR.UTF-8' } });
    expect(t.colorMode).toBe('ansi16');
    expect(t.glyph('broker')).toBe('●');
  });

  it('a marca Unicode é exatamente o Λ (U+039B)', () => {
    expect(ALUY_MARK_UNICODE).toBe('Λ');
    expect(ALUY_MARK_UNICODE.codePointAt(0)).toBe(0x039b);
  });
});
