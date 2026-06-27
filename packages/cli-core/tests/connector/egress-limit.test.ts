import { describe, it, expect } from 'vitest';
import { EgressRateLimiter } from '../../src/connector/egress-limit.js';

describe('EgressRateLimiter (ADR-0135 TC-6 / CLI-SEC-8 — anti-spam, puro)', () => {
  it('permite até N na janela, NEGA o N+1', () => {
    const lim = new EgressRateLimiter(3, 1000);
    expect(lim.tryConsume(0)).toBe(true);
    expect(lim.tryConsume(10)).toBe(true);
    expect(lim.tryConsume(20)).toBe(true);
    expect(lim.tryConsume(30)).toBe(false); // 4º na janela ⇒ negado
    expect(lim.used).toBe(3);
  });

  it('janela deslizante: libera quando os antigos expiram', () => {
    const lim = new EgressRateLimiter(2, 1000);
    expect(lim.tryConsume(0)).toBe(true);
    expect(lim.tryConsume(500)).toBe(true);
    expect(lim.tryConsume(900)).toBe(false); // cheio
    expect(lim.tryConsume(1001)).toBe(true); // o de t=0 expirou (>1000ms) ⇒ libera 1
    expect(lim.used).toBe(2); // t=500 e t=1001
  });

  it('teto 1 ⇒ serializa estritamente por janela', () => {
    const lim = new EgressRateLimiter(1, 100);
    expect(lim.tryConsume(0)).toBe(true);
    expect(lim.tryConsume(50)).toBe(false);
    expect(lim.tryConsume(101)).toBe(true);
  });
});
