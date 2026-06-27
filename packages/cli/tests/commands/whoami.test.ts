// Testes de `aluy whoami` — runWhoami({ io?, store?, env? }).
// Cobre 2 ramos descobertos: device-sem-user (linhas 41-42) e NoKeychainError
// (linhas 58-60). EST-1013.

import { describe, expect, it } from 'vitest';
import { runWhoami } from '../../src/commands/whoami.js';
import { NoKeychainError } from '../../src/auth/keychain-store.js';
import type { CredentialStore, StoredCredential } from '@hiperplano/aluy-cli-core';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Fake IO que acumula as linhas de saída. */
function makeFakeIo(): {
  outLines: string[];
  errLines: string[];
  io: { out: (s: string) => void; err: (s: string) => void };
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    io: {
      out(s: string) {
        outLines.push(s);
      },
      err(s: string) {
        errLines.push(s);
      },
    },
  };
}

/** Cria um fake CredentialStore com comportamento controlado. */
function makeFakeStore(resolveWith: StoredCredential | null | 'reject'): CredentialStore {
  return {
    get(): Promise<StoredCredential | null> {
      if (resolveWith === 'reject') {
        return Promise.reject(new NoKeychainError('keychain do SO indisponível'));
      }
      return Promise.resolve(resolveWith);
    },
    set(): Promise<void> {
      return Promise.resolve();
    },
    clear(): Promise<void> {
      return Promise.resolve();
    },
  };
}

describe('runWhoami', () => {
  // -----------------------------------------------------------------------
  // (A) LINHA 41-42 — device SEM user (access_token não é JWT com sub)
  // -----------------------------------------------------------------------
  it('retorna 0 e mostra "user:    —" para device sem JWT com sub (linhas 41-42)', async () => {
    const cred: StoredCredential = {
      kind: 'device',
      access_token: 'nao-e-jwt',
      refresh_token: 'refresh-fake',
      organization_id: 'org-1',
      scopes: ['assistant:session'],
      expires_at: Date.now() + 3600_000,
      v: 1,
    };
    const { io, outLines, errLines } = makeFakeIo();
    const store = makeFakeStore(cred);

    const exitCode = await runWhoami({ io, store, env: {} });

    expect(exitCode).toBe(0);
    expect(outLines[0]).toBe('user:    —');
    // Confirma que NENHUMA linha contém o access_token cru (CLI-SEC-2).
    for (const line of outLines) {
      expect(line).not.toContain('nao-e-jwt');
    }
    for (const line of errLines) {
      expect(line).not.toContain('nao-e-jwt');
    }
  });

  // -----------------------------------------------------------------------
  // (M-2) HONESTIDADE: device EXPIRADO sem refresh viável NÃO pode aparecer
  // como autenticado. O `expires_at` está no passado ⇒ a 1ª chamada estouraria
  // SessionExpiredError; o whoami deve dizer "expirado — rode aluy login".
  // -----------------------------------------------------------------------
  it('device com expires_at no passado ⇒ mostra "expirado — rode aluy login" (M-2)', async () => {
    const cred: StoredCredential = {
      kind: 'device',
      access_token: 'nao-e-jwt',
      // Sem refresh_token: getAccessToken estouraria SessionExpiredError direto.
      organization_id: 'org-1',
      scopes: ['assistant:session'],
      expires_at: Date.now() - 60_000, // já expirou há 1 min
      v: 1,
    };
    const { io, outLines } = makeFakeIo();
    const store = makeFakeStore(cred);

    const exitCode = await runWhoami({ io, store, env: {} });

    expect(exitCode).toBe(0);
    const joined = outLines.join('\n');
    // Estado HONESTO: sinaliza expirado + ação acionável.
    expect(joined).toContain('expirado');
    expect(joined).toContain('aluy login');
    // E NÃO pode imprimir a linha enganosa "expira:  <data>" (que sugere ativo).
    expect(outLines.some((l) => l.startsWith('expira:'))).toBe(false);
  });

  // -----------------------------------------------------------------------
  // (B) LINHAS 58-60 — NoKeychainError no store.load()
  // -----------------------------------------------------------------------
  it('retorna 1 e imprime o erro quando store.load() rejeita com NoKeychainError (linhas 58-60)', async () => {
    const { io, errLines } = makeFakeIo();
    const store = makeFakeStore('reject');

    const exitCode = await runWhoami({ io, store, env: {} });

    expect(exitCode).toBe(1);
    expect(errLines.length).toBe(1);
    expect(errLines[0]).toBe(
      'erro: keychain do SO indisponível. A credencial não foi gravada — por segurança, ela nunca é guardada em texto em claro. No Linux, instale/ative o Secret Service (gnome-keyring/libsecret) e tente de novo.',
    );
  });
});
