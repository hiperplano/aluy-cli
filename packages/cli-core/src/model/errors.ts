// Erros estruturados da chamada de modelo via broker (EST-0943, CA-5).
//
// O broker responde erro como `application/problem+json` (RFC 9457,
// `broker.md` §8). O cliente PROPAGA esses erros de forma ESTRUTURADA ao loop
// (sem mascarar, sem retry infinito — CA-5): preserva `status`, `code`,
// `retryable` e `retry_after`. A decisão de retry/parada é do loop (EST-0944) /
// dos tetos de sessão (EST-0947), não do transporte.
//
// CLI-SEC-10: a mensagem NUNCA carrega segredo — o broker já garante que o corpo
// problem+json não cita credencial/provider; aqui só repassamos `detail`.

/**
 * Catálogo de `code` do broker que o cliente reconhece (`broker.md` §8). Mantido
 * como string-union ABERTA (`string & {}`) para não acoplar o release do CLI ao
 * catálogo do servidor: um code novo continua sendo um `BrokerError` honesto.
 */
export type BrokerErrorCode =
  | 'UNAUTHENTICATED' // 401 — credencial headless inválida/revogada/expirada
  | 'PERMISSION_DENIED' // 403 — ator sem permissão
  | 'MODEL_DENIED' // 403 — tier fora do plano da org
  | 'INSUFFICIENT_CREDIT' // 402 — saldo reseller < estimativa
  | 'IDEMPOTENCY_KEY_REUSED' // 409
  | 'UNKNOWN_TIER' // 422 — tier inexistente
  | 'UNKNOWN_MODEL' // 422 — id do modo Custom fora do catálogo da OpenRouter (EST-0942)
  | 'RESERVED_FIELD' // 422 — provider/credencial no request (não deve acontecer)
  | 'VALIDATION_FAILED' // 422 — schema (ex.: Custom sem `model`)
  | 'TOOLS_UNSUPPORTED' // 422 — modelo sem function-calling nativo (EST-0996) ⇒ degradar p/ texto
  | 'BUDGET_EXHAUSTED' // 429 — hard-cap (tokens ou custo)
  | 'RATE_LIMITED' // 429 — rate-limit por ator
  | 'USAGE_WINDOW_EXHAUSTED' // 429 — janela 5h (ADR-0051)
  | 'WEEKLY_CAP_EXHAUSTED' // 429 — teto semanal (ADR-0051)
  | 'PROVIDER_ERROR' // 502 — falha do vendor pós-fallback
  | 'VAULT_UNAVAILABLE' // 502 — segredo revogado / store fora
  | 'PROVIDER_NOT_CONFIGURED' // 502 — tier sem credencial na org
  | (string & {});

/**
 * Um erro de campo do envelope problem+json (`errors[]`, `broker.md` §8). O broker
 * mada `{field, code, detail}` por campo inválido (ex.: `RESERVED_FIELD` lista
 * `provider`/`api_key`/`base_url`; `VALIDATION_FAILED`/`UNKNOWN_MODEL` listam `model`).
 * Preservado p/ o caller inspecionar QUAL campo falhou — também já redigido server-side.
 */
export interface ProblemFieldError {
  readonly field?: string;
  readonly code?: string;
  readonly detail?: string;
}

/** Campos úteis do envelope problem+json que o cliente preserva (`broker.md` §8). */
export interface ProblemDetails {
  readonly status: number;
  readonly code: BrokerErrorCode;
  readonly title?: string;
  readonly detail?: string;
  readonly type?: string;
  readonly instance?: string;
  /** Erros por campo (`errors[]`), quando o broker enumera (422 de validação). */
  readonly errors?: readonly ProblemFieldError[];
  /** Em `502 PROVIDER_ERROR`/`VAULT_UNAVAILABLE` retryable; `429` depende. */
  readonly retryable?: boolean;
  /** Segundos a esperar (`Retry-After`/corpo), quando o broker indica. */
  readonly retry_after?: number;
}

/**
 * Erro estruturado de uma chamada brokerada. LANÇADO pelo cliente (não é um
 * evento de stream): o loop faz `try/catch` e decide. Carrega o problem+json
 * inteiro p/ o chamador inspecionar `status`/`code`/`retryable` (CA-5).
 */
export class BrokerError extends Error {
  readonly status: number;
  readonly code: BrokerErrorCode;
  readonly retryable: boolean;
  readonly retryAfter: number | undefined;
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    // `detail` do broker é seguro p/ humano (sem segredo, garantido server-side);
    // se faltar, usamos `title`/`code` — nunca o corpo cru/headers.
    super(
      problem.detail ?? problem.title ?? `broker respondeu ${problem.status} (${problem.code})`,
    );
    this.name = 'BrokerError';
    this.status = problem.status;
    this.code = problem.code;
    this.retryable = problem.retryable ?? defaultRetryable(problem.status);
    this.retryAfter = problem.retry_after;
    this.problem = problem;
  }

  /** O erro decorre de credencial inválida/expirada/revogada? ⇒ re-login. */
  get isAuth(): boolean {
    return this.status === 401 || this.code === 'UNAUTHENTICATED';
  }

  /** Quota/janela/saldo estourou? (429/402) — o loop deve PARAR e avisar. */
  get isQuota(): boolean {
    return this.status === 429 || this.status === 402;
  }

  /**
   * EST-0996 — o modelo/tier NÃO suporta function-calling nativo? O broker
   * responde `422 TOOLS_UNSUPPORTED` quando o request mandou `tools` p/ um modelo
   * sem suporte. O caller DEGRADA gracioso: 1 retry SEM `tools` (cai no protocolo
   * de TEXTO, #99) e desliga o nativo na sessão. NÃO é falha p/ o usuário — é uma
   * negociação de capacidade. Casa SÓ por `status===422 && code==='TOOLS_UNSUPPORTED'`
   * (robusto): um 422 SEM esse `code` é `VALIDATION_FAILED` — NÃO mascaramos outros
   * erros (ex.: "custom sem model", "unknown model") como tools-unsupported. (Comentário
   * antigo falava de fallback por título/detalhe que NUNCA existiu — corrigido p/ o código.)
   */
  get isToolsUnsupported(): boolean {
    return this.status === 422 && this.code === 'TOOLS_UNSUPPORTED';
  }
}

/** Default conservador de retryable por status quando o corpo não diz (CA-5). */
function defaultRetryable(status: number): boolean {
  // 5xx e 429 podem ser transitórios; 4xx (exceto 429) não — não faz sentido
  // repetir um 401/422/403. O loop ainda aplica seu próprio teto (EST-0947).
  if (status === 429) return true;
  return status >= 500;
}

/** Falha de TRANSPORTE (rede/abort não foi quem cortou) — não veio problem+json. */
export class BrokerTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    // `cause` é a opção padrão de Error (ES2022) — preserva a origem sem
    // re-declarar a propriedade. NUNCA logamos o token; o cause é só p/ debug.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'BrokerTransportError';
  }
}

/**
 * A chamada foi CANCELADA pelo chamador (AbortSignal) — distinta de erro de
 * broker/transporte. O loop trata como "usuário/teto interrompeu", não falha.
 */
export class ModelCallAbortedError extends Error {
  constructor() {
    super('chamada de modelo cancelada.');
    this.name = 'ModelCallAbortedError';
  }
}

/**
 * Constrói um `ProblemDetails` a partir de um corpo desconhecido da rede
 * (boundary `unknown` → tipo confiável). Tolerante: se o corpo não for um
 * problem+json reconhecível, sintetiza um a partir do `status` HTTP, sem
 * inventar campos nem vazar o corpo cru.
 */
export function toProblemDetails(status: number, body: unknown): ProblemDetails {
  const obj = isRecord(body) ? body : {};
  const code = typeof obj.code === 'string' ? obj.code : statusToCode(status);
  const out: {
    -readonly [K in keyof ProblemDetails]: ProblemDetails[K];
  } = { status, code };
  if (typeof obj.title === 'string') out.title = obj.title;
  if (typeof obj.detail === 'string') out.detail = obj.detail;
  if (typeof obj.type === 'string') out.type = obj.type;
  if (typeof obj.instance === 'string') out.instance = obj.instance;
  const errors = toFieldErrors(obj.errors);
  if (errors !== undefined) out.errors = errors;
  if (typeof obj.retryable === 'boolean') out.retryable = obj.retryable;
  if (typeof obj.retry_after === 'number') out.retry_after = obj.retry_after;
  return out;
}

/**
 * Normaliza o `errors[]` do corpo (boundary `unknown`): mantém só entradas-objeto
 * com `field`/`code`/`detail` STRING (descarta lixo), sem inventar campos. Devolve
 * `undefined` quando não há nada aproveitável — assim o campo opcional fica ausente.
 */
function toFieldErrors(raw: unknown): readonly ProblemFieldError[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ProblemFieldError[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const e: { -readonly [K in keyof ProblemFieldError]: ProblemFieldError[K] } = {};
    if (typeof item.field === 'string') e.field = item.field;
    if (typeof item.code === 'string') e.code = item.code;
    if (typeof item.detail === 'string') e.detail = item.detail;
    if (e.field !== undefined || e.code !== undefined || e.detail !== undefined) out.push(e);
  }
  return out.length > 0 ? out : undefined;
}

function statusToCode(status: number): BrokerErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHENTICATED';
    case 402:
      return 'INSUFFICIENT_CREDIT';
    case 403:
      return 'PERMISSION_DENIED';
    case 409:
      return 'IDEMPOTENCY_KEY_REUSED';
    case 422:
      return 'VALIDATION_FAILED';
    case 429:
      return 'RATE_LIMITED';
    case 502:
      return 'PROVIDER_ERROR';
    default:
      return `HTTP_${status}`;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
