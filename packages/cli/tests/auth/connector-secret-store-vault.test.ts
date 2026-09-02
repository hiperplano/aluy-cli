// COFRE DO CONECTOR — o token do bot sobrevive a um keyring VOLÁTIL.
//
// A história, porque ela justifica mudar uma decisão de segurança que era deliberada:
//
// O dono rodou `aluy telegram login`; o `/telegram status` confirmou "token: presente".
// Dias depois, a MESMA máquina dizia "token: ausente" — sem ele ter feito nada. Sem Secret
// Service, o keyring do kernel é MEMÓRIA: é exatamente o caso que já tinha criado a emenda
// do cofre em ARQUIVO CIFRADO para a credencial BYO. Só que aquela emenda foi escrita com
// escopo LOCAL, e este arquivo dizia, em letras: "token de conector continua nas regras
// acima, sem exceção". Era decisão, não descuido.
//
// O dogfooding mostrou que a RAZÃO da emenda vale idêntica aqui, e o custo do escopo era
// alto: a ponte recusava por falta de token, o motivo ia para um stderr que a TUI apaga, e
// o `/telegram status` negava o recurso. Três sinais errados seguidos — o dono concluiu que
// o conector não existia, quando ele funciona (verificado ponta a ponta contra a API real).
//
// O QUE NÃO MUDA: nada em claro. AES-256-GCM com chave derivada do machine-id + usuário,
// que não viaja junto — o arquivo copiado é um blob inútil.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeychainConnectorSecretStore } from '../../src/auth/connector-secret-store.js';
import { NoKeychainError } from '../../src/auth/keychain-store.js';

let base: string;
let vaultPath: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aluy-conn-vault-'));
  vaultPath = join(base, 'credentials.enc');
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

// `machineId` recebe um READER, não um `id`. A primeira versão destes testes passou
// `{ id: ... }` — forma que o `readMachineId` ignora —, então eles rodaram com o machine-id
// REAL da máquina e passaram por acidente, sem exercitar o dublê. O caso da recusa foi o
// único que denunciou, porque ele depende do dublê para existir.
const COFRE = () => ({
  vaultPath,
  machineId: { reader: () => 'maquina-de-teste' },
  username: 'tiago',
});

/** Keychain que FUNCIONA (guarda em memória). */
function keychainVivo(mem: Record<string, string> = {}) {
  return {
    entryFactory: (_s: string, a: string) => ({
      getPassword: () => {
        const v = mem[a];
        if (v === undefined) throw new Error('No matching entry found in secure storage');
        return v;
      },
      setPassword: (v: string) => {
        mem[a] = v;
      },
      deletePassword: () => {
        if (mem[a] === undefined) throw new Error('No matching entry found');
        delete mem[a];
      },
    }),
    mem,
  };
}

/** Keychain VOLÁTIL: aceitou a escrita e depois perdeu tudo (o caso do dono). */
function keychainQueEsquece(mem: Record<string, string>) {
  return {
    entryFactory: (_s: string, a: string) => ({
      getPassword: () => {
        throw new Error('KeyRevoked: key has been revoked');
      },
      setPassword: (v: string) => {
        mem[a] = v;
      },
      deletePassword: () => {
        delete mem[a];
      },
    }),
  };
}

/** Keychain AUSENTE: nem escrever dá. */
const keychainAusente = {
  entryFactory: () => ({
    getPassword: () => {
      throw new Error('no backend available');
    },
    setPassword: () => {
      throw new Error('no backend available');
    },
    deletePassword: () => {
      throw new Error('no backend available');
    },
  }),
};

describe('o token do bot SOBREVIVE ao keyring que esquece', () => {
  it('O CASO DO DONO: grava com o keychain vivo, e o `get` acha mesmo quando ele perde a chave', async () => {
    const kc = keychainVivo();
    const gravador = new KeychainConnectorSecretStore('telegram', { ...kc, fileVault: COFRE() });
    await gravador.set('000000000:TOKEN-DE-TESTE');

    // Passa o tempo: o keyring do kernel perde a chave (KeyRevoked).
    const depois = new KeychainConnectorSecretStore('telegram', {
      ...keychainQueEsquece({}),
      fileVault: COFRE(),
    });
    expect(
      await depois.get(),
      'o token evaporou — é o defeito que fazia a ponte recusar em silêncio',
    ).toBe('000000000:TOKEN-DE-TESTE');
  });

  it('keychain AUSENTE: grava mesmo assim (no arquivo) e lê de volta', async () => {
    const store = new KeychainConnectorSecretStore('telegram', {
      ...keychainAusente,
      fileVault: COFRE(),
    });
    await store.set('tok-abc');
    expect(await store.get()).toBe('tok-abc');
  });

  it('NADA em claro: o arquivo do cofre não contém o token legível', async () => {
    const store = new KeychainConnectorSecretStore('telegram', {
      ...keychainVivo(),
      fileVault: COFRE(),
    });
    await store.set('SEGREDO-QUE-NAO-PODE-VAZAR');
    expect(existsSync(vaultPath)).toBe(true);
    expect(readFileSync(vaultPath, 'utf8')).not.toContain('SEGREDO-QUE-NAO-PODE-VAZAR');
  });

  it('sem login ⇒ null (ausência não é erro)', async () => {
    const store = new KeychainConnectorSecretStore('telegram', {
      ...keychainVivo(),
      fileVault: COFRE(),
    });
    expect(await store.get()).toBeNull();
  });

  // Ao fazer o `set` gravar nos dois, um `clear` que só limpasse o keychain deixaria o
  // token no arquivo: eu estaria abrindo um furo ao fechar outro.
  it('LOGOUT apaga dos DOIS — não sobra token no arquivo', async () => {
    const kc = keychainVivo();
    const store = new KeychainConnectorSecretStore('telegram', { ...kc, fileVault: COFRE() });
    await store.set('tok-para-apagar');
    await store.clear();

    expect(await store.get()).toBeNull();
    // e mesmo com o keychain fora do caminho, o arquivo não guarda mais nada
    const soArquivo = new KeychainConnectorSecretStore('telegram', {
      ...keychainQueEsquece({}),
      fileVault: COFRE(),
    });
    expect(await soArquivo.get(), 'o logout deixou o token no cofre em arquivo').toBeNull();
  });

  it('keychain ausente E sem machine-id ⇒ RECUSA (nunca finge que guardou)', async () => {
    const store = new KeychainConnectorSecretStore('telegram', {
      ...keychainAusente,
      fileVault: { vaultPath, machineId: { reader: () => undefined }, username: 'tiago' },
    });
    await expect(store.set('tok')).rejects.toBeInstanceOf(NoKeychainError);
  });
});
