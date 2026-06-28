// ADR-0120 / EST-1113 — resolvedor de credencial BYO (keychain → env).
import { describe, expect, it, vi } from 'vitest';
import {
  createLocalCredentialProvider,
  MissingLocalCredentialError,
  type KeyringEntry,
} from '../../../src/model/local/credential-resolver.js';

/** Fake de keychain em memória (account → senha). */
function fakeKeyring(store: Record<string, string>) {
  return (_service: string, account: string): KeyringEntry => ({
    getPassword: () => {
      const v = store[account];
      if (v === undefined) throw new Error('no matching entry');
      return v;
    },
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

describe('createLocalCredentialProvider — apikey: keychain → env', () => {
  it('prefere o keychain quando há chave guardada', async () => {
    const factory = fakeKeyring({ 'anthropic:apikey': 'sk-keychain' });
    const provider = createLocalCredentialProvider({
      provider: 'anthropic',
      entryFactory: factory,
      env: { ANTHROPIC_API_KEY: 'sk-env' },
    });
    expect(await provider()).toEqual({ kind: 'apikey', secret: 'sk-keychain' });
  });

  it('cai p/ a env var quando o keychain está vazio', async () => {
    const factory = fakeKeyring({});
    const provider = createLocalCredentialProvider({
      provider: 'openrouter',
      entryFactory: factory,
      env: { OPENROUTER_API_KEY: 'sk-or-env' },
    });
    expect(await provider()).toEqual({ kind: 'apikey', secret: 'sk-or-env' });
  });

  it('sem keychain nem env ⇒ MissingLocalCredentialError (mensagem acionável)', async () => {
    const provider = createLocalCredentialProvider({
      provider: 'openai',
      entryFactory: fakeKeyring({}),
      env: {},
    });
    await expect(provider()).rejects.toBeInstanceOf(MissingLocalCredentialError);
  });

  it('auth `none` (Ollama local) ⇒ credencial vazia, NÃO lança (sem exigir chave)', async () => {
    const provider = createLocalCredentialProvider({
      provider: 'ollama',
      auth: 'none',
      entryFactory: fakeKeyring({}),
      env: {},
    });
    await expect(provider()).resolves.toEqual({ kind: 'none', secret: '' });
  });

  it('a env var é a do provider certo (não cruza providers)', async () => {
    const provider = createLocalCredentialProvider({
      provider: 'anthropic',
      entryFactory: fakeKeyring({}),
      env: { OPENAI_API_KEY: 'sk-openai' }, // var do OUTRO provider
    });
    await expect(provider()).rejects.toBeInstanceOf(MissingLocalCredentialError);
  });
});

describe('createLocalCredentialProvider — oauth: usa o provedor de token', () => {
  it('devolve o access token do provedor OAuth', async () => {
    const provider = createLocalCredentialProvider({
      provider: 'anthropic',
      auth: 'oauth',
      oauthAccessToken: async () => 'oat-fresh',
    });
    expect(await provider()).toEqual({ kind: 'oauth', secret: 'oat-fresh' });
  });

  it('sem token (não logado) ⇒ MissingLocalCredentialError', async () => {
    const provider = createLocalCredentialProvider({
      provider: 'anthropic',
      auth: 'oauth',
      oauthAccessToken: async () => undefined,
    });
    await expect(provider()).rejects.toBeInstanceOf(MissingLocalCredentialError);
  });

  it('resolve a CADA chamada (pega rotação de chave sem reiniciar)', async () => {
    const getter = vi.fn().mockResolvedValueOnce('t1').mockResolvedValueOnce('t2');
    const provider = createLocalCredentialProvider({
      provider: 'anthropic',
      auth: 'oauth',
      oauthAccessToken: getter,
    });
    expect((await provider()).secret).toBe('t1');
    expect((await provider()).secret).toBe('t2');
    expect(getter).toHaveBeenCalledTimes(2);
  });
});
