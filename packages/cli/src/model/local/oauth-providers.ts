// ADR-0120 / EST-1114 — CATÁLOGO de config OAuth por provider (endpoints/client_id).
//
// Estes são PARÂMETROS PÚBLICOS de OAuth (authorize/token URL, client_id público,
// scopes, redirect loopback) — NÃO segredos (CLI-SEC-7: nada de client_secret aqui;
// o fluxo é PKCE puro, sem segredo do cliente). O `client_id` da via de ASSINATURA
// de cada provider NÃO é um valor estável/publicado universalmente; por isso é
// OVERRIDÁVEL por env (`ALUY_OAUTH_<PROVIDER>_CLIENT_ID` etc.) e o catálogo embutido
// traz defaults DOCUMENTADOS — o usuário/dono os confirma no login.
//
// ⚠ AVISO DE ToS (ADR-0120): usar a via OAuth de ASSINATURA (Claude Pro/Max,
// ChatGPT) num cliente NÃO-oficial é zona cinzenta dos Termos do provider. É uma
// opção consciente do usuário; a via API key (paga-por-uso) não tem essa ressalva.

import type { OAuthProviderConfig, LocalProviderKind } from '@aluy/cli-core';

/** Porta de loopback default p/ o redirect do PKCE (o locus sobe um server aqui). */
export const DEFAULT_LOOPBACK_PORT = 49_876;
export const DEFAULT_REDIRECT_URI = `http://127.0.0.1:${DEFAULT_LOOPBACK_PORT}/callback`;

/**
 * Defaults DOCUMENTADOS por provider. `clientId` vazio ⇒ o usuário DEVE prover via
 * `ALUY_OAUTH_<P>_CLIENT_ID` (o login recusa com erro claro se faltar). Mantemos a
 * forma pronta p/ o dono preencher quando confirmar os valores oficiais da via de
 * assinatura — em vez de embutir um id adivinhado (que falharia silenciosamente).
 */
const DEFAULTS: Partial<Record<LocalProviderKind, OAuthProviderConfig>> = {
  anthropic: {
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
    clientId: '', // ⇒ ALUY_OAUTH_ANTHROPIC_CLIENT_ID (confirmar valor oficial)
    redirectUri: DEFAULT_REDIRECT_URI,
    scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
  },
  openai: {
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: '', // ⇒ ALUY_OAUTH_OPENAI_CLIENT_ID (confirmar valor oficial)
    redirectUri: DEFAULT_REDIRECT_URI,
    scopes: ['openid', 'profile', 'offline_access'],
  },
  // openrouter: a via canônica é API key; OAuth de assinatura não se aplica.
};

const ENV_CLIENT_ID: Record<LocalProviderKind, string> = {
  anthropic: 'ALUY_OAUTH_ANTHROPIC_CLIENT_ID',
  openai: 'ALUY_OAUTH_OPENAI_CLIENT_ID',
  openrouter: 'ALUY_OAUTH_OPENROUTER_CLIENT_ID',
};

/**
 * Resolve a config OAuth efetiva de um provider: o default do catálogo + override
 * do `client_id`/`redirect_uri` por env. Lança se o provider não tem via OAuth ou
 * se o `client_id` não foi configurado (erro acionável).
 */
export function resolveOAuthProviderConfig(
  provider: LocalProviderKind,
  env: NodeJS.ProcessEnv = process.env,
): OAuthProviderConfig {
  const base = DEFAULTS[provider];
  if (base === undefined) {
    throw new Error(
      `backend local: provider "${provider}" não tem via OAuth (use --provider com API key).`,
    );
  }
  const clientId = (env[ENV_CLIENT_ID[provider]] ?? base.clientId).trim();
  if (clientId === '') {
    throw new Error(
      `backend local: OAuth de "${provider}" exige um client_id — defina ${ENV_CLIENT_ID[provider]}.`,
    );
  }
  const redirectUri = (env.ALUY_OAUTH_REDIRECT_URI ?? base.redirectUri).trim();
  return { ...base, clientId, redirectUri };
}

/**
 * Catálogo embutido (defaults) — exposto p/ o `OAuthTokenStore` (refresh) que só
 * precisa do `tokenUrl`/`clientId`. Resolve com env p/ o `client_id`.
 */
export const OAUTH_PROVIDERS: Partial<Record<LocalProviderKind, OAuthProviderConfig>> = new Proxy(
  DEFAULTS,
  {
    get(target, prop: string): OAuthProviderConfig | undefined {
      const key = prop as LocalProviderKind;
      if (target[key] === undefined) return undefined;
      try {
        return resolveOAuthProviderConfig(key);
      } catch {
        // refresh sem client_id configurado ⇒ devolve o default (o refresh falhará
        // com erro claro do token endpoint; o login interativo é quem valida cedo).
        return target[key];
      }
    },
  },
);
