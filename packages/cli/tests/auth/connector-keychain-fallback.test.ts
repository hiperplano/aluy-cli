// O FALLBACK PARA O COFRE não pode morrer quando o keychain diz "não tenho".
//
// O defeito (dono, 01/09): `/telegram status` dizia `token: ausente` com o token são e
// salvo em `~/.aluy/credentials.enc`. A emenda do CLI-SEC-2 fez o `set` gravar nos DOIS
// lugares (keychain como acelerador, arquivo cifrado como persistência), mas o `get`
// guardava assim:
//
//     const raw = this.entry().getPassword();
//     if (raw !== '') return raw;          // ← null !== '' é VERDADEIRO
//
// Uma entrada AUSENTE devolve `null` (keytar e afins) ou `undefined`. Os dois passam
// nesse guarda, então o `get` retornava o próprio `null` ali e o cofre em arquivo NUNCA
// era consultado. Gravávamos nos dois e líamos de nenhum.
//
// Por que a suíte não pegou: o único valor que CAÍA para o cofre era `''` — e era
// exatamente o que os dublês devolviam. O teste exercitava o único caminho que
// funcionava. Por isso os casos `null` e `undefined` abaixo são o coração deste arquivo.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeychainConnectorSecretStore } from '../../src/auth/connector-secret-store.js';

let dir: string;
let vault: { vaultPath: string; machineId: { reader: () => string }; username: string };

beforeEach(() => {
  // Cofre TEMPORÁRIO + machine-id DUBLÊ: esta suíte nunca toca o `~/.aluy` real de quem
  // roda. Já houve dano aqui — testes gravaram um token de mentira no cofre do dono.
  dir = mkdtempSync(join(tmpdir(), 'aluy-conn-fallback-'));
  vault = {
    vaultPath: join(dir, 'credentials.enc'),
    machineId: { reader: () => 'maquina-de-teste-fixa' },
    username: 'usuario-de-teste',
  };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Store com um keychain dublê que devolve `valor` e nunca persiste nada. */
function comKeychain(valor: unknown): KeychainConnectorSecretStore {
  return new KeychainConnectorSecretStore('telegram', {
    fileVault: vault,
    entryFactory: () => ({
      getPassword: () => valor,
      setPassword: () => {},
      deletePassword: () => {},
    }),
  } as never);
}

/** Store cujo keychain LANÇA (máquina sem Secret Service). */
function semKeychain(): KeychainConnectorSecretStore {
  return new KeychainConnectorSecretStore('telegram', {
    fileVault: vault,
    entryFactory: () => {
      throw new Error('sem backend de keychain');
    },
  } as never);
}

const TOKEN = '000000000:TOKEN-FALSO-DE-TESTE-NAO-USE-EM-LUGAR-NENHUM';

describe('get() — o keychain sem a entrada NÃO pode esconder o cofre', () => {
  it('keychain devolve `null` ⇒ acha no cofre (o defeito literal)', async () => {
    await semKeychain().set(TOKEN); // grava no cofre em arquivo
    expect(await comKeychain(null).get()).toBe(TOKEN);
  });

  it('keychain devolve `undefined` ⇒ acha no cofre', async () => {
    await semKeychain().set(TOKEN);
    expect(await comKeychain(undefined).get()).toBe(TOKEN);
  });

  it('keychain devolve string vazia ⇒ acha no cofre (já funcionava; não regride)', async () => {
    await semKeychain().set(TOKEN);
    expect(await comKeychain('').get()).toBe(TOKEN);
  });

  it('keychain LANÇA ⇒ acha no cofre (máquina sem Secret Service)', async () => {
    await semKeychain().set(TOKEN);
    expect(await semKeychain().get()).toBe(TOKEN);
  });

  it('keychain COM token vence o cofre — ele é o acelerador', async () => {
    await semKeychain().set(TOKEN);
    expect(await comKeychain('999:DO-KEYCHAIN').get()).toBe('999:DO-KEYCHAIN');
  });

  it('sem token em lugar nenhum ⇒ null de verdade (sem alarme falso)', async () => {
    expect(await comKeychain(null).get()).toBeNull();
  });

  it('valor NÃO-string do keychain não vaza para o chamador', async () => {
    // Um backend exótico devolvendo objeto/número não pode virar "token".
    await semKeychain().set(TOKEN);
    for (const lixo of [42, {}, [], true]) {
      expect(await comKeychain(lixo).get(), `lixo: ${JSON.stringify(lixo)}`).toBe(TOKEN);
    }
  });
});

describe('a persistência que motivou a emenda', () => {
  it('gravado sem keychain, lido sem keychain — sobrevive ao keyring volátil', async () => {
    await semKeychain().set(TOKEN);
    // Instância NOVA: nada em memória, só o arquivo cifrado.
    expect(await semKeychain().get()).toBe(TOKEN);
  });

  it('o cofre não guarda o token em CLARO', async () => {
    await semKeychain().set(TOKEN);
    const cru = readFileSync(vault.vaultPath, 'utf8');
    expect(cru).not.toContain(TOKEN);
    expect(cru).not.toContain('000000000');
  });
});

import { readFileSync } from 'node:fs';
