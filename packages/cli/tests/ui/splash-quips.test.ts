// EST-1015 (pedido do dono) — frases DIVERTIDAS rotativas do splash. Lógica de rotação PURA.

import { describe, expect, it } from 'vitest';
import { SPLASH_QUIPS, splashQuipAt, splashQuip } from '../../src/ui/components/splash-quips.js';

describe('splash-quips — frases divertidas de carregamento (EST-1015)', () => {
  it('o pool tem frases curtas, PT-BR, sem reticências (a cauda é do render)', () => {
    expect(SPLASH_QUIPS.length).toBeGreaterThanOrEqual(8);
    for (const q of SPLASH_QUIPS) {
      expect(q.length, q).toBeGreaterThan(3);
      expect(q.length, q).toBeLessThanOrEqual(28); // cabe na linha do splash
      expect(q.endsWith('…'), q).toBe(false);
      expect(q.endsWith('...'), q).toBe(false);
    }
  });

  it('splashQuipAt ROTACIONA lento: muda a cada framesPerQuip e cicla', () => {
    // frames 0..5 ⇒ índice 0; 6..11 ⇒ 1; etc. (framesPerQuip=6 default).
    expect(splashQuipAt(0)).toBe(0);
    expect(splashQuipAt(5)).toBe(0);
    expect(splashQuipAt(6)).toBe(1);
    expect(splashQuipAt(12)).toBe(2);
    // cicla: além do fim volta ao começo.
    expect(splashQuipAt(SPLASH_QUIPS.length * 6)).toBe(0);
    // framesPerQuip custom.
    expect(splashQuipAt(1, 1)).toBe(1);
    expect(splashQuipAt(3, 1)).toBe(3 % SPLASH_QUIPS.length);
  });

  it('fail-safe: frame negativo/NaN ⇒ 1ª frase; índice sempre válido', () => {
    expect(splashQuipAt(-5)).toBe(0);
    expect(splashQuipAt(NaN)).toBe(0);
    const idx = splashQuipAt(999999);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(SPLASH_QUIPS.length);
    expect(typeof splashQuip(999999)).toBe('string');
    expect(splashQuip(0)).toBe(SPLASH_QUIPS[0]);
  });
});
