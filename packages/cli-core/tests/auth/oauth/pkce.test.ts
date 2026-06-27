// ADR-0120 / EST-1114 — OAuth 2.0 PKCE (geração, authorize URL, troca, refresh).
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generatePkcePair,
  buildAuthorizeUrl,
  base64UrlEncode,
  exchangeCodeForTokens,
  refreshTokens,
  parseTokenResponse,
  isTokenExpired,
  OAuthError,
  type PkceCrypto,
  type OAuthFetch,
  type OAuthProviderConfig,
} from '../../../src/auth/oauth/pkce.js';

/** Crypto determinístico p/ teste (bytes fixos + SHA-256 real). */
const fixedCrypto: PkceCrypto = {
  randomBytes: (n) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 7) % 256)),
  sha256: (input) => new Uint8Array(createHash('sha256').update(input).digest()),
};

const config: OAuthProviderConfig = {
  authorizeUrl: 'https://prov.test/oauth/authorize',
  tokenUrl: 'https://prov.test/oauth/token',
  clientId: 'cli-id',
  redirectUri: 'http://127.0.0.1:49876/callback',
  scopes: ['a', 'b'],
};

describe('PKCE (RFC 7636)', () => {
  it('gera verifier ≥43 chars e challenge = base64url(SHA-256(verifier))', () => {
    const pair = generatePkcePair(fixedCrypto, 32);
    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.method).toBe('S256');
    const expected = base64UrlEncode(
      new Uint8Array(
        createHash('sha256').update(new TextEncoder().encode(pair.codeVerifier)).digest(),
      ),
    );
    expect(pair.codeChallenge).toBe(expected);
  });

  it('base64url não tem padding nem +/=', () => {
    const s = base64UrlEncode(new Uint8Array([251, 255, 191]));
    expect(s).not.toMatch(/[+/=]/);
  });

  it('authorize URL carrega response_type=code, S256, challenge, state, scope', () => {
    const pair = generatePkcePair(fixedCrypto);
    const url = new URL(buildAuthorizeUrl(config, pair, 'st8'));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cli-id');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(pair.codeChallenge);
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('scope')).toBe('a b');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:49876/callback');
  });
});

/** fetch fake que grava o corpo e devolve o JSON dado. */
function fakeFetch(status: number, json: unknown): { fetch: OAuthFetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetch: OAuthFetch = async (_url, init) => {
    bodies.push(init.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  };
  return { fetch, bodies };
}

describe('exchangeCodeForTokens — troca code→tokens (PKCE §4.5)', () => {
  it('manda authorization_code + code_verifier; parseia o par + expiry', async () => {
    const { fetch, bodies } = fakeFetch(200, {
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 3600,
      scope: 'a b',
    });
    const now = () => 1_000_000;
    const tokens = await exchangeCodeForTokens({
      config,
      code: 'the-code',
      codeVerifier: 'the-verifier',
      fetch,
      now,
    });
    expect(tokens.accessToken).toBe('AT');
    expect(tokens.refreshToken).toBe('RT');
    expect(tokens.expiresAt).toBe(1_000_000 + 3600 * 1000);
    const body = new URLSearchParams(bodies[0]);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
  });

  it('erro do token endpoint ⇒ OAuthError (sem vazar token no detalhe)', async () => {
    const { fetch } = fakeFetch(400, { error: 'invalid_grant' });
    await expect(
      exchangeCodeForTokens({ config, code: 'x', codeVerifier: 'v', fetch }),
    ).rejects.toBeInstanceOf(OAuthError);
  });
});

describe('refreshTokens — RFC 6749 §6', () => {
  it('manda grant_type=refresh_token; preserva o refresh antigo se o provider não devolve um novo', async () => {
    const { fetch, bodies } = fakeFetch(200, { access_token: 'AT2', expires_in: 100 });
    const t = await refreshTokens({ config, refreshToken: 'OLD-RT', fetch, now: () => 0 });
    expect(t.accessToken).toBe('AT2');
    expect(t.refreshToken).toBe('OLD-RT'); // preservado
    expect(new URLSearchParams(bodies[0]).get('grant_type')).toBe('refresh_token');
  });

  it('usa o refresh novo quando o provider o devolve (rotação)', async () => {
    const { fetch } = fakeFetch(200, { access_token: 'AT2', refresh_token: 'NEW-RT' });
    const t = await refreshTokens({ config, refreshToken: 'OLD-RT', fetch });
    expect(t.refreshToken).toBe('NEW-RT');
  });
});

describe('parseTokenResponse / isTokenExpired', () => {
  it('sem access_token ⇒ OAuthError', () => {
    expect(() => parseTokenResponse({ refresh_token: 'x' }, () => 0)).toThrow(OAuthError);
  });
  it('vencido quando expiresAt <= now+skew', () => {
    expect(isTokenExpired({ accessToken: 'a', expiresAt: 1000 }, () => 999_000)).toBe(true);
    expect(isTokenExpired({ accessToken: 'a', expiresAt: 10_000_000 }, () => 0)).toBe(false);
  });
  it('sem expiresAt ⇒ tratado como NÃO-vencido', () => {
    expect(isTokenExpired({ accessToken: 'a' }, () => Date.now())).toBe(false);
  });
});
