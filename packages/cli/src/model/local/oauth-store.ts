// ADR-0120 / EST-1114 — STORE de tokens OAuth do backend local (I/O concreto).
//
// Guarda os tokens OAuth (access+refresh+expiry) por provider no KEYCHAIN do SO
// (CLI-SEC-2: nunca em texto em claro) e os REFRESCA automaticamente no vencimento,
// com SINGLE-FLIGHT (um refresh concorrente coalesce — sem corrida). Expõe um
// `createOAuthAccessTokenProvider` que o `LocalModelClient` chama por requisição:
// devolve um access token VÁLIDO (refrescando se preciso).
//
// PORTÁVEL? Não — keychain + fetch de rede ⇒ mora no @aluy/cli. A lógica de
// PKCE/troca/refresh (pura, com fetch injetável) vive no core (`auth/oauth/pkce.ts`).
//
// ⚠ AVISO DE ToS (ADR-0120): token de assinatura em cliente não-oficial = zona
// cinzenta dos Termos do provider. Opção consciente do usuário.

import { Entry } from '@napi-rs/keyring';
import {
  refreshTokens,
  isTokenExpired,
  type OAuthTokens,
  type OAuthProviderConfig,
  type OAuthFetch,
  type LocalProviderKind,
} from '@aluy/cli-core';
import { LOCAL_KEYCHAIN_SERVICE, oauthAccount } from './credential-resolver.js';
import { OAUTH_PROVIDERS } from './oauth-providers.js';

/** Subset do `Entry` do keyring (injeção em teste). */
export interface KeyringEntry {
  getPassword(): string;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export interface OAuthTokenStoreOptions {
  readonly provider: LocalProviderKind;
  /** Config OAuth do provider (endpoints/client_id/scopes). Default: catálogo. */
  readonly config?: OAuthProviderConfig;
  /** Fábrica de Entry injetável (testes). Default: `@napi-rs/keyring`. */
  readonly entryFactory?: (service: string, account: string) => KeyringEntry;
  /** `fetch` injetável p/ o refresh (testes). Default: global. */
  readonly fetch?: OAuthFetch;
  /** Relógio injetável (testes determinísticos). Default: Date.now. */
  readonly now?: () => number;
}

function makeEntry(
  factory: ((service: string, account: string) => KeyringEntry) | undefined,
  account: string,
): KeyringEntry {
  if (factory !== undefined) return factory(LOCAL_KEYCHAIN_SERVICE, account);
  return new Entry(LOCAL_KEYCHAIN_SERVICE, account) as unknown as KeyringEntry;
}

/**
 * Store de tokens OAuth de UM provider. `read`/`write` no keychain; `getAccessToken`
 * devolve um token válido (refrescando single-flight no vencimento).
 */
export class OAuthTokenStore {
  private readonly provider: LocalProviderKind;
  private readonly config: OAuthProviderConfig;
  private readonly entryFactory: ((service: string, account: string) => KeyringEntry) | undefined;
  private readonly doFetch: OAuthFetch;
  private readonly now: () => number;
  /** Refresh em voo (single-flight): chamadas concorrentes compartilham a Promise. */
  private inFlight: Promise<OAuthTokens> | undefined;

  constructor(opts: OAuthTokenStoreOptions) {
    this.provider = opts.provider;
    const cfg = opts.config ?? OAUTH_PROVIDERS[opts.provider];
    if (cfg === undefined) {
      throw new Error(`backend local: provider "${opts.provider}" não tem config OAuth`);
    }
    this.config = cfg;
    this.entryFactory = opts.entryFactory;
    this.doFetch = opts.fetch ?? (globalThis.fetch as unknown as OAuthFetch);
    this.now = opts.now ?? Date.now;
  }

  /** Lê os tokens do keychain (ou `undefined` se não há login). */
  read(): OAuthTokens | undefined {
    try {
      const entry = makeEntry(this.entryFactory, oauthAccount(this.provider));
      const raw = entry.getPassword();
      if (raw === '') return undefined;
      const parsed = JSON.parse(raw) as Partial<OAuthTokens>;
      if (typeof parsed.accessToken !== 'string' || parsed.accessToken === '') return undefined;
      return parsed as OAuthTokens;
    } catch {
      return undefined;
    }
  }

  /** Grava os tokens no keychain (CLI-SEC-2: cifrado pelo SO, nunca em claro). */
  write(tokens: OAuthTokens): void {
    const entry = makeEntry(this.entryFactory, oauthAccount(this.provider));
    entry.setPassword(JSON.stringify(tokens));
  }

  /** Apaga o login OAuth (logout do provider). Idempotente. */
  clear(): void {
    try {
      makeEntry(this.entryFactory, oauthAccount(this.provider)).deletePassword();
    } catch {
      // ausência ⇒ nada a fazer.
    }
  }

  /**
   * Devolve um access token VÁLIDO. Se vencido (e há refresh_token), refresca
   * (SINGLE-FLIGHT) e persiste o novo par. Sem login / sem refresh válido ⇒
   * `undefined` (o caller resolve p/ "faça `aluy login --oauth`").
   */
  async getAccessToken(): Promise<string | undefined> {
    const tokens = this.read();
    if (tokens === undefined) return undefined;
    if (!isTokenExpired(tokens, this.now)) return tokens.accessToken;
    if (tokens.refreshToken === undefined) return undefined; // venceu e não dá p/ refrescar.
    const refreshed = await this.refreshSingleFlight(tokens.refreshToken);
    return refreshed.accessToken;
  }

  /** Refresh com single-flight: chamadas concorrentes esperam a MESMA Promise. */
  private async refreshSingleFlight(refreshToken: string): Promise<OAuthTokens> {
    if (this.inFlight !== undefined) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const fresh = await refreshTokens({
          config: this.config,
          refreshToken,
          fetch: this.doFetch,
          now: this.now,
        });
        this.write(fresh);
        return fresh;
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }
}

/**
 * Conveniência: a `() => Promise<string|undefined>` que o `LocalModelClient`
 * (via credential-resolver) espera sob `auth:'oauth'`. Cria um store por provider.
 */
export function createOAuthAccessTokenProvider(
  provider: LocalProviderKind,
  opts: Omit<OAuthTokenStoreOptions, 'provider'> = {},
): () => Promise<string | undefined> {
  const store = new OAuthTokenStore({ provider, ...opts });
  return () => store.getAccessToken();
}
