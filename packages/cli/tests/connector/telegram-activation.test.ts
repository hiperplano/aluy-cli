// Ativação da bridge Telegram no BOOT (ADR-0134/0135) — prova C6 (DORMENTE até credencial):
// sem token, a bridge NÃO sobe e NENHUM client/egress é criado. Com token, sobe e a
// allowlist VAZIA é válida (fechada). Tudo com fakes (sem keychain/rede real).

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateTelegram } from '../../src/connector/telegram-activation.js';
import { UserConfigStore } from '../../src/io/user-config.js';
import type { IngressSink } from '../../src/connector/telegram-bridge.js';
import type { ConnectorSecretStore } from '@hiperplano/aluy-cli-core';

const TOKEN = '123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345';

const sink: IngressSink = { injectInstruction: () => {}, injectData: () => {} };

function store(token: string | null): ConnectorSecretStore {
  return {
    async get() {
      return token;
    },
    async set() {},
    async clear() {},
  };
}

function emptyConfig(): UserConfigStore {
  // baseDir tmp vazio ⇒ load() devolve {} ⇒ allowlist vazia (não toca o ~/.aluy real).
  return new UserConfigStore({ baseDir: mkdtempSync(join(tmpdir(), 'aluy-tg-')) });
}

describe('activateTelegram — C6 (dormente até credencial)', () => {
  it('SEM token no keychain ⇒ NÃO ativa (boot não falha) e o fetch NUNCA é tocado (zero egress)', async () => {
    let fetchCalled = false;
    const fetchFn = (async () => {
      fetchCalled = true;
      return {} as Response;
    }) as typeof fetch;

    const result = await activateTelegram({
      sink,
      secretStore: store(null), // sem token
      configStore: emptyConfig(),
      fetchFn,
    });

    expect(result.active).toBe(false);
    if (!result.active) {
      expect(result.reason).toMatch(/aluy telegram login/);
    }
    expect(fetchCalled).toBe(false); // NENHUM client foi construído ⇒ nada chamou a rede
  });

  it('keychain que LANÇA ⇒ trata como sem token (não ativa, não derruba o boot)', async () => {
    const exploding: ConnectorSecretStore = {
      async get() {
        throw new Error('keychain indisponível');
      },
      async set() {},
      async clear() {},
    };
    const result = await activateTelegram({
      sink,
      secretStore: exploding,
      configStore: emptyConfig(),
    });
    expect(result.active).toBe(false);
  });

  it('COM token ⇒ ativa; allowlist VAZIA é válida (bridge fechada, allowlistSize=0)', async () => {
    const result = await activateTelegram({
      sink,
      secretStore: store(TOKEN),
      configStore: emptyConfig(),
      // fetch fake só por garantia — não deve ser chamado na ativação (só no pump).
      fetchFn: (async () => ({ ok: true, json: async () => ({}) })) as never,
    });
    expect(result.active).toBe(true);
    if (result.active) {
      expect(result.allowlistSize).toBe(0); // fechada por default (C2)
      expect(result.bridge.currentTarget).toBeUndefined(); // nada travado ainda
      result.bridge.stop(); // não vaza o long-poll (nem foi iniciado aqui)
    }
  });

  it('a ativação NÃO inicia o long-poll por si — só constrói a bridge (o pump é do caller)', async () => {
    let fetchCalled = false;
    const result = await activateTelegram({
      sink,
      secretStore: store(TOKEN),
      configStore: emptyConfig(),
      fetchFn: (async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({ ok: true, result: [] }) } as never;
      }) as never,
    });
    expect(result.active).toBe(true);
    // Sem chamar bridge.pump(), nada de rede aconteceu (a ativação é pura composição).
    expect(fetchCalled).toBe(false);
    if (result.active) result.bridge.stop();
  });
});
