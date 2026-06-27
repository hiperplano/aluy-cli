// Testes de `aluy logout` — runLogout({ io?, store?, env?, fetch? }).
// Cobre 2 ramos descobertos: device offline (linhas 43-46) e NoKeychainError
// (linhas 50-52). EST-1013.

import { describe, expect, it } from 'vitest';
import { runLogout } from '../../src/commands/logout.js';
import { NoKeychainError } from '../../src/auth/keychain-store.js';
import type { CredentialStore, StoredCredential } from '@hiperplano/aluy-cli-core';
import type { FetchLike } from '@hiperplano/aluy-cli-core';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Fake IO que acumula as linhas de saída. */
function makeFakeIo(): {
  outLines: string[];
  errLines: string[];
  io: { out: (s: string) => void; err: (s: string) => void };
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    io: {
      out(s: string) {
        outLines.push(s);
      },
      err(s: string) {
        errLines.push(s);
      },
    },
  };
}

/** Store EM MEMÓRIA — implementa CredentialStore sem keychain real. */
class InMemoryStore implements CredentialStore {
  private cred: StoredCredential | null = null;

  async get(): Promise<StoredCredential | null> {
    return this.cred;
  }
  async set(credential: StoredCredential): Promise<void> {
    this.cred = credential;
  }
  async clear(): Promise<void> {
    this.cred = null;
  }
}

/** Fetch que SEMPRE falha (simula offline/rede indisponível). */
const failingFetch: FetchLike = async () => {
  throw new Error('network down');
};

describe('runLogout', () => {
  // -----------------------------------------------------------------------
  // (A) LINHAS 43-46 — DEVICE com revogação NÃO confirmada (offline)
  // -----------------------------------------------------------------------
  it('retorna 0 e informa possível offline quando revoke falha (device, linhas 43-46)', async () => {
    const store = new InMemoryStore();
    await store.set({
      kind: 'device',
      access_token: 'acc-test',
      refresh_token: 'ref-test',
      organization_id: 'org-1',
      scopes: ['assistant:session', 'llm:call'],
      expires_at: Date.now() + 3600_000,
      v: 1,
    });

    const { io, outLines } = makeFakeIo();

    const exitCode = await runLogout({
      io: io,
      store,
      env: { ALUY_IDENTITY_URL: 'http://localhost' },
      fetch: failingFetch,
    });

    expect(exitCode).toBe(0);
    // Deve conter a mensagem do ramo device-offline (linhas 45-46 do logout.ts).
    expect(outLines.length).toBe(1);
    expect(outLines[0]).toContain('Revogação no servidor não confirmada');
    // O store deve estar limpo mesmo com revogação falha.
    expect(await store.get()).toBeNull();
  });

  // -----------------------------------------------------------------------
  // (B) LINHAS 50-52 — NoKeychainError
  // -----------------------------------------------------------------------
  it('retorna 1 e imprime o erro quando store.load() rejeita com NoKeychainError (linhas 50-52)', async () => {
    const store: CredentialStore = {
      get(): Promise<StoredCredential | null> {
        return Promise.reject(new NoKeychainError('simulação de keychain indisponível'));
      },
      set(): Promise<void> {
        return Promise.resolve();
      },
      clear(): Promise<void> {
        return Promise.resolve();
      },
    };

    const { io, errLines } = makeFakeIo();

    const exitCode = await runLogout({
      io: io,
      store,
      env: { ALUY_IDENTITY_URL: 'http://localhost' },
    });

    expect(exitCode).toBe(1);
    expect(errLines.length).toBe(1);
    expect(errLines[0]).toBe(
      'erro: keychain do SO indisponível. A credencial não foi gravada — por segurança, ' +
        'ela nunca é guardada em texto em claro. No Linux, instale/ative o Secret ' +
        'Service (gnome-keyring/libsecret) e tente de novo.',
    );
  });
});
