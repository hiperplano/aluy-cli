// CREDENCIAL-INTERMITENTE (dogfooding real) — o serviço 24/7 do dono morria com
//
//   sub-agente "macro" falhou: backend local: sem credencial apikey p/ "openrouter".
//   configure a chave: `OPENROUTER_API_KEY=...` (env) ou `aluy login --provider openrouter`
//
// com a chave PRESENTE no keychain o tempo todo — 73 caracteres, lida sem erro nenhum
// no MESMO ambiente do runner, segundos depois, pelo mesmo `@napi-rs/keyring`.
//
// Três defeitos empilhados, todos nesta unidade:
//
//   1. A credencial é resolvida a CADA requisição (por design, p/ pegar rotação de
//      chave sem reiniciar). Sem cache, UM blip do Secret Service derruba o turno
//      inteiro — e, num serviço, o turno inteiro é o expediente.
//   2. `readKeychain` engolia QUALQUER exceção e devolvia `undefined`: "não tem
//      entrada" e "não consegui ler" viravam a MESMA coisa.
//   3. Por causa de (2), a mensagem mandava "configure a chave" — conselho ERRADO
//      quando a chave já está lá. O dono reconfiguraria o que já estava certo, e o
//      sintoma voltaria no próximo blip.
//
// A rotação continua soberana: o cache só é CONSULTADO quando a leitura FALHA e não há
// env; qualquer leitura bem-sucedida o ATUALIZA.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  createLocalCredentialProvider,
  forgetCachedApiKey,
  MissingLocalCredentialError,
  type KeyringEntry,
} from '../../src/model/local/credential-resolver.js';

/** Entry de keychain controlável: valor corrente + erro programável na leitura. */
function entradaFake(estado: { valor?: string; erro?: Error }): {
  factory: (s: string, a: string) => KeyringEntry;
  leituras: () => number;
} {
  let leituras = 0;
  return {
    leituras: () => leituras,
    factory: () => ({
      getPassword(): string {
        leituras++;
        if (estado.erro) throw estado.erro;
        return estado.valor ?? '';
      },
      setPassword(): void {},
      deletePassword(): boolean {
        return true;
      },
    }),
  };
}

describe('credencial local — um blip do keychain NÃO derruba a sessão', () => {
  beforeEach(() => forgetCachedApiKey());

  it('keychain cai DEPOIS de ter funcionado ⇒ segue com a última credencial boa', async () => {
    // O caso do dono, exatamente: funciona, funciona, funciona… e some no meio do turno.
    const estado: { valor?: string; erro?: Error } = { valor: 'sk-real-123' };
    const { factory } = entradaFake(estado);
    const resolver = createLocalCredentialProvider({
      provider: 'openrouter',
      entryFactory: factory,
      env: {},
    });

    expect((await resolver()).secret).toBe('sk-real-123');

    estado.erro = new Error('Secret Service não respondeu (org.freedesktop.DBus.Error.NoReply)');
    const depois = await resolver();
    expect(depois.secret).toBe('sk-real-123'); // o serviço CONTINUA de pé.
    expect(depois.kind).toBe('apikey');
  });

  it('blip SEM nenhuma leitura boa antes ⇒ ERRO que aponta o keychain, não "configure a chave"', async () => {
    const { factory } = entradaFake({ erro: new Error('keyring is locked') });
    const resolver = createLocalCredentialProvider({
      provider: 'openrouter',
      entryFactory: factory,
      env: {},
    });
    await expect(resolver()).rejects.toThrow(MissingLocalCredentialError);
    await resolver().catch((e: Error) => {
      expect(e.message).toContain('keyring is locked'); // o motivo REAL.
      expect(e.message).toContain('Secret Service');
      expect(e.message).not.toContain('aluy login'); // conselho errado NÃO aparece.
    });
  });

  it('chave NUNCA configurada ⇒ mensagem de sempre ("configure a chave")', async () => {
    // Ausência legítima não pode virar "o keychain falhou": aqui o conselho está CERTO.
    const { factory } = entradaFake({ erro: new Error('No entry found in keyring') });
    const resolver = createLocalCredentialProvider({
      provider: 'openrouter',
      entryFactory: factory,
      env: {},
    });
    await resolver().catch((e: Error) => {
      expect(e.message).toContain('configure a chave');
      expect(e.message).toContain('aluy login --provider openrouter');
      expect(e.message).not.toContain('Secret Service');
    });
  });

  it('ROTAÇÃO continua soberana — chave nova no keychain entra na hora', async () => {
    const estado: { valor?: string; erro?: Error } = { valor: 'sk-velha' };
    const { factory } = entradaFake(estado);
    const resolver = createLocalCredentialProvider({
      provider: 'openrouter',
      entryFactory: factory,
      env: {},
    });
    expect((await resolver()).secret).toBe('sk-velha');
    estado.valor = 'sk-nova';
    expect((await resolver()).secret).toBe('sk-nova'); // cache NÃO congela a rotação.
  });

  it('o cache NÃO atropela o keychain vivo (só entra quando a leitura falha)', async () => {
    const estado: { valor?: string; erro?: Error } = { valor: 'sk-a' };
    const { factory, leituras } = entradaFake(estado);
    const resolver = createLocalCredentialProvider({
      provider: 'openrouter',
      entryFactory: factory,
      env: {},
    });
    await resolver();
    await resolver();
    await resolver();
    expect(leituras()).toBe(3); // continua consultando SEMPRE — nada virou cache-first.
  });

  it('env continua tendo precedência sobre o cache (CI/container sem Secret Service)', async () => {
    const estado: { valor?: string; erro?: Error } = { valor: 'sk-do-keychain' };
    const { factory } = entradaFake(estado);
    const resolver = createLocalCredentialProvider({
      provider: 'openrouter',
      entryFactory: factory,
      env: { OPENROUTER_API_KEY: 'sk-do-env' },
    });
    await resolver(); // memoriza a do keychain
    estado.erro = new Error('dbus caiu');
    expect((await resolver()).secret).toBe('sk-do-env');
  });

  it('esquecer a credencial (logout/revogação) volta a falhar — cache não é eterno', async () => {
    const estado: { valor?: string; erro?: Error } = { valor: 'sk-revogada' };
    const { factory } = entradaFake(estado);
    const resolver = createLocalCredentialProvider({
      provider: 'openrouter',
      entryFactory: factory,
      env: {},
    });
    await resolver();
    estado.erro = new Error('dbus caiu');
    expect((await resolver()).secret).toBe('sk-revogada');
    forgetCachedApiKey('openrouter');
    await expect(resolver()).rejects.toThrow(MissingLocalCredentialError);
  });

  it('o cache é POR PROVIDER — o blip de um não empresta a chave do outro', async () => {
    const estadoA: { valor?: string; erro?: Error } = { valor: 'sk-openrouter' };
    const rA = createLocalCredentialProvider({
      provider: 'openrouter',
      entryFactory: entradaFake(estadoA).factory,
      env: {},
    });
    await rA();
    const estadoB: { valor?: string; erro?: Error } = { erro: new Error('dbus caiu') };
    const rB = createLocalCredentialProvider({
      provider: 'anthropic',
      entryFactory: entradaFake(estadoB).factory,
      env: {},
    });
    await expect(rB()).rejects.toThrow(MissingLocalCredentialError);
  });
});
