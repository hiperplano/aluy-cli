// Cliente TS dos endpoints de auth headless do aluy-identity (EST-0940).
//
// PORTÁVEL: usa `fetch` (injetável p/ teste) e NÃO faz I/O de terminal nem toca
// keychain. É o cliente que a EST-0940 deixou como follow-up de `aluy-sdk`;
// como o `aluy-sdk` ainda não existe, ele nasce aqui (primeiro consumidor) e
// migra quando o pacote existir, sem duplicar contrato (ADR-0053 §7).
//
// O token endpoint do device-flow devolve CORPO OAUTH-ERROR (RFC 8628 §3.5) em
// status 400 — por isso `pollToken` retorna um resultado discriminado em vez de
// lançar para os estados de fluxo (pending/slow_down/denied/expired).

import { IdentityHttpError } from './errors.js';
import type {
  DeviceAuthorizeResponse,
  DeviceOAuthErrorCode,
  HeadlessScope,
  HeadlessTokenResponse,
  OAuthErrorBody,
} from './types.js';

/** `fetch` mínimo que o cliente precisa (subset do WHATWG fetch). */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface IdentityClientOptions {
  /** Base URL do identity, ex. `https://api.aluy.app/api/v1` (sem barra final). */
  readonly baseUrl: string;
  /** client_id do CLI no device-flow. */
  readonly clientId: string;
  /** `fetch` injetável (default: global). */
  readonly fetch?: FetchLike;
}

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Resultado discriminado do polling do token endpoint. */
export type PollTokenResult =
  | { readonly status: 'success'; readonly tokens: HeadlessTokenResponse }
  | { readonly status: 'pending' }
  | { readonly status: 'slow_down' }
  | { readonly status: 'denied' }
  | { readonly status: 'expired' }
  | { readonly status: 'error'; readonly code: string; readonly description?: string };

export class IdentityClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly doFetch: FetchLike;

  constructor(opts: IdentityClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.clientId = opts.clientId;
    // `globalThis.fetch` existe no Node 20+ — cast estreito p/ não puxar dom-lib.
    this.doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /**
   * HUNT-IO-NET — lê o corpo JSON de uma resposta 2xx com FAIL-SOFT VISÍVEL. O
   * `fetch` REAL do Node faz `res.json()` LANÇAR quando o corpo não é JSON válido
   * (vazio, HTML de proxy/gateway, truncado num 200 enganoso). Sem isto, um
   * `SyntaxError` CRU escapava pelo caminho de sucesso — bypassando o contrato de
   * `IdentityHttpError` (login estoura com erro técnico; `getAccessToken` engole e
   * força re-login desnecessário num 200 malformado transitório). Convertemos num
   * `IdentityHttpError` estruturado (mesmo canal dos não-2xx) — erro honesto.
   */
  private async readJson<T>(res: { json(): Promise<unknown> }, context: string): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch {
      throw new IdentityHttpError(200, `${context} (corpo 2xx não é JSON válido)`);
    }
  }

  /** RFC 8628 §3.1 — inicia o device-flow. `scopes` vazio ⇒ identity aplica o
   * default mínimo (deny-por-padrão; SEC-12). */
  async deviceAuthorize(args: {
    organizationId: string;
    scopes?: readonly HeadlessScope[];
  }): Promise<DeviceAuthorizeResponse> {
    const res = await this.doFetch(this.url('/identity/device/authorize'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        organization_id: args.organizationId,
        scopes: args.scopes ?? [],
      }),
    });
    if (!res.ok) {
      throw new IdentityHttpError(res.status, 'device/authorize');
    }
    return await this.readJson<DeviceAuthorizeResponse>(res, 'device/authorize');
  }

  /**
   * RFC 8628 §3.4 — UMA tentativa de polling do token. Mapeia o corpo
   * OAuth-error para o resultado discriminado (não lança para os estados de
   * fluxo). A máquina de polling (device-flow.ts) chama isto em loop.
   */
  async pollToken(deviceCode: string, signal?: AbortSignal): Promise<PollTokenResult> {
    const res = await this.doFetch(this.url('/identity/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: this.clientId,
      }),
      ...(signal ? { signal } : {}),
    });

    if (res.ok) {
      // Boundary: 200 com corpo malformado ⇒ IdentityHttpError (não SyntaxError cru).
      return {
        status: 'success',
        tokens: await this.readJson<HeadlessTokenResponse>(res, 'token'),
      };
    }

    // Corpo OAuth-error: { error, error_description? }.
    let body: OAuthErrorBody | undefined;
    try {
      body = (await res.json()) as OAuthErrorBody;
    } catch {
      body = undefined;
    }
    const code = (body?.error ?? '') as DeviceOAuthErrorCode | string;
    switch (code) {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return { status: 'slow_down' };
      case 'access_denied':
        return { status: 'denied' };
      case 'expired_token':
        return { status: 'expired' };
      default:
        return {
          status: 'error',
          code: code || `http_${res.status}`,
          ...(body?.error_description ? { description: body.error_description } : {}),
        };
    }
  }

  /** Refresh ROTATIVO da sessão headless (CLI-SEC-1). */
  async refresh(refreshToken: string): Promise<HeadlessTokenResponse> {
    const res = await this.doFetch(this.url('/identity/headless/refresh'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) {
      throw new IdentityHttpError(res.status, 'headless/refresh');
    }
    return await this.readJson<HeadlessTokenResponse>(res, 'headless/refresh');
  }

  /** Revogação IMEDIATA da família de refresh (logout do device-flow). */
  async revoke(refreshToken: string): Promise<void> {
    const res = await this.doFetch(this.url('/identity/headless/revoke'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    // 204 = sucesso. Identity revoga de forma idempotente; tratamos 404/401 como
    // "já revogado" (logout não deve falhar por isso).
    if (res.status === 204 || res.status === 404 || res.status === 401) return;
    if (!res.ok) {
      throw new IdentityHttpError(res.status, 'headless/revoke');
    }
  }
}
