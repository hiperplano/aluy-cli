// ADR-0120 / EST-1114 — store de tokens OAuth (refresh automático + single-flight).
import { describe, expect, it, vi } from 'vitest';
import { OAuthTokenStore } from '../../../src/model/local/oauth-store.js';
import type { OAuthFetch, OAuthProviderConfig } from '@hiperplano/aluy-cli-core';

const config: OAuthProviderConfig = {
  authorizeUrl: 'https://prov.test/authorize',
  tokenUrl: 'https://prov.test/token',
  clientId: 'cid',
  redirectUri: 'http://127.0.0.1:49876/callback',
  scopes: [],
};

/** Fake de keychain em memória. */
function fakeKeyring(store: Record<string, string>) {
  return (_s: string, account: string) => ({
    getPassword: () => store[account] ?? '',
    setPassword: (p: string) => {
      store[account] = p;
    },
    deletePassword: () => {
      const had = account in store;
      delete store[account];
      return had;
    },
  });
}

describe('OAuthTokenStore', () => {
  it('getAccessToken devolve o token válido sem refrescar', async () => {
    const store = new OAuthTokenStore({
      provider: 'anthropic',
      config,
      entryFactory: fakeKeyring({
        'anthropic:oauth': JSON.stringify({ accessToken: 'AT', expiresAt: 10_000_000 }),
      }),
      now: () => 0,
    });
    expect(await store.getAccessToken()).toBe('AT');
  });

  it('refresca quando vencido e persiste o novo par', async () => {
    const mem = {
      'anthropic:oauth': JSON.stringify({ accessToken: 'OLD', refreshToken: 'RT', expiresAt: 500 }),
    };
    const fetch: OAuthFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'NEW', expires_in: 3600 }),
      text: async () => '',
    });
    const store = new OAuthTokenStore({
      provider: 'anthropic',
      config,
      entryFactory: fakeKeyring(mem),
      fetch,
      now: () => 1_000_000, // bem depois do expiresAt
    });
    expect(await store.getAccessToken()).toBe('NEW');
    // persistiu o novo token (com o refresh antigo preservado).
    const saved = JSON.parse(mem['anthropic:oauth']);
    expect(saved.accessToken).toBe('NEW');
    expect(saved.refreshToken).toBe('RT');
  });

  it('SINGLE-FLIGHT: refreshes concorrentes compartilham UMA chamada', async () => {
    const mem = {
      'anthropic:oauth': JSON.stringify({ accessToken: 'OLD', refreshToken: 'RT', expiresAt: 1 }),
    };
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'NEW', expires_in: 3600 }),
      text: async () => '',
    }));
    const store = new OAuthTokenStore({
      provider: 'anthropic',
      config,
      entryFactory: fakeKeyring(mem),
      fetch: fetchSpy as unknown as OAuthFetch,
      now: () => 1_000_000,
    });
    const [a, b, c] = await Promise.all([
      store.getAccessToken(),
      store.getAccessToken(),
      store.getAccessToken(),
    ]);
    expect([a, b, c]).toEqual(['NEW', 'NEW', 'NEW']);
    // UMA única chamada de refresh, não três (single-flight).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('vencido SEM refresh_token ⇒ undefined (força re-login)', async () => {
    const store = new OAuthTokenStore({
      provider: 'anthropic',
      config,
      entryFactory: fakeKeyring({
        'anthropic:oauth': JSON.stringify({ accessToken: 'OLD', expiresAt: 1 }),
      }),
      now: () => 1_000_000,
    });
    expect(await store.getAccessToken()).toBeUndefined();
  });

  it('sem login ⇒ undefined', async () => {
    const store = new OAuthTokenStore({
      provider: 'anthropic',
      config,
      entryFactory: fakeKeyring({}),
      now: () => 0,
    });
    expect(await store.getAccessToken()).toBeUndefined();
  });
});
