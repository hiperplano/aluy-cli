// EST-0940 (hunt login) — INTEGRAÇÃO no @aluy/cli: o `ALUY_TOKEN` do ambiente
// realmente AUTENTICA as chamadas ao broker quando o keychain está VAZIO (caminho
// headless/CI documentado: `export ALUY_TOKEN=…` SEM `aluy login`).
//
// O boot (`isLoggedOut`) já trata `ALUY_TOKEN` presente como "logado" e NÃO avisa,
// mas o `LoginService.getAccessToken` (que o BrokerModelClient usa por chamada) só
// lia o keychain ⇒ a 1ª chamada estourava `SessionExpiredError` ("sessão expirou —
// rode aluy login") — enganoso. `buildSession` agora injeta o env-PAT no
// LoginService; aqui provamos que `getAccessToken` o devolve.

import { describe, expect, it } from 'vitest';
import type { CredentialStore, StoredCredential } from '@aluy/cli-core';
import { buildSession } from '../../src/session/wiring.js';

const HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';
const ENV_PAT = `pat_${HEX}_envSecret`;

class EmptyStore implements CredentialStore {
  private cred: StoredCredential | null = null;
  async get(): Promise<StoredCredential | null> {
    return this.cred;
  }
  async set(c: StoredCredential): Promise<void> {
    this.cred = c;
  }
  async clear(): Promise<void> {
    this.cred = null;
  }
}

describe('buildSession — ALUY_TOKEN do env autentica o broker (EST-0940)', () => {
  it('keychain vazio + ALUY_TOKEN válido ⇒ login.getAccessToken devolve o PAT do env', async () => {
    const session = buildSession({
      env: { ALUY_TOKEN: ENV_PAT } as NodeJS.ProcessEnv,
      store: new EmptyStore(),
    });
    await expect(session.login.getAccessToken()).resolves.toBe(ENV_PAT);
  });

  it('keychain vazio + SEM ALUY_TOKEN ⇒ getAccessToken segue rejeitando (re-login)', async () => {
    const session = buildSession({
      env: {} as NodeJS.ProcessEnv,
      store: new EmptyStore(),
    });
    await expect(session.login.getAccessToken()).rejects.toThrow();
  });
});
