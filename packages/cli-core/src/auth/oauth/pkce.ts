// ADR-0120 / EST-1114 — OAuth 2.0 com PKCE (RFC 7636) — lógica PORTÁVEL.
//
// O backend local pode autenticar por ASSINATURA (Claude Pro/Max, ChatGPT) via
// OAuth-PKCE em vez de API key. Esta camada é PORTÁVEL (ADR-0053 §8): gera o par
// verifier/challenge, monta o authorize URL, e troca/refresca tokens via um
// `fetch` injetável. O I/O concreto (abrir o browser, loopback server, gravar no
// keychain) mora no `@hiperplano/aluy-cli` (EST-1114, locus).
//
// ⚠ AVISO DE ToS (ADR-0120): usar token de ASSINATURA em cliente NÃO-oficial é
// zona cinzenta dos Termos do provider — opção consciente do usuário. A via API
// key (paga-por-uso) NÃO tem essa ressalva. O prompt de login exibe o aviso.
//
// CLI-SEC-2: os tokens NUNCA são gravados em claro — vão ao keychain do SO (locus).

/** Funções de cripto injetáveis (o locus liga ao `node:crypto`; testes mockam). */
export interface PkceCrypto {
  /** Bytes aleatórios criptográficos (p/ o code_verifier). */
  randomBytes(n: number): Uint8Array;
  /** SHA-256 do input (p/ o code_challenge S256). */
  sha256(input: Uint8Array): Uint8Array;
}

/** Par PKCE (RFC 7636 §4): o verifier (segredo) + o challenge (público, S256). */
export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly method: 'S256';
}

/** base64url SEM padding (RFC 7636 §A / RFC 4648 §5). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa existe no Node 18+ e no browser; o core não importa `Buffer`.
  const b64 = typeof btoa === 'function' ? btoa(bin) : nodeBtoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function nodeBtoa(bin: string): string {
  // Fallback portável sem depender de Buffer global tipado (ambientes estranhos).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.Buffer !== 'undefined') return g.Buffer.from(bin, 'binary').toString('base64');
  throw new Error('base64 indisponível no runtime');
}

/**
 * Gera um par PKCE. O `code_verifier` é base64url de ≥32 bytes aleatórios (RFC
 * 7636 §4.1: 43–128 chars); o `code_challenge` é base64url(SHA-256(verifier)).
 */
export function generatePkcePair(crypto: PkceCrypto, verifierBytes = 32): PkcePair {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(verifierBytes));
  const digest = crypto.sha256(new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64UrlEncode(digest);
  return { codeVerifier, codeChallenge, method: 'S256' };
}

/** Config de um provider OAuth (endpoints + client_id + scopes + redirect). */
export interface OAuthProviderConfig {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

/**
 * Monta o authorize URL (RFC 6749 §4.1.1 + PKCE §4.3): `response_type=code`,
 * `client_id`, `redirect_uri`, `scope`, `state` (anti-CSRF), `code_challenge`,
 * `code_challenge_method=S256`.
 */
export function buildAuthorizeUrl(
  config: OAuthProviderConfig,
  pkce: PkcePair,
  state: string,
): string {
  const u = new URL(config.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', config.clientId);
  u.searchParams.set('redirect_uri', config.redirectUri);
  if (config.scopes.length > 0) u.searchParams.set('scope', config.scopes.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', pkce.codeChallenge);
  u.searchParams.set('code_challenge_method', pkce.method);
  return u.toString();
}

/** `fetch` mínimo p/ as trocas de token (subset; injetável p/ teste). */
export type OAuthFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Par de tokens OAuth (resultado da troca/refresh). */
export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch ms de expiração do access token (derivado de `expires_in`). */
  readonly expiresAt?: number;
  readonly scope?: string;
}

/**
 * Troca o `code` (do redirect) pelo par de tokens (RFC 6749 §4.1.3 + PKCE §4.5:
 * inclui o `code_verifier`). `now` injetável p/ derivar `expiresAt` determinístico.
 */
export async function exchangeCodeForTokens(args: {
  readonly config: OAuthProviderConfig;
  readonly code: string;
  readonly codeVerifier: string;
  readonly fetch: OAuthFetch;
  readonly now?: () => number;
}): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.config.redirectUri,
    client_id: args.config.clientId,
    code_verifier: args.codeVerifier,
  });
  return await postToken(args.config.tokenUrl, params, args.fetch, args.now ?? Date.now);
}

/**
 * Refresca o access token via o `refresh_token` (RFC 6749 §6). Single-flight é
 * responsabilidade do chamador (o store de tokens do locus coalesce — EST-1114).
 */
export async function refreshTokens(args: {
  readonly config: OAuthProviderConfig;
  readonly refreshToken: string;
  readonly fetch: OAuthFetch;
  readonly now?: () => number;
}): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.config.clientId,
  });
  const tokens = await postToken(args.config.tokenUrl, params, args.fetch, args.now ?? Date.now);
  // Alguns providers NÃO devolvem um novo refresh_token no refresh ⇒ preserva o antigo.
  if (tokens.refreshToken === undefined) {
    return { ...tokens, refreshToken: args.refreshToken };
  }
  return tokens;
}

/** POST form-encoded ao token endpoint; parseia a resposta padrão OAuth. */
async function postToken(
  tokenUrl: string,
  params: URLSearchParams,
  fetch: OAuthFetch,
  now: () => number,
): Promise<OAuthTokens> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: params.toString(),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
    throw new OAuthError(`token endpoint respondeu ${res.status}`, res.status, redactBody(detail));
  }
  const body = await res.json();
  return parseTokenResponse(body, now);
}

/** Parseia `{access_token, refresh_token?, expires_in?, scope?}` (RFC 6749 §5.1). */
export function parseTokenResponse(body: unknown, now: () => number): OAuthTokens {
  if (typeof body !== 'object' || body === null) {
    throw new OAuthError('resposta do token endpoint não é objeto', 0);
  }
  const obj = body as Record<string, unknown>;
  const accessToken = typeof obj.access_token === 'string' ? obj.access_token : undefined;
  if (accessToken === undefined || accessToken === '') {
    throw new OAuthError('resposta do token endpoint sem access_token', 0);
  }
  const out: { -readonly [K in keyof OAuthTokens]: OAuthTokens[K] } = { accessToken };
  if (typeof obj.refresh_token === 'string' && obj.refresh_token !== '') {
    out.refreshToken = obj.refresh_token;
  }
  if (typeof obj.expires_in === 'number' && Number.isFinite(obj.expires_in)) {
    out.expiresAt = now() + obj.expires_in * 1000;
  }
  if (typeof obj.scope === 'string') out.scope = obj.scope;
  return out;
}

/**
 * `true` se o access token está vencido (ou vence em ≤ `skewMs`). Sem `expiresAt`
 * ⇒ tratamos como NÃO-vencido (o provider valida; refrescamos no 401).
 */
export function isTokenExpired(tokens: OAuthTokens, now: () => number, skewMs = 60_000): boolean {
  if (tokens.expiresAt === undefined) return false;
  return tokens.expiresAt - now() <= skewMs;
}

/** Erro estruturado do fluxo OAuth (sem segredo na mensagem — CLI-SEC-10). */
export class OAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number, detail?: string) {
    super(detail !== undefined && detail !== '' ? `${message}: ${detail}` : message);
    this.name = 'OAuthError';
    this.status = status;
  }
}

/** Remove o que parecer token do corpo de erro antes de logar (defesa extra). */
function redactBody(body: string): string {
  // corta tokens longos (>20 chars de base64url-ish) — best-effort, não loga segredo.
  return body.replace(/[A-Za-z0-9_-]{20,}/g, '***').slice(0, 200);
}
