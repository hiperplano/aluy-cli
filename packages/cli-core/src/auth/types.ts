// Contrato TS da auth headless (lado cliente) — EST-0942 / CLI-SEC-1.
//
// PORTÁVEL: só tipos + (mais adiante) lógica de rede/estado. Sem I/O de
// terminal, sem keychain nativo (esses moram em @aluy/cli). Estes tipos
// espelham o contrato dos endpoints da EST-0940 no aluy-identity:
//   POST /identity/device/authorize            (DeviceAuthorizeResponse)
//   POST /identity/token  (grant_type=device)  (HeadlessTokenResponse | OAuthError)
//   POST /identity/headless/refresh            (HeadlessTokenResponse)
//   POST /identity/headless/revoke             (204)
//   POST /auth/headless/introspect             (introspect — M2M do broker; não usado pelo CLI)
//
// `aluy-sdk` (contrato TS canônico) é follow-up da EST-0940 e ainda não existe;
// este módulo é o PRIMEIRO consumidor. Quando o `aluy-sdk` nascer, este cliente
// migra para lá sem duplicar tipos (ADR-0053 §7).

/** Escopos canônicos da credencial headless (deny-por-padrão — SEC-12). */
export type HeadlessScope = 'assistant:session' | 'llm:call' | 'quota:read';

/** Default mínimo do CLI (espelha DEFAULT_HEADLESS_SCOPES do identity). */
export const DEFAULT_HEADLESS_SCOPES: readonly HeadlessScope[] = ['assistant:session', 'llm:call'];

/** Resposta de RFC 8628 §3.2 — início do device-flow. */
export interface DeviceAuthorizeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

/** Par de tokens da sessão headless (sucesso do polling/refresh). */
export interface HeadlessTokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: string; // "Bearer"
  readonly expires_in: number;
  readonly scope: string; // escopos separados por espaço (convenção OAuth)
  readonly organization_id: string;
}

/**
 * Códigos de erro OAuth do polling do device-flow (RFC 8628 §3.5). O corpo de
 * erro do endpoint `/identity/token` é `{ error, error_description? }`.
 */
export type DeviceOAuthErrorCode =
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token'
  | 'invalid_grant'
  | 'unsupported_grant_type';

export interface OAuthErrorBody {
  readonly error: string;
  readonly error_description?: string;
}

/**
 * Como a credencial foi obtida — determina o caminho de logout/refresh.
 *  - `device`: sessão device-flow (tem refresh rotativo; logout = revoke da família).
 *  - `pat`: PAT escopado (vida-longa; logout = só apaga do keychain — a revogação
 *    server-side do PAT é via web/EST-0940, não há refresh).
 */
export type CredentialKind = 'device' | 'pat';

/**
 * Credencial persistida NO KEYCHAIN do SO (CLI-SEC-2). NUNCA em arquivo texto,
 * env persistida ou log. Os campos de segredo (`access_token`/`refresh_token`/
 * `pat`) só existem dentro do keychain; ao logar/serializar para fora, são
 * redigidos (ver `redactCredential`).
 */
export interface StoredCredential {
  readonly kind: CredentialKind;
  /** access JWT (device) — ausente no caminho PAT puro. */
  readonly access_token?: string;
  /** refresh rotativo (device). */
  readonly refresh_token?: string;
  /** PAT cru `pat_<hex>_<secret>` (kind=pat). */
  readonly pat?: string;
  readonly organization_id: string;
  readonly scopes: readonly string[];
  /** epoch ms de expiração do access/credencial (device). undefined = vida-longa (PAT). */
  readonly expires_at?: number;
  /** versão do envelope, para migração futura. */
  readonly v: 1;
}
