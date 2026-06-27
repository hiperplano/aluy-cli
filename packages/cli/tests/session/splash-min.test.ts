// Piso de exibição do splash (feedback Tiago): com broker LOCAL o boot é quase
// instantâneo e a frase divertida do splash mal aparecia. `resolveSplashMinMs`
// decide o tempo mínimo de tela; override por ALUY_SPLASH_MIN_MS (>=0; 0 desliga).
import { describe, expect, it } from 'vitest';
import { resolveSplashMinMs } from '../../src/session/splash-controller.js';

describe('resolveSplashMinMs — piso do splash', () => {
  it('default 2000ms (sem env)', () => expect(resolveSplashMinMs({})).toBe(2000));
  it('override ALUY_SPLASH_MIN_MS', () =>
    expect(resolveSplashMinMs({ ALUY_SPLASH_MIN_MS: '3000' })).toBe(3000));
  it('0 desliga o piso (boot instantâneo)', () =>
    expect(resolveSplashMinMs({ ALUY_SPLASH_MIN_MS: '0' })).toBe(0));
  it('inválido ⇒ default 2000', () =>
    expect(resolveSplashMinMs({ ALUY_SPLASH_MIN_MS: 'abc' })).toBe(2000));
  it('negativo ⇒ default 2000', () =>
    expect(resolveSplashMinMs({ ALUY_SPLASH_MIN_MS: '-5' })).toBe(2000));
});
