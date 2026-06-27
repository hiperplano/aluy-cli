// EST-0948 · spec §3 — resolução do tema de terminal (capacidade do env).
// NO_COLOR ⇒ mono; truecolor/16; tema claro; Unicode vs ASCII; reduced-motion.

import { describe, expect, it } from 'vitest';
import {
  resolveTheme,
  detectColorMode,
  detectBrightness,
  detectUnicode,
} from '../../src/ui/theme/theme.js';

describe('detectColorMode', () => {
  it('NO_COLOR ⇒ mono (vence tudo)', () => {
    expect(detectColorMode({ NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe('mono');
    expect(detectColorMode({ NO_COLOR: '' })).toBe('mono'); // qualquer valor, até vazio
  });
  it('COLORTERM=truecolor ⇒ truecolor', () => {
    expect(detectColorMode({ COLORTERM: 'truecolor', TERM: 'xterm-256color' })).toBe('truecolor');
  });
  it('TERM=dumb ⇒ mono', () => {
    expect(detectColorMode({ TERM: 'dumb' })).toBe('mono');
  });
  it('terminal comum ⇒ ansi16', () => {
    expect(detectColorMode({ TERM: 'xterm-256color' })).toBe('ansi16');
  });
});

describe('detectBrightness', () => {
  it('default ⇒ dark', () => {
    expect(detectBrightness({})).toBe('dark');
  });
  it('COLORFGBG com bg claro ⇒ light', () => {
    expect(detectBrightness({ COLORFGBG: '0;15' })).toBe('light');
  });
  it('override explícito vence', () => {
    expect(detectBrightness({ COLORFGBG: '0;15' }, 'dark')).toBe('dark');
  });
});

describe('detectUnicode', () => {
  it('TERM=linux ⇒ ASCII (sem Unicode)', () => {
    expect(detectUnicode({ TERM: 'linux' })).toBe(false);
  });
  it('locale UTF-8 ⇒ Unicode', () => {
    expect(detectUnicode({ LANG: 'pt_BR.UTF-8', TERM: 'xterm' })).toBe(true);
  });
  it('locale não-UTF-8 ⇒ ASCII', () => {
    expect(detectUnicode({ LANG: 'C', TERM: 'xterm' })).toBe(false);
  });
});

describe('resolveTheme', () => {
  it('NO_COLOR ⇒ papéis sem cor crua (mono) — significado no glifo+palavra', () => {
    const t = resolveTheme({ env: { NO_COLOR: '1' } });
    expect(t.colorMode).toBe('mono');
    // accent em mono: sem `color`, só ênfase (bold).
    expect(t.role('accent').color).toBeUndefined();
    expect(t.role('accent').bold).toBe(true);
    // danger em mono carrega significado por inverse (não por cor).
    expect(t.role('danger').color).toBeUndefined();
  });

  it('truecolor dark ⇒ accent é o amber do DS', () => {
    const t = resolveTheme({ env: { COLORTERM: 'truecolor', TERM: 'xterm' } });
    expect(t.role('accent').color).toBe('#DDA13F');
  });

  it('tema claro ⇒ accent escurecido p/ contraste', () => {
    const t = resolveTheme({ env: { COLORTERM: 'truecolor' }, theme: 'light' });
    expect(t.role('accent').color).toBe('#82530F');
  });

  it('ASCII fallback dos glifos (TERM=linux)', () => {
    const t = resolveTheme({ env: { TERM: 'linux' } });
    expect(t.unicode).toBe(false);
    expect(t.glyph('ask')).toBe('!');
    expect(t.glyph('ok')).toBe('[ok]');
    expect(t.glyph('aluy')).toBe('/\\'); // EST-0984: marca Λ → fallback ASCII /\
    expect(t.box.vertical).toBe('|');
  });

  it('Unicode ⇒ glifos geométricos', () => {
    const t = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
    expect(t.glyph('ask')).toBe('⚠');
    expect(t.glyph('broker')).toBe('●'); // EST-0984: ◍ → ● (cobertura ampla)
    expect(t.glyph('aluy')).toBe('Λ'); // EST-0984: ◇ → Λ (marca real)
  });

  it('ALUY_NO_ANIM desliga animação (prefers-reduced-motion)', () => {
    expect(resolveTheme({ env: { ALUY_NO_ANIM: '1' } }).animate).toBe(false);
    expect(resolveTheme({ env: {} }).animate).toBe(true);
  });

  it('ALUY_DENSITY=compact ⇒ densidade compacta', () => {
    expect(resolveTheme({ env: { ALUY_DENSITY: 'compact' } }).density).toBe('compact');
    expect(resolveTheme({ env: {} }).density).toBe('comfortable');
  });
});
