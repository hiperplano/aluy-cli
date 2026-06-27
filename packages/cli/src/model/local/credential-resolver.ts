// ADR-0120 / EST-1113 — resolvedor de CREDENCIAL BYO do backend local (I/O concreto).
//
// Resolve a credencial de um provider local (API key OU access token OAuth) por
// provider, na ordem **keychain → env**. PORTÁVEL? Não: toca o keychain do SO (dep
// nativa) e `process.env` ⇒ mora no `@hiperplano/aluy-cli` (ADR-0053 §8). O core só recebe a
// `CredentialProvider` (função injetada) que devolve a credencial CORRENTE.
//
// CLI-SEC-7 / CLI-SEC-2 (DUROS): a chave NUNCA está no repo/binário; vem do
// keychain do SO (cifrada pelo SO) OU de uma env var que o usuário exporta. NUNCA
// é gravada em arquivo texto, nunca logada. Reusa o MESMO `@napi-rs/keyring` do PAT
// do broker, sob um SERVIÇO/CONTA distinto (`aluy-cli-local` / `<provider>:apikey`).

import { Entry } from '@napi-rs/keyring';
import type {
  CredentialProvider,
  ResolvedCredential,
  LocalProviderKind,
  LocalAuthKind,
} from '@hiperplano/aluy-cli-core';

/** Serviço do keychain p/ as credenciais BYO do backend local (≠ do PAT do broker). */
export const LOCAL_KEYCHAIN_SERVICE = 'aluy-cli-local';

/** A env var de API key por provider (a via "limpa" — paga-por-uso). */
const ENV_API_KEY: Record<LocalProviderKind, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** Conta do keychain p/ a API key de um provider. */
export function apiKeyAccount(provider: LocalProviderKind): string {
  return `${provider}:apikey`;
}

/** Conta do keychain p/ os tokens OAuth de um provider (EST-1114). */
export function oauthAccount(provider: LocalProviderKind): string {
  return `${provider}:oauth`;
}

/**
 * Lançado quando NÃO há credencial p/ o provider no modo escolhido. Mensagem
 * acionável; NUNCA cita segredo.
 */
export class MissingLocalCredentialError extends Error {
  constructor(provider: LocalProviderKind, auth: LocalAuthKind) {
    const hint =
      auth === 'apikey'
        ? `configure a chave: \`${ENV_API_KEY[provider]}=...\` (env) ou \`aluy login --provider ${provider}\` (keychain)`
        : `faça login por assinatura: \`aluy login --provider ${provider} --oauth\``;
    super(`backend local: sem credencial ${auth} p/ "${provider}". ${hint}`);
    this.name = 'MissingLocalCredentialError';
  }
}

/** Subset do `Entry` do keyring (injeção em teste). */
export interface KeyringEntry {
  getPassword(): string;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export interface LocalCredentialResolverOptions {
  readonly provider: LocalProviderKind;
  /** `apikey` (default) ou `oauth` (EST-1114). */
  readonly auth?: LocalAuthKind;
  readonly env?: NodeJS.ProcessEnv;
  /** Fábrica de Entry injetável (testes). Default: `@napi-rs/keyring`. */
  readonly entryFactory?: (service: string, account: string) => KeyringEntry;
  /**
   * EST-1114 — provedor de access token OAuth (refrescado). Quando `auth==='oauth'`,
   * o resolvedor usa ISTO (não a env/keychain de API key). Injetado pelo locus que
   * detém o store de tokens OAuth (com refresh single-flight). Ausente + oauth ⇒ erro.
   */
  readonly oauthAccessToken?: () => Promise<string | undefined>;
}

function makeEntry(
  factory: ((service: string, account: string) => KeyringEntry) | undefined,
  service: string,
  account: string,
): KeyringEntry {
  if (factory !== undefined) return factory(service, account);
  return new Entry(service, account) as unknown as KeyringEntry;
}

/** Lê uma senha do keychain; ausência/erro ⇒ `undefined` (nunca lança no get). */
function readKeychain(
  factory: ((service: string, account: string) => KeyringEntry) | undefined,
  account: string,
): string | undefined {
  try {
    const entry = makeEntry(factory, LOCAL_KEYCHAIN_SERVICE, account);
    const v = entry.getPassword();
    return v !== '' ? v : undefined;
  } catch {
    return undefined; // sem entrada / sem backend ⇒ cai no env.
  }
}

/**
 * Cria a `CredentialProvider` que o `LocalModelClient` chama por requisição. Resolve
 * na ordem keychain → env (apikey) ou via `oauthAccessToken` (oauth). Resolve a CADA
 * chamada ⇒ pega rotação de chave / refresh de token sem reiniciar a sessão.
 */
export function createLocalCredentialProvider(
  opts: LocalCredentialResolverOptions,
): CredentialProvider {
  const provider = opts.provider;
  const auth: LocalAuthKind = opts.auth ?? 'apikey';
  const env = opts.env ?? process.env;

  return async (): Promise<ResolvedCredential> => {
    if (auth === 'oauth') {
      const token = opts.oauthAccessToken !== undefined ? await opts.oauthAccessToken() : undefined;
      if (token === undefined || token === '') {
        throw new MissingLocalCredentialError(provider, 'oauth');
      }
      return { kind: 'oauth', secret: token };
    }
    // apikey: keychain primeiro (mais seguro), env como fallback (CI/dogfood/containers
    // sem Secret Service). Ordem do env: var canônica do provider (built-ins) → genérica
    // por provider (`ALUY_<PROVIDER>_API_KEY`, p/ custom) → catch-all (`ALUY_LOCAL_API_KEY`,
    // p/ o provider local ATIVO). Assim provider CUSTOM (ex.: tokenrouter) também tem env.
    const fromKeychain = readKeychain(opts.entryFactory, apiKeyAccount(provider));
    const provEnvName = ENV_API_KEY[provider];
    const genericEnvName = `ALUY_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
    const fromEnv =
      (provEnvName !== undefined ? env[provEnvName] : undefined) ??
      env[genericEnvName] ??
      env.ALUY_LOCAL_API_KEY;
    const secret = fromKeychain ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined);
    if (secret === undefined) {
      throw new MissingLocalCredentialError(provider, 'apikey');
    }
    return { kind: 'apikey', secret };
  };
}

/** Grava uma API key BYO no keychain (usado por `aluy login --provider <p>`). */
export function storeApiKey(
  provider: LocalProviderKind,
  key: string,
  factory?: (service: string, account: string) => KeyringEntry,
): void {
  const entry = makeEntry(factory, LOCAL_KEYCHAIN_SERVICE, apiKeyAccount(provider));
  entry.setPassword(key);
}
