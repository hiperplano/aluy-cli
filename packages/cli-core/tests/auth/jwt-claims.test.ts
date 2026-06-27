import { describe, expect, it } from 'vitest';
import { jwtSubForDisplay } from '../../src/auth/jwt-claims.js';

/** Monta um JWT (header.payload.signature) com o payload dado — assinatura fake. */
function makeJwt(payload: Record<string, unknown>, sig = 'FAKE-SIG-NOT-VERIFIED'): string {
  const b64url = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.${sig}`;
}

describe('jwtSubForDisplay (display-only, sem verificar assinatura)', () => {
  it('extrai o `sub` do payload de um JWT válido', () => {
    const jwt = makeJwt({ sub: 'user_abc123', organization_id: 'org-1' });
    expect(jwtSubForDisplay(jwt)).toBe('user_abc123');
  });

  it('NÃO verifica assinatura — `sub` sai mesmo com assinatura lixo', () => {
    const jwt = makeJwt({ sub: 'user_xyz' }, 'qualquer-coisa');
    expect(jwtSubForDisplay(jwt)).toBe('user_xyz');
  });

  it('undefined/vazio ⇒ undefined', () => {
    expect(jwtSubForDisplay(undefined)).toBeUndefined();
    expect(jwtSubForDisplay('')).toBeUndefined();
  });

  it('não é JWT de 3 partes ⇒ undefined (tolerante)', () => {
    expect(jwtSubForDisplay('só-uma-parte')).toBeUndefined();
    expect(jwtSubForDisplay('a.b')).toBeUndefined();
    expect(jwtSubForDisplay('a.b.c.d')).toBeUndefined();
  });

  it('payload que não é JSON ⇒ undefined (nunca lança)', () => {
    expect(jwtSubForDisplay('aGVhZGVy.bm90LWpzb24.sig')).toBeUndefined();
  });

  it('JSON válido sem `sub` (ou `sub` não-string/vazio) ⇒ undefined', () => {
    expect(jwtSubForDisplay(makeJwt({ organization_id: 'org-1' }))).toBeUndefined();
    expect(jwtSubForDisplay(makeJwt({ sub: 123 }))).toBeUndefined();
    expect(jwtSubForDisplay(makeJwt({ sub: '' }))).toBeUndefined();
  });
});
