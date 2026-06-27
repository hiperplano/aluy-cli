// EST-0948 · ADR-0069 — QUOTA da PRÓPRIA conta do CLI vinda do BROKER, p/ o footer.
// (CLI-SEC-7: o broker é a fonte AUTORITATIVA; o CLI só LÊ e mostra, NUNCA calcula/
// ajusta quota — HG-3/HG-4).
//
// FONTES REAIS (broker#59 / ADR-0069 — confirmadas ao vivo no broker `:8121`):
//   • `GET /v1/quota` (path B, on-demand/boot/refresh) ⇒ corpo
//        `{ windows:[ {period:"5h"|"week", limit, used, remaining, reset_at} ],
//           credit:{ balance:"42.118000"|null } }`.
//     Parse: `parseQuotaResponse`.  ← a fonte do CRÉDITO (dimensão PRIMÁRIA do CLI).
//   • evento `usage` do `/v1/chat` (path A, loop quente, sem request extra) ⇒ campos
//     ACHATADOS `quota_5h_{used,limit,remaining,reset_at}` + `quota_week_*` (STRING; a
//     janela inteira OMITIDA quando ilimitada). Parse: `parseQuotaFromUsage`.
//   Tokens vêm como STRING decimal (paridade com `/v1/usage`); `limit`/`remaining`/
//   `reset_at` = `null` ⇒ janela ILIMITADA (o CLI esconde aquela janela).
//
// ADR-0069 (aceito/APR-0074): o footer do CLI expõe a dimensão CRÉDITO como controle
// PRIMÁRIO (saldo pay-per-use, ledger ADR-0038, hard-cap 402) — NÃO a janela 5h+semanal
// do app (ADR-0051), que estoura em minutos sob um loop agêntico (ADR-0053 §4). As
// janelas, quando o broker as reporta, são MOSTRADAS; em dev/PAT sem janela ⇒ omitidas.
//
// LEGADO (header-based — `parseQuotaHeaders`/`parseQuotaBody`): o broker NÃO emite esses
// headers no `/v1/chat` (entregou `GET /v1/quota` dedicado, broker#59). Mantidos só por
// compat/tolerância (um broker futuro PODERIA usá-los) — não são a fonte ativa do CLI.
//
// Este módulo é PORTÁVEL e PURO (sem Ink/IO):
//   • `parseQuotaResponse` / `parseQuotaFromUsage` — as fontes REAIS (tolerantes).
//   • `formatQuota` / `formatResetIn` — display puro/testável (a TUI só pinta).
//   • `serverWindowLimit` — o limite SERVER-DRIVEN (§4) quando a janela tem teto.
//
// IMPORTANTE (CLI-SEC-7 — binário público limpo): NÃO há aqui limite/markup/ledger
// hardcoded. Tudo é o que o BROKER reportou no momento; ausente ⇒ degrada (oculto).

/** Nomes EXATOS dos headers combinados com o broker (case-insensitive na leitura). */
export const QUOTA_HEADERS = {
  fiveHourUsed: 'x-aluy-quota-5h-used',
  fiveHourLimit: 'x-aluy-quota-5h-limit',
  fiveHourResetAt: 'x-aluy-quota-5h-resetat',
  weekUsed: 'x-aluy-quota-week-used',
  weekLimit: 'x-aluy-quota-week-limit',
  weekResetAt: 'x-aluy-quota-week-resetat',
} as const;

/**
 * Uma janela de quota: usado/limite (tokens) + instante de reset. `used`+`limit` (com
 * `limit > 0`) são o mínimo p/ a janela existir (sem teto não há % — descartada). O
 * `resetAt` é OPCIONAL (tolerante: o broker normalmente o manda pareado ao `limit`, mas
 * um broker que o omitisse ⇒ mostra a % sem o "reseta em").
 * `resetAt` é epoch em MILISSEGUNDOS (normalizado no parse — ISO ou epoch-seg).
 */
export interface QuotaWindow {
  readonly used: number;
  readonly limit: number;
  /** Epoch em ms do reset desta janela (UTC). Ausente ⇒ sem "reseta em" a mostrar. */
  readonly resetAt?: number;
}

/** O saldo de CRÉDITO da PRÓPRIA conta (dimensão PRIMÁRIA do footer — ADR-0069). */
export interface QuotaCredit {
  /**
   * Saldo de crédito como STRING decimal (`"42.118000"`), repassado VERBATIM do broker
   * (HG-3/HG-4: o CLI não recalcula). Ausente quando o broker manda `null` (crédito
   * desligado / billing fora / conta não materializada) ⇒ crédito oculto no footer.
   */
  readonly balance?: string;
}

/**
 * A quota corrente do usuário (o que o footer mostra). Cada janela é OPCIONAL: o
 * broker pode mandar só uma (degrada por janela). `credit` é a dimensão PRIMÁRIA do
 * CLI (ADR-0069) — surfaçada do `GET /v1/quota`. Quota inteira ausente ⇒ o chamador
 * usa `undefined` (footer NÃO renderiza — zero ruído).
 */
export interface Quota {
  readonly windows: {
    readonly fiveHour?: QuotaWindow;
    readonly week?: QuotaWindow;
  };
  /** Saldo de crédito (dimensão PRIMÁRIA — ADR-0069). Ausente ⇒ crédito não mostrado. */
  readonly credit?: QuotaCredit;
}

/** Leitor mínimo de headers (subset do WHATWG `Headers`). Case-insensitive. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Lê a quota dos HEADERS do response do broker (PRIMÁRIO). TOLERANTE:
 *   • header ausente/inválido ⇒ a janela some (campo omitido);
 *   • NENHUMA janela válida ⇒ devolve `undefined` (degrada — footer oculto);
 *   • NUNCA lança: rede = boundary não-confiável (CLI-SEC-4).
 *
 * Uma janela só conta se `used` E `limit` E `resetAt` forem todos parseáveis e
 * `limit > 0` (sem `limit` não há % — descarta a janela em vez de mostrar lixo).
 */
export function parseQuotaHeaders(headers: HeaderReader): Quota | undefined {
  const fiveHour = readWindow(
    headers,
    QUOTA_HEADERS.fiveHourUsed,
    QUOTA_HEADERS.fiveHourLimit,
    QUOTA_HEADERS.fiveHourResetAt,
  );
  const week = readWindow(
    headers,
    QUOTA_HEADERS.weekUsed,
    QUOTA_HEADERS.weekLimit,
    QUOTA_HEADERS.weekResetAt,
  );
  if (fiveHour === undefined && week === undefined) return undefined;
  return {
    windows: {
      ...(fiveHour !== undefined ? { fiveHour } : {}),
      ...(week !== undefined ? { week } : {}),
    },
  };
}

/**
 * Lê a quota do CORPO do evento `done` (FALLBACK — campo `quota`). Mesmo contrato
 * tolerante do header. Aceita as duas formas combinadas:
 *   { quota: { fiveHour|"5h": {used,limit,resetAt}, week: {...} } }
 * Headers são primários: o chamador só usa isto se os headers não vieram.
 */
export function parseQuotaBody(payload: unknown): Quota | undefined {
  if (!isRecord(payload)) return undefined;
  const q = payload['quota'];
  if (!isRecord(q)) return undefined;
  const windows = isRecord(q['windows']) ? (q['windows'] as Record<string, unknown>) : q;
  const fiveHour = windowFromObject(windows['fiveHour'] ?? windows['5h']);
  const week = windowFromObject(windows['week'] ?? windows['weekly']);
  if (fiveHour === undefined && week === undefined) return undefined;
  return {
    windows: {
      ...(fiveHour !== undefined ? { fiveHour } : {}),
      ...(week !== undefined ? { week } : {}),
    },
  };
}

// ── PARSE das FONTES REAIS (ADR-0069 / broker#59) ────────────────────────────

/**
 * Parseia o corpo do `GET /v1/quota` (path B do ADR-0069) — a fonte do CRÉDITO + as
 * janelas on-demand. Contrato REAL:
 *   `{ windows:[ {period, limit, used, remaining, reset_at} ], credit:{ balance } }`.
 * TOLERANTE (rede = boundary, CLI-SEC-4 — NUNCA lança):
 *   • `windows` ausente/não-array ⇒ sem janelas; window sem `period`/sem teto ⇒ descartada
 *     (janela ILIMITADA = `limit:null` ⇒ não há % a mostrar — coerente com o display);
 *   • `period` mapeado: `5h`→`fiveHour`, `week`/`weekly`→`week`; outro ⇒ ignorado;
 *   • `credit.balance` ausente/`null`/vazio ⇒ crédito omitido;
 *   • corpo não-objeto ⇒ `undefined` (o chamador não muda o estado).
 *
 * Resultado SEM janela com teto E sem crédito ⇒ `{windows:{}}` (footer oculto via
 * `formatQuota`), distinto de `undefined` ("não consegui ler"). O estado dev real
 * (`{windows:[], credit:{balance:null}}`) cai aqui ⇒ footer OCULTO (degrada — §3).
 */
export function parseQuotaResponse(body: unknown): Quota | undefined {
  if (!isRecord(body)) return undefined;
  const { fiveHour, week } = windowsFromArray(body['windows']);
  const credit = creditFromObject(body['credit']);
  return {
    windows: {
      ...(fiveHour !== undefined ? { fiveHour } : {}),
      ...(week !== undefined ? { week } : {}),
    },
    ...(credit !== undefined ? { credit } : {}),
  };
}

/**
 * Extrai a quota dos campos ACHATADOS do evento `usage` (path A do ADR-0069):
 * `quota_5h_{used,limit,remaining,reset_at}` + `quota_week_*` (STRING; janela inteira
 * OMITIDA quando ilimitada). NÃO há crédito no `usage` (o saldo vem do `balance_after`,
 * já modelado em `ServerLimits`/`ModelUsage`, e do `GET /v1/quota`).
 *
 * `undefined` quando NENHUMA janela COM TETO veio (o chamador NÃO sobrescreve a quota
 * corrente — preserva o crédito que o boot/`/v1/quota` trouxe). Só conta janela com
 * `limit > 0` (sem teto não há % — paridade com o display e com `parseQuotaResponse`).
 */
export function parseQuotaFromUsage(payload: unknown): Quota | undefined {
  if (!isRecord(payload)) return undefined;
  const fiveHour = windowFromUsagePrefix(payload, 'quota_5h');
  const week = windowFromUsagePrefix(payload, 'quota_week');
  if (fiveHour === undefined && week === undefined) return undefined;
  return {
    windows: {
      ...(fiveHour !== undefined ? { fiveHour } : {}),
      ...(week !== undefined ? { week } : {}),
    },
  };
}

/**
 * Monta uma janela das FONTES REAIS: `used`+`limit` (com `limit > 0`) são o mínimo; o
 * `resetAt` é OPCIONAL (tolerante — campo a menos degrada mostrando a % sem o "reseta
 * em"). `limit` ausente/`null` (janela ilimitada) ⇒ `undefined` (sem % ⇒ descartada).
 */
function windowWithOptionalReset(
  used: number | undefined,
  limit: number | undefined,
  resetAt: number | undefined,
): QuotaWindow | undefined {
  if (limit === undefined || limit <= 0) return undefined;
  return {
    used: Math.max(0, used ?? 0),
    limit,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

/** `{windows:[...]}` do `GET /v1/quota` → as duas janelas tipadas (só as com teto). */
function windowsFromArray(raw: unknown): {
  fiveHour?: QuotaWindow;
  week?: QuotaWindow;
} {
  if (!Array.isArray(raw)) return {};
  const out: { fiveHour?: QuotaWindow; week?: QuotaWindow } = {};
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const period = nonEmptyStr(entry['period']);
    if (period === undefined) continue;
    const window = windowWithOptionalReset(
      toInt(entry['used']),
      toInt(entry['limit']),
      toEpochMs(entry['reset_at'] ?? entry['resetAt']),
    );
    if (window === undefined) continue; // janela ilimitada (limit null) ⇒ sem % ⇒ descarta
    if (period === '5h') out.fiveHour = window;
    else if (period === 'week' || period === 'weekly') out.week = window;
  }
  return out;
}

/** Os campos `quota_<prefix>_{used,limit,reset_at}` do `usage` → `QuotaWindow` com teto. */
function windowFromUsagePrefix(
  payload: Record<string, unknown>,
  prefix: string,
): QuotaWindow | undefined {
  return windowWithOptionalReset(
    toInt(payload[`${prefix}_used`]),
    toInt(payload[`${prefix}_limit`]),
    toEpochMs(payload[`${prefix}_reset_at`]),
  );
}

/** `{ balance }` do `GET /v1/quota` → `QuotaCredit`. Ausente/`null`/vazio ⇒ undefined. */
function creditFromObject(raw: unknown): QuotaCredit | undefined {
  if (!isRecord(raw)) return undefined;
  const balance = nonEmptyStr(raw['balance']);
  return balance !== undefined ? { balance } : undefined;
}

function readWindow(
  headers: HeaderReader,
  usedKey: string,
  limitKey: string,
  resetKey: string,
): QuotaWindow | undefined {
  const used = toInt(headers.get(usedKey));
  const limit = toInt(headers.get(limitKey));
  const resetAt = toEpochMs(headers.get(resetKey));
  return assembleWindow(used, limit, resetAt);
}

function windowFromObject(v: unknown): QuotaWindow | undefined {
  if (!isRecord(v)) return undefined;
  const used = toInt(v['used']);
  const limit = toInt(v['limit']);
  const resetAt = toEpochMs(v['resetAt'] ?? v['reset_at']);
  return assembleWindow(used, limit, resetAt);
}

/** Uma janela só vale com used+limit+reset válidos e `limit > 0` (senão % é lixo). */
function assembleWindow(
  used: number | undefined,
  limit: number | undefined,
  resetAt: number | undefined,
): QuotaWindow | undefined {
  if (used === undefined || limit === undefined || resetAt === undefined) return undefined;
  if (limit <= 0) return undefined;
  return { used: Math.max(0, used), limit, resetAt };
}

// ── boundary parsers (rede/JSON = unknown; tolerante, nunca lança) ───────────

/** Inteiro ≥ 0 a partir de string/número; `undefined` se `null`/vazio/não-finito. */
function toInt(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const s = typeof v === 'number' ? v : String(v).trim();
  if (s === '') return undefined;
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
}

/** String não-vazia (após trim) ou `undefined` (`null`/não-string/vazio). */
function nonEmptyStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s;
}

/**
 * Normaliza `resetAt` p/ epoch em MS. Aceita:
 *   • ISO-8601 (`2026-06-09T12:00:00Z`) → `Date.parse`;
 *   • epoch em SEGUNDOS (inteiro "pequeno", < 1e12) → ×1000;
 *   • epoch em MS (≥ 1e12) → como está.
 * Inválido ⇒ `undefined`.
 */
export function toEpochMs(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return numToEpochMs(v);
  const s = String(v).trim();
  if (s === '') return undefined;
  // Numérico puro ⇒ epoch (seg ou ms). Caso contrário, tenta ISO.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? numToEpochMs(n) : undefined;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numToEpochMs(n: number): number | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // < 1e12 ⇒ segundos (até ~ano 33658 em seg); ≥ 1e12 ⇒ já em ms.
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

// ── LIMITE SERVER-DRIVEN (§4) ────────────────────────────────────────────────

/** A janela de um período, se presente (`5h`/`week`). Helper de busca. */
export function findWindow(
  quota: Quota | undefined,
  period: '5h' | 'week',
): QuotaWindow | undefined {
  if (quota === undefined) return undefined;
  return period === '5h' ? quota.windows.fiveHour : quota.windows.week;
}

/**
 * O limite REAL/AUTORITATIVO de uma janela quando o broker o reportou (§4 do DoD /
 * ADR-0069: "o limite de verdade vem DAQUI"). Devolve `{limit, remaining}` quando a
 * janela existe (toda `QuotaWindow` aqui já tem teto — janela ilimitada foi descartada
 * no parse); `undefined` ⇒ não há janela com teto ⇒ o chamador cai no fail-safe LOCAL
 * (`DEFAULT_MAX_TOKENS`, dimensão SEPARADA anti-runaway — NÃO a quota de produto).
 *
 * `remaining` = o do broker (`limit - used`, saneado p/ ≥ 0).
 */
export function serverWindowLimit(
  w: QuotaWindow | undefined,
): { readonly limit: number; readonly remaining: number } | undefined {
  if (w === undefined || w.limit <= 0) return undefined;
  return { limit: w.limit, remaining: Math.max(0, w.limit - w.used) };
}

// ── display puro (a TUI só PINTA o resultado destas funções) ─────────────────

/** % usado (0–100, inteiro) de uma janela. `used/limit` arredondado p/ baixo. */
export function windowPct(w: QuotaWindow): number {
  if (w.limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((w.used / w.limit) * 100)));
}

/**
 * Formata o tempo até o reset de forma compacta e estável:
 *   • ≥ 1h  → `2h13` (horas + minutos com 2 dígitos);
 *   • < 1h  → `45min`;
 *   • ≤ 0   → `agora` (já resetou / no limite).
 * `now` injetável p/ teste (default `Date.now()`).
 */
export function formatResetIn(resetAtMs: number, now: number = Date.now()): string {
  const deltaMs = resetAtMs - now;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 'agora';
  const totalMin = Math.floor(deltaMs / 60_000);
  if (totalMin < 1) return 'agora';
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours === 0) return `${mins}min`;
  return `${hours}h${String(mins).padStart(2, '0')}`;
}

/** Um segmento já formatado de uma janela (rótulo + % + nível de cor). */
export interface QuotaSegment {
  /** `5h` ou `semana`. */
  readonly label: string;
  /** % usado (0–100). */
  readonly pct: number;
  /** Nível de aviso p/ a cor: `ok` < 70% · `warn` 70–89% · `crit` ≥ 90%. */
  readonly level: QuotaLevel;
}

export type QuotaLevel = 'ok' | 'warn' | 'crit';

/** Limiares de cor (consistentes com o aviso de 70% do budget local — §4). */
export const QUOTA_WARN_PCT = 70;
export const QUOTA_CRIT_PCT = 90;

export function quotaLevel(pct: number): QuotaLevel {
  if (pct >= QUOTA_CRIT_PCT) return 'crit';
  if (pct >= QUOTA_WARN_PCT) return 'warn';
  return 'ok';
}

/**
 * O modelo de VIEW do footer de quota — DADO puro p/ a TUI montar (sem string crua
 * espalhada): os segmentos de JANELA presentes (5h e/ou semana) + o CRÉDITO (dimensão
 * PRIMÁRIA — ADR-0069) + o texto de reset da primeira janela, e o nível MÁXIMO.
 *
 * `undefined` quando NÃO há nenhuma janela NEM crédito ⇒ a TUI NÃO renderiza (degrada/
 * oculto). É o caso do estado dev real (`windows:[]`, `balance:null`) ⇒ footer escondido.
 */
export interface QuotaFooterView {
  readonly segments: readonly QuotaSegment[];
  /** Saldo de crédito (`"42.118000"`) — dimensão PRIMÁRIA. `undefined` ⇒ não mostra. */
  readonly creditBalance?: string;
  /**
   * Texto "reseta em 2h13" / "reseta agora" da janela 5h (ou semana). `undefined`
   * quando NÃO há janela (caso CLI típico: só crédito, sem janela ⇒ sem reset a mostrar).
   */
  readonly resetText?: string;
  readonly maxLevel: QuotaLevel;
}

/**
 * Monta a VIEW do footer a partir da quota. Mostra:
 *   • o CRÉDITO (saldo) quando presente — dimensão PRIMÁRIA do CLI (ADR-0069);
 *   • cada janela presente como `5h: 42%` + o reset da que "aperta" primeiro (5h).
 * `undefined` (footer OCULTO) quando NÃO há crédito NEM janela — ex.: o estado dev
 * `{windows:[], balance:null}` ⇒ esconde (degrada — §3). `now` injetável p/ teste.
 */
export function formatQuota(
  quota: Quota | undefined,
  now: number = Date.now(),
): QuotaFooterView | undefined {
  if (quota === undefined) return undefined;
  const segments: QuotaSegment[] = [];
  let resetSource: QuotaWindow | undefined;
  let maxLevel: QuotaLevel = 'ok';

  const push = (label: string, w: QuotaWindow | undefined): void => {
    if (w === undefined) return;
    const pct = windowPct(w);
    const level = quotaLevel(pct);
    segments.push({ label, pct, level });
    // Reset mostrado é o da PRIMEIRA janela que TEM reset (5h "aperta" primeiro).
    if (resetSource === undefined && w.resetAt !== undefined) resetSource = w;
    maxLevel = maxOfLevel(maxLevel, level);
  };

  push('5h', quota.windows.fiveHour);
  push('semana', quota.windows.week);

  const creditBalance = quota.credit?.balance;

  // OCULTO: nenhuma janela E nenhum crédito ⇒ footer não renderiza (degrada).
  if (segments.length === 0 && creditBalance === undefined) return undefined;

  const resetText =
    resetSource?.resetAt !== undefined
      ? formatResetIn(resetSource.resetAt, now) === 'agora'
        ? 'reseta agora'
        : `reseta em ${formatResetIn(resetSource.resetAt, now)}`
      : undefined;

  return {
    segments,
    ...(creditBalance !== undefined ? { creditBalance } : {}),
    ...(resetText !== undefined ? { resetText } : {}),
    maxLevel,
  };
}

const LEVEL_ORDER: Readonly<Record<QuotaLevel, number>> = { ok: 0, warn: 1, crit: 2 };
function maxOfLevel(a: QuotaLevel, b: QuotaLevel): QuotaLevel {
  return LEVEL_ORDER[b] > LEVEL_ORDER[a] ? b : a;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
