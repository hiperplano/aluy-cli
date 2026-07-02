// `aluy whoami` — mostra a credencial corrente REDIGIDA (sem o segredo) (CA-1).

import { LoginService, resolveBackend } from '@hiperplano/aluy-cli-core';
import { loadAuthConfig } from '../auth/config.js';
import { NoKeychainError, KeychainCredentialStore } from '../auth/keychain-store.js';
import { realTerminalIO, type TerminalIO } from '../auth/io.js';
import { UserConfigStore } from '../io/user-config.js';
import type { CredentialStore } from '@hiperplano/aluy-cli-core';

export interface WhoamiDeps {
  readonly io?: TerminalIO;
  readonly store?: CredentialStore;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runWhoami(deps: WhoamiDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const io = deps.io ?? realTerminalIO();
  const store = deps.store ?? new KeychainCredentialStore();

  // F183 — backend LOCAL (BYO): `whoami` é identidade de BROKER (device-flow/PAT), que
  // NÃO se aplica ao BYO — o modelo vem do provider com a chave do usuário, sem login
  // de broker. Antes reportava "não autenticado — rode aluy login" (exit 1), enganoso
  // (o usuário ESTÁ configurado, só não no broker). Agora: mensagem honesta + exit 0.
  // Espelha o F182 (doctor) e o `aluy models` (já backend-aware). Precedência real:
  // env ALUY_BACKEND > config > default.
  let configBackend: string | undefined;
  try {
    configBackend = new UserConfigStore().load().backend;
  } catch {
    /* sem config legível ⇒ cai no default */
  }
  if (resolveBackend({ env: env.ALUY_BACKEND, config: configBackend }) === 'local') {
    io.out('backend local (BYO) — sem identidade de broker (`whoami` é do broker).');
    io.out('a credencial é a chave do seu provider; veja `aluy models` / `aluy config`.');
    return 0;
  }
  const config = loadAuthConfig(env);
  const service = new LoginService({ ...config, baseUrl: config.identityBaseUrl, store });

  try {
    const cred = await service.whoami();
    if (!cred) {
      io.out('não autenticado — rode `aluy login`.');
      return 1;
    }
    // CA-1: whoami mostra user+org+escopos.
    // Device-flow: o `user` vem do claim `sub` do access JWT (decode display-only,
    //   sem verificar assinatura — a verificação é server-side; CLI-SEC-2 mantida:
    //   nunca imprimimos o JWT, só o identifier do `sub`).
    // PAT (limitação registrada — avisar specs): o user_id NÃO é conhecido
    //   localmente. Descobri-lo exigiria um introspect M2M no identity, que o CLI
    //   deliberadamente NÃO faz (CLI-SEC-7: binário público sem credencial M2M).
    //   Então mostramos "—" + dica de usar device-flow p/ ver o usuário.
    if (cred.user !== undefined) {
      io.out(`user:    ${cred.user}`);
    } else if (cred.kind === 'pat') {
      io.out('user:    — (PAT — use `aluy login` device pra ver o usuário)');
    } else {
      io.out('user:    —');
    }
    io.out(`org:     ${cred.organization_id}`);
    io.out(`escopos: ${cred.scopes.join(', ')}`);
    io.out(`tipo:    ${cred.kind === 'pat' ? 'PAT' : 'sessão device-flow'}`);
    if (cred.expires_at !== undefined) {
      // M-2: honestidade da validade. Quando `expired` (expires_at no passado), NÃO
      // dizemos "autenticado" — a 1ª chamada estouraria SessionExpiredError; avisamos
      // pra rodar `aluy login`. Senão mostramos a data de expiração. (PAT não chega
      // aqui — não tem expires_at; sua validade é server-side.)
      const when = new Date(cred.expires_at).toISOString();
      io.out(
        cred.expired ? `estado:  expirado (${when}) — rode \`aluy login\`` : `expira:  ${when}`,
      );
    }
    // NUNCA imprime access/refresh/pat — só o hint redigido.
    io.out(`token:   ${cred.token_hint} (redigido — o segredo vive só no keychain)`);
    return 0;
  } catch (err) {
    if (err instanceof NoKeychainError) {
      io.err(`erro: ${err.message}`);
      return 1;
    }
    io.err(`erro no whoami: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
