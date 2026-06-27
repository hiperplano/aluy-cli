// EST-0942 — CHECK DE CREDENCIAL no boot (`isLoggedOut`): só PRESENÇA, sem rede.
//
// Sem credencial alguma (keychain vazio + sem ALUY_TOKEN) ⇒ o boot deve ORIENTAR
// `aluy login` em vez de deixar a 1ª chamada virar um "broker indisponível"
// genérico (o bug que enganou o Tiago). NÃO valida o token na rede (caro/lento) —
// só checa que ALGO foi fornecido; a validade vira erro específico na 1ª chamada.
//
// `login` é MOCKADO via um `whoami()` injetável (sem keychain real). O valor do
// ALUY_TOKEN nunca é lido/comparado — só a presença (CLI-SEC-6).

import { describe, expect, it } from 'vitest';
import { isLoggedOut } from '../../src/session/run.js';
import type { LoginService, RedactedCredential } from '@aluy/cli-core';

/** `login` fake: `whoami()` devolve `cred` (ou lança, p/ o caso de keychain ilegível). */
function fakeLogin(cred: RedactedCredential | null | (() => never)): Pick<LoginService, 'whoami'> {
  return {
    async whoami(): Promise<RedactedCredential | null> {
      if (typeof cred === 'function') return cred();
      return cred;
    },
  };
}

const REDACTED: RedactedCredential = {
  kind: 'pat',
  organization_id: 'org_abc',
  scopes: ['model.invoke'],
  expired: false,
  token_hint: 'pat_…',
};

describe('isLoggedOut — check de credencial no boot (EST-0942)', () => {
  it('keychain VAZIO + ALUY_TOKEN ausente ⇒ DESLOGADO (boot deve avisar)', async () => {
    const out = await isLoggedOut({ login: fakeLogin(null), env: {} });
    expect(out).toBe(true);
  });

  it('keychain VAZIO + ALUY_TOKEN vazio ("") ⇒ DESLOGADO', async () => {
    const out = await isLoggedOut({ login: fakeLogin(null), env: { ALUY_TOKEN: '   ' } });
    expect(out).toBe(true);
  });

  it('ALUY_TOKEN presente ⇒ LOGADO (nem chama whoami — env é credencial suficiente)', async () => {
    let called = false;
    const login: Pick<LoginService, 'whoami'> = {
      async whoami() {
        called = true;
        return null;
      },
    };
    const out = await isLoggedOut({ login, env: { ALUY_TOKEN: 'pat_x_y' } });
    expect(out).toBe(false);
    expect(called).toBe(false); // não precisa do keychain quando há env
  });

  it('credencial no keychain ⇒ LOGADO (sem ALUY_TOKEN)', async () => {
    const out = await isLoggedOut({ login: fakeLogin(REDACTED), env: {} });
    expect(out).toBe(false);
  });

  it('keychain ILEGÍVEL e sem ALUY_TOKEN ⇒ DESLOGADO (fail-safe: avisa)', async () => {
    const out = await isLoggedOut({
      login: fakeLogin(() => {
        throw new Error('keychain locked');
      }),
      env: {},
    });
    expect(out).toBe(true);
  });
});
