import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeychainConnectorSecretStore } from '../../src/auth/connector-secret-store.js';
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

/**
 * COFRE ISOLADO por arquivo — obrigatório desde que o store ganhou um SEGUNDO lugar de
 * gravação (arquivo cifrado). Sem `fileVault` injetado, o default é o cofre REAL do usuário
 * (`~/.aluy/credentials.enc`): estes testes rodaram assim e ESCREVERAM lá. As credenciais
 * sobreviveram (a gravação faz merge), mas teste que toca o cofre de quem roda a suíte é
 * acidente esperando acontecer — e o `get` passou a ler de lá, o que fez "sem login ⇒ null"
 * reprovar por encontrar o que outro teste tinha deixado.
 */
let cofreBase: string;
let cofreTeste: {
  vaultPath: string;
  machineId: { reader: () => string };
  username: string;
};
beforeEach(() => {
  cofreBase = mkdtempSync(join(tmpdir(), 'aluy-conn-'));
  cofreTeste = {
    vaultPath: join(cofreBase, 'credentials.enc'),
    machineId: { reader: () => 'maquina-de-teste' },
    username: 'teste',
  };
});
afterEach(() => {
  rmSync(cofreBase, { recursive: true, force: true });
});

function fakeStore(id = 'telegram') {
  FakeEntry.store.clear();
  return new KeychainConnectorSecretStore(id, {
    entryFactory: (s, a) => new FakeEntry(`${s}:${a}`),
    fileVault: cofreTeste,
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
    // `fileVault` OBRIGATÓRIO aqui: este caso era inofensivo enquanto `set` só escrevia no
    // keychain (dublê). Quando a emenda do CLI-SEC-2 passou a gravar TAMBÉM no cofre em
    // arquivo, o `tg.set(TOKEN)` abaixo começou a escrever em `~/.aluy/credentials.enc`
    // REAL — e sobrescreveu o token de Telegram do dono com o `123456789:…` de teste. Ele
    // levou uma ponte que "ativava" e morria em 401, calada. Achado por bissecção em 01/09.
    const tg = new KeychainConnectorSecretStore('telegram', {
      entryFactory: (s, a) => new FakeEntry(`${s}:${a}`),
      fileVault: cofreTeste,
    });
    const sl = new KeychainConnectorSecretStore('slack', {
      entryFactory: (s, a) => new FakeEntry(`${s}:${a}`),
      fileVault: cofreTeste,
    });
    await tg.set(TOKEN);
    expect(await sl.get()).toBeNull(); // não vaza entre conectores
    expect(await tg.get()).toBe(TOKEN);
  });
});

describe('KeychainConnectorSecretStore (backend AUSENTE — CA-4 / CLI-SEC-2)', () => {
  // COFRE ISOLADO, obrigatório desde que o store passou a ter um segundo lugar de
  // gravação. Sem isto o teste cai no cofre REAL (`~/.aluy/credentials.enc`) do usuário:
  // ele rodou assim uma vez e ESCREVEU lá. As credenciais sobreviveram (a gravação faz
  // merge), mas teste que toca o cofre do dono é acidente esperando acontecer.
  let base: string;
  let cofre: { vaultPath: string; machineId: { reader: () => string }; username: string };
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-conn-dead-'));
    cofre = {
      vaultPath: join(base, 'credentials.enc'),
      machineId: { reader: () => 'maquina-de-teste' },
      username: 'teste',
    };
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const deadStore = () =>
    new KeychainConnectorSecretStore('telegram', {
      entryFactory: () => new DeadEntry(),
      fileVault: cofre,
    });

  // O INVARIANTE ("nunca em claro") NÃO mudou — o que mudou foi onde o segredo pode ir
  // parar quando o keychain falta: agora existe o cofre em ARQUIVO CIFRADO, decisão do
  // dono depois de o token do bot evaporar de um keyring volátil. Então `set` com keychain
  // morto deixou de ser uma recusa: ele GRAVA, cifrado, e a sessão seguinte acha.
  it('set com keychain morto ⇒ grava no cofre CIFRADO (e não em claro)', async () => {
    await expect(deadStore().set(TOKEN)).resolves.toBeUndefined();
    expect(readFileSync(cofre.vaultPath, 'utf8')).not.toContain(TOKEN);
    expect(await deadStore().get()).toBe(TOKEN);
  });

  // A recusa continua existindo — só mudou a condição: ela vale quando NENHUM dos dois
  // lugares pode guardar. É esse o caso em que fingir sucesso seria mentira.
  it('keychain morto E sem machine-id ⇒ NoKeychainError (nada foi guardado)', async () => {
    const semMaquina = new KeychainConnectorSecretStore('telegram', {
      entryFactory: () => new DeadEntry(),
      fileVault: { ...cofre, machineId: { reader: () => undefined } },
    });
    await expect(semMaquina.set(TOKEN)).rejects.toBeInstanceOf(NoKeychainError);
  });

  it('get sem nada guardado ⇒ null (não vaza detalhe do backend)', async () => {
    expect(await deadStore().get()).toBeNull();
  });

  it('clear ⇒ não lança (logout local concluído)', async () => {
    await expect(deadStore().clear()).resolves.toBeUndefined();
  });
});
