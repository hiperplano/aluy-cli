import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTelegram } from '../../src/commands/telegram.js';
import { UserConfigStore } from '../../src/io/user-config.js';
import type { TerminalIO } from '../../src/auth/io.js';
import type { ConnectorSecretStore } from '@hiperplano/aluy-cli-core';

/** IO fake: coleta out/err; prompt devolve um valor pré-programado. */
function fakeIO(promptAnswer = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: TerminalIO = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    prompt: async () => promptAnswer,
  };
  return { io, out, err };
}

/** Secret store fake em memória. */
function fakeSecret(initial: string | null = null): ConnectorSecretStore & { value: string | null } {
  let value = initial;
  return {
    get value() {
      return value;
    },
    async get() {
      return value;
    },
    async set(s: string) {
      value = s;
    },
    async clear() {
      value = null;
    },
  };
}

const TOKEN = '123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345';

describe('runTelegram (ADR-0134/0135 — gestão do conector)', () => {
  let base: string;
  let configStore: UserConfigStore;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-tg-'));
    mkdirSync(join(base, '.aluy'), { recursive: true });
    configStore = new UserConfigStore({ baseDir: join(base, '.aluy') });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('login --token válido ⇒ grava no keychain (redigido, sem vazar o auth)', async () => {
    const { io, out, err } = fakeIO();
    const secret = fakeSecret();
    const code = await runTelegram({ sub: 'login', token: TOKEN }, { io, secretStore: secret, configStore });
    expect(code).toBe(0);
    expect(secret.value).toBe(TOKEN);
    expect(err).toHaveLength(0);
    expect(out.join('\n')).toContain('123456789:'); // bot_id aparece
    expect(out.join('\n')).not.toContain('AAHk'); // auth NÃO vaza
  });

  it('login com token de forma inválida ⇒ NÃO grava, erro, exit 1', async () => {
    const { io, err } = fakeIO();
    const secret = fakeSecret();
    const code = await runTelegram({ sub: 'login', token: 'lixo' }, { io, secretStore: secret, configStore });
    expect(code).toBe(1);
    expect(secret.value).toBeNull();
    expect(err.join('\n')).toMatch(/inválida/i);
  });

  it('login sem --token ⇒ lê do prompt (secret)', async () => {
    const { io } = fakeIO(TOKEN);
    const secret = fakeSecret();
    const code = await runTelegram({ sub: 'login' }, { io, secretStore: secret, configStore, env: {} });
    expect(code).toBe(0);
    expect(secret.value).toBe(TOKEN);
  });

  it('login lê de ALUY_TELEGRAM_TOKEN quando sem --token', async () => {
    const { io } = fakeIO();
    const secret = fakeSecret();
    const code = await runTelegram(
      { sub: 'login' },
      { io, secretStore: secret, configStore, env: { ALUY_TELEGRAM_TOKEN: TOKEN } },
    );
    expect(code).toBe(0);
    expect(secret.value).toBe(TOKEN);
  });

  it('allow <chat-id> ⇒ adiciona à allowlist no config (dedup)', async () => {
    const { io, out } = fakeIO();
    await runTelegram({ sub: 'allow', chatId: 100 }, { io, configStore });
    await runTelegram({ sub: 'allow', chatId: 100 }, { io, configStore }); // dedup
    await runTelegram({ sub: 'allow', chatId: 200 }, { io, configStore });
    expect(configStore.load().connectors?.telegram?.allowlist).toEqual([100, 200]);
    expect(out.join('\n')).toContain('autorizado');
  });

  it('deny <chat-id> ⇒ remove da allowlist', async () => {
    const { io } = fakeIO();
    await runTelegram({ sub: 'allow', chatId: 100 }, { io, configStore });
    await runTelegram({ sub: 'deny', chatId: 100 }, { io, configStore });
    expect(configStore.load().connectors?.telegram?.allowlist).toEqual([]);
  });

  it('logout ⇒ limpa o token', async () => {
    const { io, out } = fakeIO();
    const secret = fakeSecret(TOKEN);
    const code = await runTelegram({ sub: 'logout' }, { io, secretStore: secret, configStore });
    expect(code).toBe(0);
    expect(secret.value).toBeNull();
    expect(out.join('\n')).toContain('removido');
  });

  it('status com token + allowlist ⇒ token (redigido) + allowlist + PRONTA (rode --telegram)', async () => {
    const { io, out } = fakeIO();
    const secret = fakeSecret(TOKEN);
    await runTelegram({ sub: 'allow', chatId: 555 }, { io, configStore });
    await runTelegram({ sub: 'status' }, { io, secretStore: secret, configStore });
    const text = out.join('\n');
    expect(text).toContain('presente');
    expect(text).toContain('555');
    expect(text).not.toContain('AAHk'); // não vaza o token
    // ADR-0134/0135 — com token+allowlist a bridge está PRONTA: o `aluy --telegram` a ativa.
    expect(text).toMatch(/pronta/i);
    expect(text).toContain('--telegram');
  });

  it('status com token mas allowlist VAZIA ⇒ avisa p/ autorizar antes de --telegram', async () => {
    const { io, out } = fakeIO();
    const secret = fakeSecret(TOKEN);
    await runTelegram({ sub: 'status' }, { io, secretStore: secret, configStore });
    const text = out.join('\n');
    expect(text).toContain('presente');
    expect(text).toMatch(/VAZIA/);
    expect(text).toMatch(/autorize/i);
  });

  it('status sem login ⇒ token ausente + allowlist vazia (bridge fechada)', async () => {
    const { io, out } = fakeIO();
    const secret = fakeSecret(null);
    await runTelegram({ sub: 'status' }, { io, secretStore: secret, configStore });
    const text = out.join('\n');
    expect(text).toMatch(/ausente/);
    expect(text).toMatch(/VAZIA/);
    // C6 — sem token a bridge é INERTE (não sobe, nem com --telegram).
    expect(text).toMatch(/INERTE|telegram login/i);
  });
});
