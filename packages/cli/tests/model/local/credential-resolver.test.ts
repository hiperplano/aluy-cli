// ADR-0120 / EST-1113 — resolvedor de credencial BYO (keychain → cofre em arquivo → env).
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalCredentialProvider,
  storeApiKey,
  hasStoredApiKey,
  forgetCachedApiKey,
  MissingLocalCredentialError,
  type KeyringEntry,
} from '../../../src/model/local/credential-resolver.js';
import {
  writeFileVaultAccount,
  readFileVaultAccount,
  MachineIdUnavailableError,
  type FileVaultOptions,
} from '../../../src/model/local/file-vault.js';

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

// EMENDA à CLI-SEC-2 — cofre em arquivo cifrado como fallback do keychain (nunca
// requisito). tmpdir REAL sempre (nunca ~/.aluy real — mesma disciplina F167).
const tmpDirs: string[] = [];
function tmpFileVault(): FileVaultOptions {
  const dir = mkdtempSync(join(tmpdir(), 'aluy-credres-vault-'));
  tmpDirs.push(dir);
  return {
    vaultPath: join(dir, 'credentials.enc'),
    machineId: { reader: () => 'machine-de-teste-fixa' },
    username: 'tiago',
  };
}
afterEach(() => {
  forgetCachedApiKey(); // isola o cache anti-blip entre testes (módulo-global)
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('createLocalCredentialProvider — cofre em arquivo (keychain acelerador, nunca requisito)', () => {
  it('keychain AUSENTE, cofre em arquivo TEM a chave ⇒ usa o cofre em arquivo', async () => {
    const fileVault = tmpFileVault();
    writeFileVaultAccount('anthropic:apikey', 'sk-do-cofre', fileVault);
    const provider = createLocalCredentialProvider({
      provider: 'anthropic',
      entryFactory: fakeKeyring({}),
      env: {},
      fileVault,
    });
    expect(await provider()).toEqual({ kind: 'apikey', secret: 'sk-do-cofre' });
  });

  it('keychain PRESENTE ⇒ ganha do cofre em arquivo, mesmo que o arquivo tenha outro valor', async () => {
    const fileVault = tmpFileVault();
    writeFileVaultAccount('anthropic:apikey', 'sk-do-cofre-velho', fileVault);
    const provider = createLocalCredentialProvider({
      provider: 'anthropic',
      entryFactory: fakeKeyring({ 'anthropic:apikey': 'sk-do-keychain' }),
      env: {},
      fileVault,
    });
    // keychain é ACELERADOR: quando responde, ele é usado — nunca o arquivo.
    expect(await provider()).toEqual({ kind: 'apikey', secret: 'sk-do-keychain' });
  });

  it('keychain AUSENTE, cofre em arquivo TAMBÉM ausente, env presente ⇒ cai pra env (ordem: keychain → arquivo → env)', async () => {
    const fileVault = tmpFileVault(); // vaultPath nunca escrito
    const provider = createLocalCredentialProvider({
      provider: 'openrouter',
      entryFactory: fakeKeyring({}),
      env: { OPENROUTER_API_KEY: 'sk-or-env' },
      fileVault,
    });
    expect(await provider()).toEqual({ kind: 'apikey', secret: 'sk-or-env' });
  });

  it('keychain AUSENTE, cofre em arquivo E env presentes ⇒ o cofre em arquivo GANHA da env', async () => {
    const fileVault = tmpFileVault();
    writeFileVaultAccount('openrouter:apikey', 'sk-do-cofre', fileVault);
    const provider = createLocalCredentialProvider({
      provider: 'openrouter',
      entryFactory: fakeKeyring({}),
      env: { OPENROUTER_API_KEY: 'sk-or-env' },
      fileVault,
    });
    expect(await provider()).toEqual({ kind: 'apikey', secret: 'sk-do-cofre' });
  });

  it('cofre em arquivo de OUTRA MÁQUINA (keychain ausente, sem env) ⇒ MissingLocalCredentialError com hint honesto', async () => {
    const fileVault = tmpFileVault();
    writeFileVaultAccount('openai:apikey', 'sk-da-maquina-a', fileVault);
    const outraMaquina: FileVaultOptions = {
      ...fileVault,
      machineId: { reader: () => 'machine-COMPLETAMENTE-diferente' },
    };
    const provider = createLocalCredentialProvider({
      provider: 'openai',
      entryFactory: fakeKeyring({}),
      env: {},
      fileVault: outraMaquina,
    });
    await expect(provider()).rejects.toBeInstanceOf(MissingLocalCredentialError);
    await expect(provider()).rejects.toThrow(/cofre em arquivo/i);
  });

  it('nada em keychain/arquivo/env ⇒ MissingLocalCredentialError (nunca lança valor indefinido silencioso)', async () => {
    const fileVault = tmpFileVault();
    const provider = createLocalCredentialProvider({
      provider: 'openai',
      entryFactory: fakeKeyring({}),
      env: {},
      fileVault,
    });
    await expect(provider()).rejects.toBeInstanceOf(MissingLocalCredentialError);
  });
});

describe('storeApiKey — keychain acelerador, cofre em arquivo é o requisito de verdade', () => {
  it('keychain funciona e NÃO é volátil ⇒ backend "keychain", cofre em arquivo intocado', () => {
    const fileVault = tmpFileVault();
    const mem: Record<string, string> = {};
    const result = storeApiKey('anthropic', 'sk-x', {
      entryFactory: fakeKeyring(mem),
      fileVault,
      volatileProbe: { readProcKeys: () => '' }, // sem evidência de kernel-keyring ⇒ não-volátil
    });
    expect(result).toEqual({ backend: 'keychain' });
    expect(mem['anthropic:apikey']).toBe('sk-x');
    expect(existsSync(fileVault.vaultPath!)).toBe(false); // nada escrito no cofre em arquivo
  });

  it('keychain FALHA (sem backend) ⇒ backend "file-vault", a chave fica lá (round-trip)', () => {
    const fileVault = tmpFileVault();
    const deadKeyring = (): KeyringEntry => ({
      getPassword: () => {
        throw new Error('Platform secure storage failure: no keyring backend');
      },
      setPassword: () => {
        throw new Error('Platform secure storage failure: no keyring backend');
      },
      deletePassword: () => {
        throw new Error('Platform secure storage failure: no keyring backend');
      },
    });
    const result = storeApiKey('openrouter', 'sk-y', {
      entryFactory: deadKeyring,
      fileVault,
    });
    expect(result.backend).toBe('file-vault');
    expect(readFileVaultAccount('openrouter:apikey', fileVault).valor).toBe('sk-y');
  });

  it('keychain funciona MAS é volátil (kernel keyring) ⇒ backend "file-vault" + volatileKeychainBackedByFile, e o keychain TAMBÉM tem a cópia efêmera', () => {
    const fileVault = tmpFileVault();
    const mem: Record<string, string> = {};
    const result = storeApiKey('openai', 'sk-z', {
      entryFactory: fakeKeyring(mem),
      fileVault,
      volatileProbe: { readProcKeys: () => 'keyring:openai:apikey@aluy-cli-local' }, // simula evidência do kernel keyring
    });
    expect(result).toEqual({ backend: 'file-vault', volatileKeychainBackedByFile: true });
    expect(mem['openai:apikey']).toBe('sk-z'); // a cópia efêmera existe (bônus, não é a fonte de verdade)
    expect(readFileVaultAccount('openai:apikey', fileVault).valor).toBe('sk-z'); // a durável é o arquivo
  });

  it('keychain FALHA e machine-id ILEGÍVEL ⇒ lança (NUNCA grava em claro como consolo)', () => {
    const fileVault: FileVaultOptions = {
      ...tmpFileVault(),
      machineId: { reader: () => undefined },
    };
    const deadKeyring = (): KeyringEntry => ({
      getPassword: () => {
        throw new Error('no backend');
      },
      setPassword: () => {
        throw new Error('no backend');
      },
      deletePassword: () => {
        throw new Error('no backend');
      },
    });
    expect(() =>
      storeApiKey('anthropic', 'sk-w', { entryFactory: deadKeyring, fileVault }),
    ).toThrow(MachineIdUnavailableError);
  });
});

// ADR-0120 (retomada) — presença p/ o `/login` da sessão oferecer REUSAR em vez de
// reexigir a digitação (`decideLocalLogin` em `slash/handlers.ts`). NUNCA consulta
// env (não é "gravada" por nós) e NUNCA expõe o valor — só um booleano.
describe('hasStoredApiKey — só PRESENÇA (keychain OU cofre em arquivo), nunca env', () => {
  it('nada em lugar nenhum ⇒ false', () => {
    const fileVault = tmpFileVault();
    expect(hasStoredApiKey('anthropic', { entryFactory: fakeKeyring({}), fileVault })).toBe(false);
  });

  it('chave no keychain ⇒ true', () => {
    const fileVault = tmpFileVault();
    expect(
      hasStoredApiKey('anthropic', {
        entryFactory: fakeKeyring({ 'anthropic:apikey': 'sk-x' }),
        fileVault,
      }),
    ).toBe(true);
  });

  it('keychain ausente, chave só no cofre em arquivo ⇒ true', () => {
    const fileVault = tmpFileVault();
    writeFileVaultAccount('openrouter:apikey', 'sk-do-cofre', fileVault);
    expect(hasStoredApiKey('openrouter', { entryFactory: fakeKeyring({}), fileVault })).toBe(true);
  });

  it('só na ENV (nem keychain nem cofre) ⇒ false — env não é "gravada", não há o que reusar', () => {
    // env não entra nos args de hasStoredApiKey (ela não a consulta) — a ausência
    // de keychain/arquivo já basta pra provar que ela não conta como "existente" aqui.
    const fileVault = tmpFileVault();
    expect(hasStoredApiKey('openai', { entryFactory: fakeKeyring({}), fileVault })).toBe(false);
  });
});
