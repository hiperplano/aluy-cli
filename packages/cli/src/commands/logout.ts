// `aluy logout` — revoga no identity (device-flow) e APAGA do keychain (CA-5).
// Idempotente: sem credencial ⇒ informa e sai 0.

import { LoginService, type FetchLike } from '@aluy/cli-core';
import { loadAuthConfig } from '../auth/config.js';
import { NoKeychainError, KeychainCredentialStore } from '../auth/keychain-store.js';
import { realTerminalIO, type TerminalIO } from '../auth/io.js';
import type { CredentialStore } from '@aluy/cli-core';

export interface LogoutDeps {
  readonly io?: TerminalIO;
  readonly store?: CredentialStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: FetchLike;
}

export async function runLogout(deps: LogoutDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const io = deps.io ?? realTerminalIO();
  const store = deps.store ?? new KeychainCredentialStore();
  const config = loadAuthConfig(env);
  const service = new LoginService({
    ...config,
    baseUrl: config.identityBaseUrl,
    store,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  try {
    const before = await service.whoami();
    if (!before) {
      io.out('nenhuma credencial ativa — nada a fazer.');
      return 0;
    }
    const { revoked } = await service.logout();
    if (revoked) {
      io.out('✓ logout: credencial revogada no identity e apagada do keychain.');
    } else if (before.kind === 'pat') {
      io.out(
        '✓ logout: PAT apagado do keychain. (Revogue o PAT no painel web se quiser invalidá-lo.)',
      );
    } else {
      io.out(
        '✓ logout: credencial apagada do keychain. (Revogação no servidor não confirmada — possível offline.)',
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof NoKeychainError) {
      io.err(`erro: ${err.message}`);
      return 1;
    }
    io.err(`erro no logout: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
