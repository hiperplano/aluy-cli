import { describe, expect, it, afterEach, vi } from 'vitest';
import { idempotencyKeyFor, newSessionId } from '../../src/agent/idempotency.js';

describe('EST-0944 · Idempotency-Key (nasce no loop)', () => {
  it('é estável por (sessão, iteração)', () => {
    expect(idempotencyKeyFor('s1', 0)).toBe('s1:0');
    expect(idempotencyKeyFor('s1', 0)).toBe(idempotencyKeyFor('s1', 0));
  });

  it('muda quando a iteração avança (chamada lógica distinta)', () => {
    expect(idempotencyKeyFor('s1', 0)).not.toBe(idempotencyKeyFor('s1', 1));
  });

  it('muda quando a sessão muda', () => {
    expect(idempotencyKeyFor('s1', 0)).not.toBe(idempotencyKeyFor('s2', 0));
  });

  it('newSessionId gera ids únicos', () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  describe('fallback sem crypto.randomUUID', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('devolve string não-vazia começando com sess- quando crypto.randomUUID está indisponível', () => {
      vi.stubGlobal('crypto', {});
      const id = newSessionId();
      expect(id).toBeTruthy();
      expect(id.startsWith('sess-')).toBe(true);
    });
  });
});
