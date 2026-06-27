import { describe, expect, it } from 'vitest';
import {
  deserializeCredential,
  redactCredential,
  serializeCredential,
} from '../../src/auth/credential-store.js';
import type { StoredCredential } from '../../src/auth/types.js';

/** Monta um access JWT com `sub` (assinatura fake — não verificada). */
function makeAccessJwt(sub: string): string {
  const b64url = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ sub })}.SIG-SECRET-NOT-SHOWN`;
}

const DEVICE: StoredCredential = {
  kind: 'device',
  access_token: makeAccessJwt('user_dev_42'),
  refresh_token: 'REFRESH-SECRET',
  organization_id: 'org-1',
  scopes: ['assistant:session', 'llm:call'],
  expires_at: 123,
  v: 1,
};

const PAT: StoredCredential = {
  kind: 'pat',
  pat: 'pat_deadbeefdeadbeefdeadbeefdeadbeef_PAT-SECRET',
  organization_id: 'org-2',
  scopes: ['llm:call'],
  v: 1,
};

describe('serialize/deserialize', () => {
  it('round-trip preserva os campos', () => {
    expect(deserializeCredential(serializeCredential(DEVICE))).toEqual(DEVICE);
  });
  it('envelope inválido/versão errada ⇒ null', () => {
    expect(deserializeCredential('{bad json')).toBeNull();
    expect(deserializeCredential(JSON.stringify({ v: 2, kind: 'device' }))).toBeNull();
    expect(deserializeCredential(JSON.stringify({ v: 1, kind: 'x' }))).toBeNull();
  });
});

describe('redactCredential (CLI-SEC-2/10)', () => {
  it('device: NUNCA inclui access/refresh em claro', () => {
    const red = redactCredential(DEVICE);
    const json = JSON.stringify(red);
    // O JWT inteiro (e sua assinatura) nunca aparecem na forma redigida.
    expect(json).not.toContain('SIG-SECRET-NOT-SHOWN');
    expect(json).not.toContain(DEVICE.access_token);
    expect(json).not.toContain('REFRESH-SECRET');
    expect(red.token_hint).toBe('jwt');
    expect(red.scopes).toEqual(DEVICE.scopes);
  });
  it('device: expõe o `user` a partir do `sub` do access JWT (CA-1)', () => {
    expect(redactCredential(DEVICE).user).toBe('user_dev_42');
  });
  it('pat: NUNCA inclui o PAT em claro (só hint)', () => {
    const red = redactCredential(PAT);
    const json = JSON.stringify(red);
    expect(json).not.toContain('PAT-SECRET');
    expect(red.token_hint).toBe('pat_…');
  });
  it('pat: `user` ausente — user_id não é conhecido localmente', () => {
    expect(redactCredential(PAT)).not.toHaveProperty('user');
  });
  it('pat sem expires_at ⇒ campo ausente (vida-longa)', () => {
    expect(redactCredential(PAT)).not.toHaveProperty('expires_at');
  });

  // ── M-2: honestidade da validade (expired) ────────────────────────────────
  it('device EXPIRADO (expires_at no passado) ⇒ expired:true', () => {
    // `now` fixo DEPOIS do expires_at=123.
    const red = redactCredential(DEVICE, () => 10_000);
    expect(red.expired).toBe(true);
  });
  it('device VÁLIDO (expires_at no futuro) ⇒ expired:false', () => {
    const fresh: StoredCredential = { ...DEVICE, expires_at: 1_000_000 };
    const red = redactCredential(fresh, () => 10_000);
    expect(red.expired).toBe(false);
  });
  it('pat ⇒ expired:false sempre (validade é server-side, sem expiry local)', () => {
    expect(redactCredential(PAT, () => 10_000).expired).toBe(false);
  });
});
