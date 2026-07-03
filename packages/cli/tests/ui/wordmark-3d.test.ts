// Splash 3D — sombra ANSI animada (pedido do dono). Testa a lógica PURA: o tom que
// respira, a composição da grade (marca `accent` + sombra `depth` deslocada ↓→) e o
// agrupamento em segmentos. O efeito visual em si é verificado no TTY pelo dono.

import { describe, expect, it } from 'vitest';
import {
  shadowShade,
  composeShadowedWordmark,
  rowSegments,
  SHADOW_SHADES,
  type Cell,
} from '../../src/ui/components/wordmark-3d.js';

describe('shadowShade — a sombra "respira" (░▒▓▒)', () => {
  it('cicla nos 4 passos subindo e descendo (não pula de ▓ p/ ░)', () => {
    expect(shadowShade(0)).toBe('░');
    expect(shadowShade(1)).toBe('▒');
    expect(shadowShade(2)).toBe('▓');
    expect(shadowShade(3)).toBe('▒'); // desce de volta (respiração)
    expect(shadowShade(4)).toBe('░'); // recomeça
  });

  it('normaliza frame negativo (nunca quebra/undefined)', () => {
    expect(SHADOW_SHADES).toContain(shadowShade(-1));
    expect(SHADOW_SHADES).toContain(shadowShade(-7));
  });
});

describe('composeShadowedWordmark — marca + sombra 3D', () => {
  const grid = composeShadowedWordmark(2); // frame 2 ⇒ tom ▓

  it('grade tem 1 linha e 1 coluna a mais (espaço da sombra ↓→)', () => {
    // a marca block-art tem 7 linhas (o "luy" tem 2 de descender p/ o rabo curvado do y)
    // ⇒ grade 8; a sombra projeta 1 col à direita e 1 linha abaixo.
    expect(grid.length).toBe(8);
    const widths = new Set(grid.map((r) => r.length));
    expect(widths.size).toBe(1); // todas as linhas com a mesma largura (retângulo)
  });

  it('tem células da MARCA (accent █) e da SOMBRA (depth, tom do frame)', () => {
    const flat: Cell[] = grid.flat();
    const accent = flat.filter((c) => c.role === 'accent');
    const depth = flat.filter((c) => c.role === 'depth');
    expect(accent.length).toBeGreaterThan(0);
    expect(depth.length).toBeGreaterThan(0);
    expect(accent.every((c) => c.char === '█')).toBe(true);
    expect(depth.every((c) => c.char === '▓')).toBe(true); // frame 2 ⇒ ▓
  });

  it('a sombra de (r,c) acende quando a marca em (r-1,c-1) é preenchida e (r,c) é vazia', () => {
    // varre a grade: toda célula `depth` tem um `accent` na diagonal acima-à-esquerda.
    for (let r = 0; r < grid.length; r += 1) {
      for (let c = 0; c < grid[r]!.length; c += 1) {
        if (grid[r]![c]!.role === 'depth') {
          expect(grid[r - 1]?.[c - 1]?.role).toBe('accent');
        }
      }
    }
  });

  it('o tom da sombra muda com o frame (anima)', () => {
    const shadeAt = (f: number): string | undefined =>
      composeShadowedWordmark(f)
        .flat()
        .find((c) => c.role === 'depth')?.char;
    expect(shadeAt(0)).toBe('░');
    expect(shadeAt(2)).toBe('▓');
    expect(shadeAt(0)).not.toBe(shadeAt(2)); // frames diferentes ⇒ sombra diferente
  });
});

describe('rowSegments — agrupa células de mesmo papel', () => {
  it('funde consecutivas e separa por papel', () => {
    const row: Cell[] = [
      { role: 'accent', char: '█' },
      { role: 'accent', char: '█' },
      { role: null, char: ' ' },
      { role: 'depth', char: '▒' },
    ];
    expect(rowSegments(row)).toEqual([
      { role: 'accent', text: '██' },
      { role: null, text: ' ' },
      { role: 'depth', text: '▒' },
    ]);
  });
});
