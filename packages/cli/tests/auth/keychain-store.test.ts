import { describe, expect, it } from 'vitest';
import {
  KeychainCredentialStore,
  NoKeychainError,
  type KeychainEntry,
} from '../../src/auth/keychain-store.js';
import type { StoredCredential } from '@aluy/cli-core';

const CRED: StoredCredential = {
  kind: 'pat',
  pat: 'pat_deadbeefdeadbeefdeadbeefdeadbeef_secret',
  organization_id: 'org-1',
  scopes: ['llm:call'],
  v: 1,
};

/** Entry fake EM MEMÓRIA (simula o keychain do SO disponível). */
class FakeEntry implements KeychainEntry {
  static store = new Map<string, string>();
  constructor(private readonly key: string) {}
  getPassword(): string {
    const v = FakeEntry.store.get(this.key);
    if (v === undefined) throw new Error('No matching entry found in secure storage');
    return v;
  }
  setPassword(password: string): void {
    FakeEntry.store.set(this.key, password);
  }
  deletePassword(): boolean {
    return FakeEntry.store.delete(this.key);
  }
}

/** Entry que falha em TODA operação = backend ausente (CA-4). */
class DeadEntry implements KeychainEntry {
  getPassword(): string {
    throw new Error('Platform secure storage failure: no keyring backend');
  }
  setPassword(): void {
    throw new Error('Platform secure storage failure: no keyring backend');
  }
  deletePassword(): boolean {
    throw new Error('Platform secure storage failure: no keyring backend');
  }
}

function fakeStore() {
  FakeEntry.store.clear();
  return new KeychainCredentialStore({
    entryFactory: (s, a) => new FakeEntry(`${s}:${a}`),
  });
}

describe('KeychainCredentialStore (backend disponível)', () => {
  it('set→get round-trip', async () => {
    const store = fakeStore();
    expect(await store.get()).toBeNull(); // sem login
    await store.set(CRED);
    expect(await store.get()).toEqual(CRED);
  });

  it('clear apaga (logout idempotente)', async () => {
    const store = fakeStore();
    await store.set(CRED);
    await store.clear();
    expect(await store.get()).toBeNull();
    // clear de novo não lança.
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('get sem credencial ⇒ null (não lança)', async () => {
    const store = fakeStore();
    expect(await store.get()).toBeNull();
  });
});

describe('KeychainCredentialStore — SEM keychain (CA-4)', () => {
  const dead = new KeychainCredentialStore({ entryFactory: () => new DeadEntry() });

  it('set sem backend ⇒ NoKeychainError (NÃO grava em claro)', async () => {
    await expect(dead.set(CRED)).rejects.toBeInstanceOf(NoKeychainError);
  });

  it('a mensagem AVISA e cita CLI-SEC-2', async () => {
    try {
      await dead.set(CRED);
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(NoKeychainError);
      expect((err as Error).message).toContain('texto em claro');
      expect((err as Error).message).toContain('não foi gravada');
    }
  });

  it('get sem backend ⇒ null (sem vazar detalhe; nunca grava)', async () => {
    expect(await dead.get()).toBeNull();
  });

  it('clear sem backend ⇒ no-op (logout local concluído)', async () => {
    await expect(dead.clear()).resolves.toBeUndefined();
  });
});
