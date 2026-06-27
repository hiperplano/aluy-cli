// EST-0948 (server-limits / FU-VAU-003 · ADR-0069) — a QUOTA DE PRODUTO do ator CLI/PAT
// vem do SERVER (broker), lida do evento `usage` do SSE (o MESMO canal que JÁ carrega
// `balance_after`).
//
// ─────────────────────────────────────────────────────────────────────────────
// A DISTINÇÃO QUE ESTE MÓDULO TORNA EXPLÍCITA (decisão do Tiago, cravada em ADR-0069):
//
//   (a) FAIL-SAFE ANTI-RUNAWAY  — LOCAL, legítimo no cliente (CLI-SEC-8).
//       `DEFAULT_MAX_TOKENS` (agora 10M, #116) + `MAX_TOKENS_CEILING` em
//       `agent/limits.ts`. Corta um LOOP que recursa/erra ANTES de floodar o broker.
//       NÃO some, NÃO depende do server. É o circuit-breaker do loop (o `◷`).
//
//   (b) QUOTA DE PRODUTO do CLI = dimensão CRÉDITO — AUTORITATIVA no broker (ADR-0069/
//       APR-0074, ledger ADR-0038). É o SALDO/CONSUMO pay-per-use da conta (hard-cap
//       402 ao zerar) — a ÚNICA dimensão que de fato BARRA o ator CLI. O cliente NÃO a
//       inventa — só LÊ o `balance_after` que o broker reporta. É o que este módulo
//       modela como CRÉDITO (`ServerLimits.balanceAfter`).
//
// ADR-0069 CRAVA: o footer do CLI mostra CRÉDITO, NÃO a janela 5h+semanal do app
// (ADR-0051) — essa estoura em minutos sob um loop agêntico (ADR-0053 §4). O fail-safe
// (a) e a quota (b) coexistem: (a) é o `◷` (token-budget local); (b) é o footer de
// crédito. AUSENTE o saldo legível ⇒ DEGRADA: omite o widget de crédito (não inventa).
//
// O subcampo `limits` (limit/used/period/resetAt) fica modelado e tolerante p/ um
// EVENTUAL `llm_budgets` técnico (ADR-0028), mas por ADR-0069 NÃO é a quota de produto
// do CLI nem hijacka o `◷` — o que governa o CLI é o crédito.
// ─────────────────────────────────────────────────────────────────────────────
//
// PORTÁVEL e PURO (sem Ink/IO): a TUI só PINTA o que sai daqui. TOLERANTE a ausência:
// campos opcionais; ausência = comportamento atual (CLI-SEC-4 — rede é boundary
// não-confiável, nunca lança). CLI-SEC-7: ZERO saldo/limite/markup/ledger hardcoded —
// tudo é o que o broker reportou no `usage`; ausente ⇒ undefined.

import type { ModelUsage, ServerLimitsPayload } from './types.js';
import { toEpochMs, formatResetIn } from './quota.js';

/** Unidade do limite do server: tokens (default) ou crédito. */
export type ServerLimitUnit = 'tokens' | 'credit';

/**
 * O limite/quota da conta normalizado a partir do `usage` do broker. TODO campo é
 * OPCIONAL (tolerante): a ausência de um campo = aquele aspecto indisponível, e a
 * ausência do objeto INTEIRO = "o server não informou" ⇒ o cliente usa o
 * comportamento atual (fail-safe local + footer oculto). NÃO confunde com o budget
 * LOCAL anti-runaway — este é a QUOTA DE PRODUTO (autoritativa no broker, SEC-19).
 */
export interface ServerLimits {
  /** Limite efetivo da janela/plano. `undefined` ⇒ o server não informou o teto. */
  readonly limit?: number;
  /** Já consumido na janela (quando informado, ou derivado de `limit - remaining`). */
  readonly used?: number;
  /** Restante na janela (informado, ou derivado de `limit - used`, ou de `balanceAfter`). */
  readonly remaining?: number;
  /** Unidade do `limit`/`used`/`remaining`. `tokens` quando omisso. */
  readonly unit?: ServerLimitUnit;
  /** Janela/plano da quota (`5h`/`day`/`week`/`month` — rótulo do broker). */
  readonly period?: string;
  /** Epoch em MS do reset da janela (normalizado de ISO/epoch-seg/epoch-ms). */
  readonly resetAt?: number;
  /**
   * Crédito RESTANTE da conta (de `balance_after`, que o broker JÁ manda). É moeda/
   * crédito, distinto de `remaining` (que pode ser de tokens). Surfaçado AGORA — o
   * aviso de saldo baixo não espera o campo `limits` novo. `undefined` ⇒ broker não
   * mandou saldo neste turno.
   */
  readonly balanceAfter?: number;
}

/**
 * Lê o `ServerLimits` do evento `usage` do broker. TOLERANTE em CAMADAS:
 *
 *   1. `balance_after` (JÁ existe no broker) ⇒ `balanceAfter` — surfaçado AGORA.
 *   2. `usage.limits` (campo NOVO, PEDIDO em FU-VAU-003) ⇒ `limit/used/remaining/
 *      unit/period/resetAt`. Ausente HOJE ⇒ esses campos ficam `undefined`.
 *
 * Devolve `undefined` SÓ quando NADA é aproveitável (sem saldo E sem `limits` válido)
 * ⇒ o chamador trata como "server não informou" (degrada p/ o fail-safe local). Se
 * AO MENOS o saldo veio, devolve um `ServerLimits` só com `balanceAfter`. NUNCA lança.
 */
export function parseServerLimits(usage: ModelUsage | undefined): ServerLimits | undefined {
  if (usage === undefined) return undefined;
  const balanceAfter = toNumber(usage.balance_after);
  const fromLimits = parseLimitsPayload(usage.limits);

  if (balanceAfter === undefined && fromLimits === undefined) return undefined;
  return {
    ...(fromLimits ?? {}),
    ...(balanceAfter !== undefined ? { balanceAfter } : {}),
  };
}

/** Normaliza o subcampo `limits` do `usage`. Tolerante; `undefined` se nada útil. */
function parseLimitsPayload(payload: ServerLimitsPayload | undefined): ServerLimits | undefined {
  if (payload === undefined || payload === null || typeof payload !== 'object') return undefined;
  const limit = toNonNegInt(payload.limit);
  let used = toNonNegInt(payload.used);
  let remaining = toNonNegInt(payload.remaining);
  const unit = normalizeUnit(payload.unit);
  const period = normalizePeriod(payload.period);
  const resetAt = toEpochMs(payload.reset_at);

  // Deriva o que faltar (mas só dá p/ derivar se `limit` veio): consistência interna.
  if (limit !== undefined) {
    if (remaining === undefined && used !== undefined) remaining = Math.max(0, limit - used);
    if (used === undefined && remaining !== undefined) used = Math.max(0, limit - remaining);
  }

  // Nada aproveitável ⇒ undefined (o chamador degrada).
  if (
    limit === undefined &&
    used === undefined &&
    remaining === undefined &&
    period === undefined &&
    resetAt === undefined
  ) {
    return undefined;
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(period !== undefined ? { period } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

/**
 * O TETO de tokens REAL p/ a sessão, dado o `ServerLimits`. É o ponto que separa a
 * QUOTA DE PRODUTO do FAIL-SAFE LOCAL: quando o server informa um `limit` em TOKENS,
 * é ELE o teto/aviso REAL (o número do server). `undefined` ⇒ o server não informou
 * um teto de tokens (sem `limit`, ou unidade de crédito) ⇒ o chamador MANTÉM o
 * fail-safe local (`DEFAULT_MAX_TOKENS`) como teto. NUNCA é o `DEFAULT_MAX_TOKENS`
 * (esse é o anti-runaway, vive em `agent/limits.ts`): aqui é SÓ o limite do server.
 */
export function serverTokenLimit(limits: ServerLimits | undefined): number | undefined {
  if (limits === undefined) return undefined;
  // Só tokens: um limite em CRÉDITO não é teto de tokens (o saldo vira aviso à parte).
  if (limits.unit === 'credit') return undefined;
  return limits.limit !== undefined && limits.limit > 0 ? limits.limit : undefined;
}

/** Nível de aviso (mesma escala do budget local e da quota: 70/90%). */
export type ServerLimitLevel = 'ok' | 'warn' | 'crit';

/** Limiares consistentes com `QUOTA_WARN_PCT`/`QUOTA_CRIT_PCT` e o budget local. */
export const SERVER_LIMIT_WARN_PCT = 70;
export const SERVER_LIMIT_CRIT_PCT = 90;

export function serverLimitLevel(pct: number): ServerLimitLevel {
  if (pct >= SERVER_LIMIT_CRIT_PCT) return 'crit';
  if (pct >= SERVER_LIMIT_WARN_PCT) return 'warn';
  return 'ok';
}

/**
 * % do limite do server JÁ consumido (0–100). Usa `used/limit`; se só houver
 * `remaining` e `limit`, deriva `(limit-remaining)/limit`. `undefined` quando não dá
 * p/ calcular (sem `limit`, ou `limit ≤ 0`). Display puro.
 */
export function serverUsedPct(limits: ServerLimits | undefined): number | undefined {
  if (limits === undefined || limits.limit === undefined || limits.limit <= 0) return undefined;
  const used =
    limits.used !== undefined
      ? limits.used
      : limits.remaining !== undefined
        ? Math.max(0, limits.limit - limits.remaining)
        : undefined;
  if (used === undefined) return undefined;
  return Math.min(100, Math.max(0, Math.floor((used / limits.limit) * 100)));
}

// ── crédito (balance_after) — surfaçado AGORA, sem o broker mudar nada ───────────

/**
 * Limiar de aviso de saldo BAIXO (crédito). Como o cliente NÃO sabe o saldo MÁXIMO
 * do plano (CLI-SEC-7 — sem ledger), não há um "%": o aviso é por VALOR ABSOLUTO
 * cruzando este piso. Conservador e visível sem ser barulhento. É display puro — não
 * toca a catraca nem o budget (o broker é quem BARRA de fato via 402/429, SEC-19).
 */
export const LOW_BALANCE_THRESHOLD = 1;

/**
 * O saldo está baixo? `true` quando há `balanceAfter` e ele caiu a `≤
 * LOW_BALANCE_THRESHOLD` (incl. 0/negativo). `false` quando não há saldo (não
 * inventa aviso) ou quando ainda há folga. Puro/testável.
 */
export function isLowBalance(
  limits: ServerLimits | undefined,
  threshold: number = LOW_BALANCE_THRESHOLD,
): boolean {
  if (limits === undefined || limits.balanceAfter === undefined) return false;
  return limits.balanceAfter <= threshold;
}

/** Formata o crédito p/ exibição (`1.2` → `1.2`; trunca ruído de float). `undefined` se ausente. */
export function formatBalance(limits: ServerLimits | undefined): string | undefined {
  if (limits === undefined || limits.balanceAfter === undefined) return undefined;
  const n = limits.balanceAfter;
  // Sem casas decimais espúrias: 2 casas no máx, sem zeros à direita.
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// ── view do FOOTER (server-limits) — a TUI só PINTA estes DADOS ───────────────────

/** Um segmento já formatado do footer de server-limits (rótulo + texto + nível). */
export interface ServerLimitSegment {
  /** Rótulo dim (`quota`/`<period>`/`crédito`). */
  readonly label: string;
  /** Valor já formatado (`42%`, `1.2`…). */
  readonly value: string;
  /** Nível de cor (ok/warn/crit). `ok` p/ o crédito quando há folga; `crit` quando baixo. */
  readonly level: ServerLimitLevel;
}

/**
 * A VIEW do footer de server-limits: os segmentos presentes (quota de tokens e/ou
 * crédito) + texto de reset (quando há `resetAt`). DEGRADA: `undefined` quando NÃO há
 * NADA aproveitável (nem % de quota, nem crédito) ⇒ a TUI NÃO renderiza (oculto, zero
 * ruído). NÃO inventa número — só mostra o que o server informou. `now` injetável.
 *
 * Distinto de `formatQuota` (janelas 5h/semana dos HEADERS): este vem do `usage` (o
 * canal do `balance_after`) e é o PRIMEIRO a acender com o `balance_after` que o
 * broker JÁ manda HOJE — o % de quota só aparece quando o broker entregar o `limits`.
 */
export interface ServerLimitsFooterView {
  readonly segments: readonly ServerLimitSegment[];
  /** "reseta em 2h13" da janela de quota (quando há `resetAt`); vazio se ausente. */
  readonly resetText?: string;
  readonly maxLevel: ServerLimitLevel;
}

export function formatServerLimits(
  limits: ServerLimits | undefined,
  now: number = Date.now(),
): ServerLimitsFooterView | undefined {
  if (limits === undefined) return undefined;
  const segments: ServerLimitSegment[] = [];
  let maxLevel: ServerLimitLevel = 'ok';

  // Quota de TOKENS (% usado) — só quando o server informou um `limit` de tokens.
  const pct = serverUsedPct(limits);
  if (pct !== undefined && serverTokenLimit(limits) !== undefined) {
    const level = serverLimitLevel(pct);
    const label = limits.period !== undefined ? limits.period : 'quota';
    segments.push({ label, value: `${pct}%`, level });
    maxLevel = maxLevelOf(maxLevel, level);
  }

  // CRÉDITO restante (`balance_after`) — surfaçado AGORA.
  const bal = formatBalance(limits);
  if (bal !== undefined) {
    const level: ServerLimitLevel = isLowBalance(limits) ? 'crit' : 'ok';
    segments.push({ label: 'crédito', value: bal, level });
    maxLevel = maxLevelOf(maxLevel, level);
  }

  if (segments.length === 0) return undefined;

  // Reset (quando houver) — só faz sentido com a janela de quota.
  let resetText: string | undefined;
  if (limits.resetAt !== undefined) {
    const reset = formatResetIn(limits.resetAt, now);
    resetText = reset === 'agora' ? 'reseta agora' : `reseta em ${reset}`;
  }

  return {
    segments,
    ...(resetText !== undefined ? { resetText } : {}),
    maxLevel,
  };
}

const SL_LEVEL_ORDER: Readonly<Record<ServerLimitLevel, number>> = { ok: 0, warn: 1, crit: 2 };
function maxLevelOf(a: ServerLimitLevel, b: ServerLimitLevel): ServerLimitLevel {
  return SL_LEVEL_ORDER[b] > SL_LEVEL_ORDER[a] ? b : a;
}

// ── boundary parsers (rede/JSON = unknown; tolerante, nunca lança) ───────────────

/** Número finito a partir de string/número (aceita decimais — crédito/moeda). `undefined` se inválido. */
function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : undefined;
}

/** Inteiro ≥ 0 a partir de string/número. `undefined` se inválido/negativo. */
function toNonNegInt(v: unknown): number | undefined {
  const n = toNumber(v);
  if (n === undefined || n < 0) return undefined;
  return Math.round(n);
}

/** Normaliza a unidade do limite. Reconhece `credit`; qualquer outra coisa = `tokens`. */
function normalizeUnit(v: unknown): ServerLimitUnit | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === 'credit' || s === 'credits' || s === 'currency') return 'credit';
  if (s === 'tokens' || s === 'token') return 'tokens';
  return undefined; // desconhecido ⇒ deixa o default (tokens) implícito no chamador.
}

/** Rótulo de período saneado (não-vazio, teto de tamanho p/ não poluir a UI). */
function normalizePeriod(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (s === '') return undefined;
  return s.length > 16 ? s.slice(0, 16) : s;
}
