// Configuração de auth do CLI (lado cliente). Lê de env com defaults seguros.
// NADA de segredo aqui — só endpoints/ids públicos. A credencial vai ao keychain.

/** client_id público do CLI no device-flow (não é segredo). */
export const CLI_CLIENT_ID = 'aluy-cli';

export interface AuthConfig {
  /** Base URL do identity, ex. `https://api.aluy.app/api/v1`. */
  readonly identityBaseUrl: string;
  readonly clientId: string;
}

const DEFAULT_IDENTITY_BASE_URL = 'https://api.aluy.app/api/v1';

/**
 * Resolve a config a partir do ambiente. `ALUY_IDENTITY_URL` permite apontar
 * para dev/staging. Sem segredo: a credencial nunca vem de env persistida
 * (CLI-SEC-2) — só o PAT pode vir de env por sessão (ver login.ts).
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const base = (env.ALUY_IDENTITY_URL ?? DEFAULT_IDENTITY_BASE_URL).replace(/\/+$/, '');
  return { identityBaseUrl: base, clientId: CLI_CLIENT_ID };
}
