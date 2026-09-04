// ADR-0154 — `/telegram` (setup do conector DENTRO da sessão): status/allow/deny/
// logout/login. PURO de Ink (deps injetadas): config num tmpdir, secret-store fake.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTelegramSlash } from '../../src/slash/handlers.js';
import { UserConfigStore } from '../../src/io/user-config.js';
import type { ConnectorSecretStore } from '@hiperplano/aluy-cli-core';

const TOKEN = '123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345';

function fakeSecret(
  initial: string | null = null,
): ConnectorSecretStore & { value: string | null } {
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

describe('runTelegramSlash (/telegram na sessão)', () => {
  let base: string;
  let configStore: UserConfigStore;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-tgslash-'));
    mkdirSync(join(base, '.aluy'), { recursive: true });
    configStore = new UserConfigStore({ baseDir: join(base, '.aluy') });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('status (sem args) ⇒ token ausente + allowlist vazia + estado inerte', async () => {
    const note = await runTelegramSlash('', { configStore, secretStore: fakeSecret(null) });
    const text = note.lines.join('\n');
    expect(note.title).toBe('telegram');
    expect(text).toMatch(/ausente/);
    expect(text).toMatch(/VAZIA/);
    // O VOCABULÁRIO mudou em 01/09 e a intenção NÃO: antes a linha de estado era CRAVADA
    // ("a bridge ainda NÃO está ativa (ativação sob revisão de segurança)") e mentia nos
    // dois sentidos — dizia "não ativa" mesmo com a ponte no ar. O `bridgeAtiva` era
    // recebido do run.tsx e nunca lido; como é propriedade de interface, o `noUnusedLocals`
    // não reclamou e a meia-correção passou pelo build. Agora o estado é COMPUTADO, e sem
    // token a frase é "ponte parada (sem token não há o que iniciar)".
    // O que este caso protege segue igual: sem token, o status NÃO pode dizer que está no ar.
    expect(text).toMatch(/não.*ativa|inert|parada/i);
    expect(text).not.toMatch(/ponte ATIVA/);
  });

  it('status COM token ⇒ redige (mostra bot_id, esconde o auth)', async () => {
    const note = await runTelegramSlash('status', { configStore, secretStore: fakeSecret(TOKEN) });
    const text = note.lines.join('\n');
    expect(text).toContain('123456789:');
    expect(text).not.toContain('AAHk');
  });

  it('allow <id> ⇒ persiste no config; status reflete', async () => {
    await runTelegramSlash('allow 555', { configStore, secretStore: fakeSecret() });
    expect(configStore.load().connectors?.telegram?.allowlist).toEqual([555]);
    const note = await runTelegramSlash('status', { configStore, secretStore: fakeSecret() });
    expect(note.lines.join('\n')).toContain('555');
  });

  it('deny <id> ⇒ remove do config', async () => {
    await runTelegramSlash('allow 555', { configStore, secretStore: fakeSecret() });
    await runTelegramSlash('deny 555', { configStore, secretStore: fakeSecret() });
    expect(configStore.load().connectors?.telegram?.allowlist).toEqual([]);
  });

  it('allow sem id ⇒ nota de uso (não quebra)', async () => {
    const note = await runTelegramSlash('allow', { configStore, secretStore: fakeSecret() });
    expect(note.lines.join('\n')).toMatch(/uso:/);
  });

  it('logout ⇒ limpa o token', async () => {
    const secret = fakeSecret(TOKEN);
    await runTelegramSlash('logout', { configStore, secretStore: secret });
    expect(secret.value).toBeNull();
  });

  it('login ⇒ aponta p/ o terminal (token sensível, nunca digitado na TUI)', async () => {
    const note = await runTelegramSlash('login', { configStore, secretStore: fakeSecret() });
    expect(note.lines.join('\n')).toMatch(/aluy telegram login/);
  });

  it('subcomando desconhecido ⇒ nota de uso', async () => {
    const note = await runTelegramSlash('xyz', { configStore, secretStore: fakeSecret() });
    expect(note.lines.join('\n')).toMatch(/uso:/);
  });

  it('preserva outras prefs do config (não clobbera)', async () => {
    configStore.save({ tier: 'fast' });
    await runTelegramSlash('allow 7', { configStore, secretStore: fakeSecret() });
    expect(configStore.load().tier).toBe('fast');
  });
});
