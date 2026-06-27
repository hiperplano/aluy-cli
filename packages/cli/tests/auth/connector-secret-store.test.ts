import { describe, expect, it } from 'vitest';
import {
  KeychainConnectorSecretStore,
} from '../../src/auth/connector-secret-store.js';
import { NoKeychainError, type KeychainEntry } from '../../src/auth/keychain-store.js';

/** Entry fake EM MEMÓRIA (keychain disponível). */
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

/** Entry que falha em tudo = backend ausente (CA-4). */
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

const TOKEN = '123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345';

function fakeStore(id = 'telegram') {
  FakeEntry.store.clear();
  return new KeychainConnectorSecretStore(id, {
    entryFactory: (s, a) => new FakeEntry(`${s}:${a}`),
  });
}

describe('KeychainConnectorSecretStore (backend disponível)', () => {
  it('get sem login ⇒ null', async () => {
    expect(await fakeStore().get()).toBeNull();
  });

  it('set→get round-trip do token', async () => {
    const store = fakeStore();
    await store.set(TOKEN);
    expect(await store.get()).toBe(TOKEN);
  });

  it('clear ⇒ get volta a null (logout)', async () => {
    const store = fakeStore();
    await store.set(TOKEN);
    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it('conta de keychain é por conector (telegram ≠ slack)', async () => {
    FakeEntry.store.clear();
    const tg = new KeychainConnectorSecretStore('telegram', {
      entryFactory: (s, a) => new FakeEntry(`${s}:${a}`),
    });
    const sl = new KeychainConnectorSecretStore('slack', {
      entryFactory: (s, a) => new FakeEntry(`${s}:${a}`),
    });
    await tg.set(TOKEN);
    expect(await sl.get()).toBeNull(); // não vaza entre conectores
    expect(await tg.get()).toBe(TOKEN);
  });
});

describe('KeychainConnectorSecretStore (backend AUSENTE — CA-4 / CLI-SEC-2)', () => {
  const deadStore = () =>
    new KeychainConnectorSecretStore('telegram', { entryFactory: () => new DeadEntry() });

  it('set ⇒ NoKeychainError (NUNCA grava em claro)', async () => {
    await expect(deadStore().set(TOKEN)).rejects.toBeInstanceOf(NoKeychainError);
  });

  it('get ⇒ null (não vaza detalhe do backend)', async () => {
    expect(await deadStore().get()).toBeNull();
  });

  it('clear ⇒ não lança (logout local concluído)', async () => {
    await expect(deadStore().clear()).resolves.toBeUndefined();
  });
});
