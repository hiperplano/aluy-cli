// EST-0966 / EST-1010 · /theme — catálogo dos 3 temas NOMEADOS (port do aluy web).
//
// Cobre: o registro lista dark+light+slate (dark default); a resolução de nome
// (canônico/apelido/inválido); `resolveThemeByName` mapeia a PALETA + brilho do tema e
// PRESERVA as capacidades do env (NO_COLOR / densidade); o accent ÂMBAR nos três; o
// PISO de contraste AA — cada papel COLORIDO de CADA tema ≥ 4.5:1 (texto normal, WCAG
// AA) sobre o `bg` do próprio tema (accentDim é AA-large, ≥3:1: dívida de DS).

import { describe, expect, it } from 'vitest';
import {
  THEMES,
  DEFAULT_THEME,
  themeByName,
  resolveThemeName,
  themeNameForBrightness,
  resolveThemeByName,
  type ThemeEntry,
} from '../../src/ui/theme/themes.js';
import { relativeLuminance, type Rgb } from '../../src/ui/theme/osc11.js';
import { type TermRole } from '../../src/ui/theme/palette.js';

function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)!;
  return { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) };
}

/** Razão de contraste WCAG entre duas cores (1:1 a 21:1). */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(hexToRgb(a));
  const lb = relativeLuminance(hexToRgb(b));
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const COLORED_ROLES: readonly TermRole[] = [
  'fg',
  'fgDim',
  'accent',
  'accentMid',
  'accentDim',
  'danger',
  'success',
  'depth',
];

describe('catálogo de temas (/theme) — os 3 do aluy web', () => {
  it('lista dark + light + slate, com dark como default (1º item)', () => {
    const names = THEMES.map((t) => t.name);
    expect(names).toEqual(['aluy-dark', 'aluy-light', 'aluy-slate']);
    expect(DEFAULT_THEME).toBe('aluy-dark');
    expect(THEMES[0]!.name).toBe('aluy-dark');
    expect(themeByName('aluy-dark')!.brightness).toBe('dark');
    expect(themeByName('aluy-light')!.brightness).toBe('light');
    // slate é ESCURO (degrada ansi16/glifos como dark), só o fundo/tom muda.
    expect(themeByName('aluy-slate')!.brightness).toBe('dark');
  });

  it('cada tema declara o seu FUNDO (--bg) resolvido dos tokens do DS', () => {
    expect(themeByName('aluy-light')!.bg).toBe('#F4ECDC'); // creme + quente (o --stone-50 #FAF8F5 "lava" no terminal — pedido do dono)
    expect(themeByName('aluy-dark')!.bg).toBe('#070707'); // quase-preto neutro
    expect(themeByName('aluy-slate')!.bg).toBe('#0E0C09'); // --stone-950 (terra)
    // os três fundos são DISTINTOS (o pedido central: mudar o fundo por tema).
    const bgs = THEMES.map((t) => t.bg);
    expect(new Set(bgs).size).toBe(3);
  });

  it('os 3 temas têm os MESMOS 8 papéis (paridade DS)', () => {
    for (const t of THEMES) {
      expect(Object.keys(t.palette).sort()).toEqual([...COLORED_ROLES].sort());
    }
  });

  it('accent ÂMBAR nos 3 temas (o amarelo do Λluy) — escurecido só no light p/ AA', () => {
    // dark + slate: --amber-400 (#DDA13F). light: --amber-700 (#82530F) p/ AA no creme.
    expect(themeByName('aluy-dark')!.palette.accent.color).toBe('#DDA13F');
    expect(themeByName('aluy-slate')!.palette.accent.color).toBe('#DDA13F');
    expect(themeByName('aluy-light')!.palette.accent.color).toBe('#82530F');
    // todos âmbar (tom quente): R > G > B em todos.
    for (const t of THEMES) {
      const { r, g, b } = hexToRgb(t.palette.accent.color!);
      expect(r).toBeGreaterThan(g);
      expect(g).toBeGreaterThan(b);
    }
  });

  it('slate ≠ dark no tom (fundo + fgDim warm), mas MESMO accent', () => {
    const dark = themeByName('aluy-dark')!;
    const slate = themeByName('aluy-slate')!;
    expect(slate.bg).not.toBe(dark.bg);
    // fgDim do slate é a AREIA do DS (--stone-400), distinta do dark neutro.
    expect(slate.palette.fgDim.color).toBe('#B0A593');
    expect(slate.palette.fgDim.color).not.toBe(dark.palette.fgDim.color);
    // mas o accent é idêntico (a marca não muda entre os temas escuros).
    expect(slate.palette.accent.color).toBe(dark.palette.accent.color);
  });
});

describe('resolveThemeName — nome canônico, apelido e inválido', () => {
  it('nome canônico (case/space-insensitive)', () => {
    expect(resolveThemeName('aluy-light')!.name).toBe('aluy-light');
    expect(resolveThemeName('  ALUY-DARK ')!.name).toBe('aluy-dark');
    expect(resolveThemeName('aluy-slate')!.name).toBe('aluy-slate');
  });
  it('apelido curto (`light`/`dark`/`slate`)', () => {
    expect(resolveThemeName('light')!.name).toBe('aluy-light');
    expect(resolveThemeName('dark')!.name).toBe('aluy-dark');
    expect(resolveThemeName('slate')!.name).toBe('aluy-slate');
  });
  it('rótulo amigável (`Aluy Slate`)', () => {
    expect(resolveThemeName('aluy slate')!.name).toBe('aluy-slate');
  });
  it('inválido ⇒ undefined', () => {
    expect(resolveThemeName('solarized')).toBeUndefined();
    expect(resolveThemeName('')).toBeUndefined();
  });
  it('themeNameForBrightness: light⇒light, dark⇒dark (slate é escolha explícita)', () => {
    expect(themeNameForBrightness('light')).toBe('aluy-light');
    expect(themeNameForBrightness('dark')).toBe('aluy-dark');
  });
});

describe('resolveThemeByName — troca a PALETA por tema, preserva capacidades do env', () => {
  it('aluy-light ⇒ brilho light + accent escurecido (#82530F)', () => {
    const t = resolveThemeByName('aluy-light', { env: { COLORTERM: 'truecolor' } });
    expect(t.brightness).toBe('light');
    expect(t.role('accent').color).toBe('#82530F');
    expect(t.role('fg').color).toBe('#1A1712');
  });
  it('aluy-dark ⇒ brilho dark + amber (#DDA13F) + fgDim neutro', () => {
    const t = resolveThemeByName('aluy-dark', { env: { COLORTERM: 'truecolor' } });
    expect(t.brightness).toBe('dark');
    expect(t.role('accent').color).toBe('#DDA13F');
    expect(t.role('fgDim').color).toBe('#8A7F6D');
  });
  it('aluy-slate ⇒ brilho dark mas PALETA warm (fgDim areia #B0A593)', () => {
    const t = resolveThemeByName('aluy-slate', { env: { COLORTERM: 'truecolor' } });
    expect(t.brightness).toBe('dark');
    expect(t.role('accent').color).toBe('#DDA13F'); // mesmo accent do dark
    expect(t.role('fgDim').color).toBe('#B0A593'); // warm, ≠ dark neutro
    expect(t.role('fg').color).toBe('#F2EEE8'); // --stone-100 (creme)
  });
  it('ansi16: slate NÃO usa a paleta truecolor — degrada por brilho (dark)', () => {
    // sem COLORTERM=truecolor ⇒ ansi16; o override truecolor é ignorado (degradação).
    const t = resolveThemeByName('aluy-slate', { env: { TERM: 'xterm-256color' } });
    expect(t.colorMode).toBe('ansi16');
    expect(t.role('accent').color).toBe('yellow'); // nome Ink (16-cores), não hex
    expect(t.role('fg').color).toBe('white'); // dark ansi16
  });
  it('NO_COLOR é PRESERVADO ao trocar p/ QUALQUER tema (mono vence)', () => {
    for (const name of ['aluy-light', 'aluy-dark', 'aluy-slate']) {
      const t = resolveThemeByName(name, { env: { NO_COLOR: '1' } });
      expect(t.colorMode).toBe('mono');
      expect(t.role('accent').color).toBeUndefined(); // sem cor crua, só ênfase
      expect(t.role('accent').bold).toBe(true);
    }
  });
  it('densidade compacta é preservada', () => {
    const t = resolveThemeByName('aluy-slate', { env: {}, density: 'compact' });
    expect(t.density).toBe('compact');
  });
  it('nome desconhecido cai no default (dark), nunca quebra', () => {
    const t = resolveThemeByName('inexistente', { env: { COLORTERM: 'truecolor' } });
    expect(t.brightness).toBe('dark');
    expect(t.role('accent').color).toBe('#DDA13F');
  });
});

describe('contraste AA — cada papel colorido ≥ AA sobre o --bg do PRÓPRIO tema', () => {
  // accentDim é realce CALMO (wordmark de boot, bold/grande) ⇒ piso AA-large (≥3:1),
  // como já documentado p/ o dark (dívida de DS não-bloqueante). Os demais: AA pleno.
  function floorFor(role: TermRole): number {
    return role === 'accentDim' ? 3 : 4.5;
  }
  for (const theme of THEMES) {
    describe(`${theme.label} (${theme.name}) sobre ${theme.bg}`, () => {
      for (const role of COLORED_ROLES) {
        it(`papel "${role}" passa o piso de contraste`, () => {
          const t = theme as ThemeEntry;
          const color = t.palette[role].color!;
          const ratio = contrastRatio(color, t.bg);
          expect(ratio).toBeGreaterThanOrEqual(floorFor(role));
        });
      }
    });
  }
});
