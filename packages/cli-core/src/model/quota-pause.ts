// PAUSA POR COTA — classificação PURA do erro de chamada de modelo.
//
// O BURACO que isto fecha (pedido do dono): quando a cota acaba (janela de uso, teto
// semanal, saldo, rate-limit longo), o agente morria — o sub-agente voltava "falhou" ao
// pai e o trabalho em memória se perdia. Em vez disso o agente deve PAUSAR, guardar o que
// fez e voltar sozinho quando a cota liberar (ou quando o dono mandar).
//
// Este módulo só CLASSIFICA e calcula tempos. Quem pausa de fato é o coordenador
// (`agent/quota-pause.ts`). Três categorias, de propósito disjuntas:
//
//   1. TRANSITÓRIO (blip de rede, 5xx, 429 curto)  → o retry de `retry.ts` cuida, como hoje.
//   2. COTA (vai liberar depois)                    → PAUSA. Tem 5 sabores (`QuotaScope`).
//   3. DEFINITIVO (401/403/404/400/422, recusa)     → falha como sempre. NUNCA pausa:
//      esperar não conserta chave inválida nem modelo inexistente, e no BYO cada
//      tentativa que chega ao provider custa dinheiro.
//
// DE ONDE VEM O HORÁRIO DE RESET (o mais específico vence):
//   - `reset_at_ms` já resolvido pelo cliente (broker/local) a partir dos headers;
//   - `Retry-After` (segundos ou HTTP-date) — a fonte mais confiável;
//   - OpenAI/OpenRouter: `x-ratelimit-reset-requests|tokens` ("1s", "6m0s", "20ms");
//   - Anthropic: `anthropic-ratelimit-*-reset` (RFC 3339) e o `unified-reset` (epoch s);
//   - o texto do erro ("try again in 6m0s", "Please retry after ...").
// Sem nenhuma dica ⇒ backoff com sondagem periódica (`probeDelayMs`). A sondagem é a
// PRÓPRIA chamada pendente de um agente (não uma chamada extra) e é UMA por vez — nunca
// um laço apertado queimando dinheiro no BYO.
//
// PURO (ADR-0053 §8): sem I/O, sem timers, sem Ink. O "agora" entra por parâmetro.

import { BrokerError, BrokerTransportError, ModelCallAbortedError } from './errors.js';

/** Sabor da cota esgotada — só muda a mensagem e o palpite de espera. */
export type QuotaScope =
  /** Janela de uso (5h) do plano. */
  | 'janela'
  /** Teto semanal do plano. */
  | 'semanal'
  /** Hard-cap de tokens/custo da organização (broker). */
  | 'orcamento'
  /** Saldo/crédito do provider (`insufficient_quota`, 402). Pode recarregar. */
  | 'credito'
  /** Rate-limit (429) que não cabe no retry curto. */
  | 'taxa';

/** Veredito de "é cota que vai liberar depois". */
export interface QuotaVerdict {
  readonly scope: QuotaScope;
  /** Quando a cota deve liberar (epoch ms), se o provider disse. `undefined` ⇒ desconhecido. */
  readonly resetAtMs: number | undefined;
  /** Motivo curto, sem segredo — vai p/ a TUI e a auditoria. */
  readonly reason: string;
}

/** Horizonte máximo aceito para um horário de reset (teto semanal + folga). Anti-hostil. */
export const MAX_QUOTA_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;
/** Limite do retry curto (`retry.ts`): acima disto a espera vira PAUSA, não retry. */
export const SHORT_RETRY_LIMIT_MS = 60_000;

/** Rótulo PT-BR de cada sabor (UI/nota). */
export function quotaScopeLabel(scope: QuotaScope): string {
  switch (scope) {
    case 'janela':
      return 'janela de uso esgotada';
    case 'semanal':
      return 'teto semanal esgotado';
    case 'orcamento':
      return 'orçamento esgotado';
    case 'credito':
      return 'sem crédito no provider';
    case 'taxa':
      return 'limite de requisições atingido';
  }
}

// ── parsing de tempo ─────────────────────────────────────────────────────────

/**
 * Duração estilo Go/OpenAI ("1s", "6m0s", "1h2m3s", "20ms", "1.5s") ⇒ ms. Também aceita
 * número puro (segundos). Lixo ⇒ `undefined`. PURO.
 */
export function parseDurationMs(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = raw.trim().toLowerCase();
  if (s === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s|d)/g;
  let total = 0;
  let matched = 0;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    const n = Number(m[1]);
    const unit = m[2]!;
    const mult =
      unit === 'ms'
        ? 1
        : unit === 's'
          ? 1000
          : unit === 'm'
            ? 60_000
            : unit === 'h'
              ? 3_600_000
              : 86_400_000;
    total += n * mult;
    matched += 1;
    consumed += m[0].length;
  }
  if (matched === 0 || consumed !== s.length) return undefined;
  return Math.round(total);
}

/**
 * Instante de reset a partir de UM valor de header de reset: duração relativa
 * ("6m0s"), timestamp RFC 3339 ("2026-11-03T18:00:00Z"), epoch em segundos (≥ 1e9) ou
 * epoch em ms (≥ 1e12). Devolve epoch ms ou `undefined`. PURO.
 */
export function parseResetValue(raw: string | null | undefined, nowMs: number): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = raw.trim();
  if (s === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 1e12) return Math.round(n); // epoch ms
    if (n >= 1e9) return Math.round(n * 1000); // epoch s
    return nowMs + Math.round(n * 1000); // segundos relativos
  }
  if (/^[\d.]+(ms|s|m|h|d)/i.test(s)) {
    const d = parseDurationMs(s);
    return d === undefined ? undefined : nowMs + d;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/** Leitor mínimo de headers (compatível com `Headers.get`). */
export interface HeaderReader {
  get(name: string): string | null;
}

/** Headers de reset conhecidos, além do `Retry-After` (que tem prioridade). */
const RESET_HEADERS = [
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-reset',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-reset',
  'anthropic-ratelimit-unified-reset',
  'ratelimit-reset',
] as const;

/**
 * Horário de reset (epoch ms) a partir dos headers de uma resposta de erro. `Retry-After`
 * vence; senão vale o MAIOR dos headers de reset presentes (esperar pouco demais só gera
 * uma sondagem extra; esperar a janela certa é o ponto). Sem nada ⇒ `undefined`. PURO.
 */
export function resetAtFromHeaders(headers: HeaderReader, nowMs: number): number | undefined {
  const ra = headers.get('retry-after');
  if (ra !== null) {
    const v = parseResetValue(ra, nowMs);
    if (v !== undefined) return v;
  }
  let best: number | undefined;
  for (const name of RESET_HEADERS) {
    const v = parseResetValue(headers.get(name), nowMs);
    if (v !== undefined && (best === undefined || v > best)) best = v;
  }
  return best;
}

/**
 * Dica de espera no TEXTO do erro: "try again in 6m0s", "retry after 20 seconds",
 * "resets in 3 hours". Devolve epoch ms ou `undefined`. Só olha o texto do provider
 * (já sem segredo). PURO.
 */
export function resetAtFromMessage(message: string, nowMs: number): number | undefined {
  // Z.ai (GLM Coding Plan): "Your limit will reset at 2026-11-03 05:00:00". Data/hora ABSOLUTAS.
  // Sem fuso na mensagem, o fuso é o do provider: UTC+8 (Pequim). Com fuso explícito (Z/±hh:mm),
  // vale o explícito. Se estiver errado, o custo é uma sondagem a mais (a escada de backoff
  // assume) — nunca um laço apertado.
  const abs =
    /reset(?:s)?\s+at\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(Z|[+-]\d{2}:?\d{2})?/i.exec(
      message,
    );
  if (abs) {
    const tz = abs[3] === undefined ? '+08:00' : abs[3] === 'Z' || abs[3] === 'z' ? 'Z' : abs[3];
    const hms = abs[2]!.length === 5 ? `${abs[2]}:00` : abs[2]!;
    const tzNorm = /^[+-]\d{4}$/.test(tz) ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz;
    const t = Date.parse(`${abs[1]}T${hms}${tzNorm}`);
    if (Number.isFinite(t)) return t;
  }
  const m =
    /(?:try again|retry|resets?)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\s*)+)/i.exec(
      message,
    );
  if (!m) return undefined;
  const norm = m[1]!
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/milliseconds?/g, 'ms')
    .replace(/seconds?|secs?/g, 's')
    .replace(/minutes?|mins?/g, 'm')
    .replace(/hours?|hrs?/g, 'h')
    .replace(/days?/g, 'd');
  const d = parseDurationMs(norm);
  return d === undefined ? undefined : nowMs + d;
}

/** Garante que o reset está no futuro próximo e dentro do horizonte; senão `undefined`. */
function clampReset(resetAtMs: number | undefined, nowMs: number): number | undefined {
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs)) return undefined;
  // Horário já vencido (relógio/fuso divergente, header velho): não é informação útil e
  // geraria sondagem imediata em laço — trata como desconhecido (a escada de backoff assume).
  if (resetAtMs <= nowMs) return undefined;
  return Math.min(resetAtMs, nowMs + MAX_QUOTA_HORIZON_MS);
}

// ── classificação ────────────────────────────────────────────────────────────

/** Mensagens que, por si sós, dizem "acabou a cota/saldo" (provider BYO). */
const STRONG_QUOTA_TEXT =
  /provider_code:13(?:04|08|09|10)\b|usage limit|limit (?:will )?resets?\b|insufficient_quota|billing_hard_limit|exceeded your current quota|credit balance is too low|out of (?:credits|quota)|no (?:remaining )?credits|quota (?:exceeded|exhausted|reached)|resource_exhausted/i;
const WINDOW_TEXT = /5[- ]?hour|window|janela|hourly/i;
const WEEKLY_TEXT = /week|semanal/i;

/**
 * "Isto é cota que vai liberar depois?" Devolve o veredito ou `null` (não é cota:
 * transitório OU definitivo — quem decide entre os dois é `retry.ts`).
 *
 * Regras (conservadoras de propósito):
 *  - cancelamento e erro de transporte ⇒ `null`;
 *  - só `BrokerError`; 401/404/422/5xx ⇒ `null` mesmo que o texto cite "quota";
 *  - códigos do broker (janela/semanal/orçamento/crédito) e 402 ⇒ cota;
 *  - texto inequívoco ("insufficient_quota", "credit balance is too low"…) em 400/402/
 *    403/429 ⇒ cota (a Anthropic devolve o saldo zerado como 400);
 *  - 429 sem mais pistas ⇒ `taxa` (rate-limit). Quem chega aqui já passou pelo retry
 *    curto, ou não tem retry (sub-agentes).
 */
export function classifyQuota(err: unknown, nowMs: number): QuotaVerdict | null {
  if (err instanceof ModelCallAbortedError || err instanceof BrokerTransportError) return null;
  if (!(err instanceof BrokerError)) return null;
  const status = err.status;
  const text = `${err.message} ${err.problem.title ?? ''} ${err.problem.type ?? ''}`;
  const resetFromError =
    err.resetAtMs ??
    (err.retryAfter !== undefined ? nowMs + err.retryAfter * 1000 : undefined) ??
    resetAtFromMessage(text, nowMs);
  const resetAtMs = clampReset(resetFromError, nowMs);

  const mk = (scope: QuotaScope): QuotaVerdict => ({
    scope,
    resetAtMs,
    reason: `${quotaScopeLabel(scope)} (HTTP ${status})`,
  });

  switch (err.code) {
    case 'USAGE_WINDOW_EXHAUSTED':
      return mk('janela');
    case 'WEEKLY_CAP_EXHAUSTED':
      return mk('semanal');
    case 'BUDGET_EXHAUSTED':
      return mk('orcamento');
    case 'INSUFFICIENT_CREDIT':
      return mk('credito');
    default:
      break;
  }
  if (status === 402) return mk('credito');
  if (status === 401 || status === 404 || status === 422 || status >= 500) return null;
  if ((status === 400 || status === 403 || status === 429) && STRONG_QUOTA_TEXT.test(text)) {
    return mk(WEEKLY_TEXT.test(text) ? 'semanal' : WINDOW_TEXT.test(text) ? 'janela' : 'credito');
  }
  if (status === 429) return mk('taxa');
  return null;
}

/**
 * O retry CURTO (`retry.ts`) deve DESISTIR deste erro e deixar a pausa assumir? Sim para
 * toda cota que não é rate-limit curto: esperar 5s × 20 não faz a janela de 5h abrir.
 * Rate-limit (`taxa`) só passa para a pausa se o reset informado passa do limite do retry.
 */
export function exceedsShortRetry(err: unknown, nowMs: number): boolean {
  const v = classifyQuota(err, nowMs);
  if (v === null) return false;
  if (v.scope !== 'taxa') return true;
  return v.resetAtMs !== undefined && v.resetAtMs - nowMs > SHORT_RETRY_LIMIT_MS;
}

// ── sondagem quando não há horário ───────────────────────────────────────────

/** Escada de espera entre sondagens sem horário de reset: 1m, 2m, 5m, 10m, 15m, 30m… */
export const PROBE_LADDER_MS: readonly number[] = [
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
];

/** Espera até a sondagem de índice `n` (0-based); satura no último degrau. */
export function probeDelayMs(n: number): number {
  const i = Math.max(0, Math.min(n, PROBE_LADDER_MS.length - 1));
  return PROBE_LADDER_MS[i]!;
}

// ── configuração ─────────────────────────────────────────────────────────────

/** Espera total máxima default por episódio de pausa (6h) — anti-runaway (CLI-SEC-8). */
export const DEFAULT_QUOTA_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
/** Teto duro configurável (7 dias, o teto semanal). */
export const MAX_QUOTA_MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/** Config RESOLVIDA da pausa por cota. `enabled:false` ⇒ comportamento antigo (falha). */
export interface QuotaPauseConfig {
  readonly enabled: boolean;
  /** Espera total máxima por episódio; estourou ⇒ "parar salvando" automático. */
  readonly maxWaitMs: number;
}

export const QUOTA_PAUSE_OFF: QuotaPauseConfig = {
  enabled: false,
  maxWaitMs: DEFAULT_QUOTA_MAX_WAIT_MS,
};

/**
 * Duração de config/env: número puro = MINUTOS; sufixos `s|m|h|d` ("90m", "6h", "2d").
 * Inválido/≤0 ⇒ `undefined`. Clampada em [1 min, 7 dias]. PURO.
 */
export function parseMaxWait(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  let ms: number | undefined;
  if (typeof raw === 'number') ms = Number.isFinite(raw) ? raw * 60_000 : undefined;
  else {
    const s = raw.trim().toLowerCase();
    ms = /^\d+(\.\d+)?$/.test(s) ? Number(s) * 60_000 : parseDurationMs(s);
  }
  if (ms === undefined || !(ms > 0)) return undefined;
  return Math.min(MAX_QUOTA_MAX_WAIT_MS, Math.max(60_000, Math.round(ms)));
}

/**
 * Resolve a config a partir de env > config > default (mesma precedência dos outros
 * tunables). DEFAULT = LIGADO: pausar é estritamente melhor que morrer, e tem teto de
 * espera. `ALUY_QUOTA_PAUSE=off|0|false` volta ao comportamento antigo.
 * `ALUY_QUOTA_MAX_WAIT` = espera total máxima (minutos, ou `90m`/`6h`/`2d`).
 */
export function resolveQuotaPause(inputs: {
  readonly pauseEnv?: string | undefined;
  readonly maxWaitEnv?: string | undefined;
  readonly pauseConfig?: boolean | undefined;
  readonly maxWaitConfig?: string | number | undefined;
}): QuotaPauseConfig {
  const raw = (inputs.pauseEnv ?? '').trim().toLowerCase();
  const maxWaitMs =
    parseMaxWait(inputs.maxWaitEnv) ??
    parseMaxWait(inputs.maxWaitConfig) ??
    DEFAULT_QUOTA_MAX_WAIT_MS;
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') {
    return { enabled: false, maxWaitMs };
  }
  if (raw === '' && inputs.pauseConfig === false) return { enabled: false, maxWaitMs };
  return { enabled: true, maxWaitMs };
}
