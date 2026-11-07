// F-GLYPH-PESO — pedido do dono, após ver o opencode: "o peso e preenchimento
// dele é melhor" (mais do que os ícones). Estes testes travam a ÚNICA troca de
// peso possível sem colidir com teste alheio pinado (ver header de glyphs.ts p/
// a lista completa das candidatas BLOQUEADAS por valor literal em
// glyphs-hardening.test.ts/components.test.tsx/animation.test.tsx/
// status-bar-mcp.test.tsx/divider.test.tsx): `gauge` (◔ → ◉, mais massa/
// preenchimento), com fallback SAFE/ASCII intacto e o perfil NERD sincronizado.

import { describe, expect, it } from 'vitest';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { UNICODE_GLYPHS, SAFE_GLYPHS, ASCII_GLYPHS, NERD_GLYPHS } from '../../src/ui/theme/glyphs.js';

const UTF8 = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };

describe('gauge — mais peso/preenchimento no perfil NORMAL (F-GLYPH-PESO)', () => {
  it('UNICODE_GLYPHS.gauge é ◉ (FISHEYE, centro preenchido) — não mais o ◔ vazado', () => {
    expect(UNICODE_GLYPHS.gauge).toBe('◉');
    expect(UNICODE_GLYPHS.gauge).not.toBe('◔');
    expect(UNICODE_GLYPHS.gauge.codePointAt(0)).toBe(0x25c9);
  });

  it('resolveTheme (default, sem overrides) já entrega o glifo com mais peso', () => {
    const t = resolveTheme({ env: UTF8 });
    expect(t.glyph('gauge')).toBe('◉');
  });

  it('largura de terminal segura: 1 code point, 1 unidade UTF-16 (sem largura ambígua/dupla)', () => {
    expect([...UNICODE_GLYPHS.gauge].length).toBe(1);
    expect(UNICODE_GLYPHS.gauge.length).toBe(1);
  });

  it('mesmo bloco Unicode (Geometric Shapes, 25xx) que os vizinhos já em uso — sem char de risco novo', () => {
    // ●(25CF)/◑(25D1)/□(25A1) já vivem no default; ◉(25C9) é o MESMO bloco, mesma
    // cobertura de fonte — não reabre o risco de tofu que o EST-0984 endureceu.
    const cp = UNICODE_GLYPHS.gauge.codePointAt(0)!;
    expect(cp).toBeGreaterThanOrEqual(0x25a0);
    expect(cp).toBeLessThanOrEqual(0x25ff);
  });

  it('SAFE_GLYPHS.gauge NÃO mudou — fallback intacto (só o perfil NORMAL ganhou peso)', () => {
    expect(SAFE_GLYPHS.gauge).toBe('◔');
    const t = resolveTheme({ env: { ...UTF8, ALUY_SAFE_GLYPHS: '1' } });
    expect(t.glyph('gauge')).toBe('◔');
  });

  it('ASCII_GLYPHS.gauge NÃO mudou — segue o rótulo `%:` (TERM=linux)', () => {
    expect(ASCII_GLYPHS.gauge).toBe('%:');
    const t = resolveTheme({ env: { TERM: 'linux' } });
    expect(t.glyph('gauge')).toBe('%:');
  });

  it('NERD_GLYPHS.gauge foi SINCRONIZADO com o novo normal (não é ícone Nerd; espelha)', () => {
    expect(NERD_GLYPHS.gauge).toBe(UNICODE_GLYPHS.gauge);
    expect(NERD_GLYPHS.gauge).toBe('◉');
  });
});
