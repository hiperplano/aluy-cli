// ADR-0118 / EST-1118 — CATÁLOGO de providers LOCAIS como DADO (config-driven).
//
// Espelha o ADR-0076 (provider = DADO que aponta p/ um adapter = código) no lado
// LOCAL/BYO (ADR-0120). Hoje o catálogo local estava HARDCODED em 5 lugares
// (`LocalProviderKind` fechado, `DEFAULT_MODEL_BY_PROVIDER`, `DEFAULT_BASE_URL`,
// `adapterFor`, e as 3 constantes do `aluy models`). Aqui ele vira DADO:
//   - um catálogo default EMBUTIDO (shipped, PURO) com os principais providers/modelos;
//   - merge com o override do usuário (carregado pelo `@hiperplano/aluy-cli` de `~/.aluy/providers.json`).
//
// FRONTEIRA (ADR-0053 §8): este módulo é PURO — só tipos, o DADO embutido e funções de
// merge/sanitize de objetos já parseados. NÃO toca disco/rede (o `readFileSync` do
// `providers.json` mora no `@hiperplano/aluy-cli`; o anti-SSRF do `base_url` roda no uso, na factory).
//
// CLI-SEC-7: o catálogo carrega SÓ nomes/slugs/`base_url` PÚBLICOS — NUNCA uma chave. O
// `auth:'apikey'` só diz QUAL via; o segredo vem do keychain/env por provider (ADR-0120).
//
// O `wireFormat` escolhe o ADAPTER (código, fechado por release): os 3 formatos de fio
// cobrem ~todos os vendors. Adicionar um vendor `openai-compat` = só DADO, ZERO código.

/** Formato de fio (protocolo) — escolhe o ADAPTER de código. Fechado por release. */
export type WireFormat = 'openai-compat' | 'anthropic' | 'gemini';

/** Modo de auth que um provider aceita. `none` = sem credencial (ex.: Ollama local). */
export type LocalAuthMode = 'apikey' | 'oauth' | 'none';

/** Onda de rollout/curadoria (display) — NÃO é gate de runtime. */
export type ProviderWave = 1 | 2 | 3;

/**
 * Uma entrada do catálogo de providers LOCAIS. É DADO público (CLI-SEC-7):
 * nome/slug/base_url/modelos — nunca credencial. O `wireFormat` aponta p/ o adapter
 * (código); o `baseUrl` passa pelo anti-SSRF no uso (PROV-SEC-1).
 */
export interface LocalProviderEntry {
  /** Slug do provider (ex.: `deepseek`). CHAVE de merge com o override do usuário. */
  readonly id: string;
  /** Nome de display (ex.: `DeepSeek`). */
  readonly label: string;
  /** Protocolo de fio ⇒ escolhe o adapter de código (`openai-compat`/`anthropic`/`gemini`). */
  readonly wireFormat: WireFormat;
  /** Endpoint público (https). Override por `~/.aluy/providers.json`/flag/env, sempre anti-SSRF. */
  readonly baseUrl: string;
  /** Modo(s) de auth aceitos (não-vazio; ordem = preferência de display). */
  readonly auth: readonly LocalAuthMode[];
  /** Modelo default (id nativo do provider). */
  readonly defaultModel: string;
  /** Slugs dos modelos principais (display/discovery). Pode ser vazio. */
  readonly models: readonly string[];
  /** Onda de curadoria (display). Ausente ⇒ tratado como cauda. */
  readonly wave?: ProviderWave;
  /** Pista de catálogo VIVO (ex.: OpenRouter tem centenas) — display, URL pública. */
  readonly catalogHint?: string;
  /** Nota livre (display). */
  readonly notes?: string;
}

/** O catálogo carregado e resolvido (default embutido + override do usuário mesclado). */
export interface LocalProviderCatalog {
  /** As entradas, ordenadas (wave asc, depois id asc) — determinístico. */
  readonly entries: readonly LocalProviderEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// CATÁLOGO DEFAULT EMBUTIDO (shipped) — ADR-0118 §4. Reproduz EXATAMENTE os defaults
// hardcoded de hoje (anthropic/openai/openrouter) p/ não-regressão, e estende.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ENTRIES: readonly LocalProviderEntry[] = [
  // ── Onda 1 — caminho quente do dogfood (provado) ──────────────────────────
  {
    id: 'anthropic',
    label: 'Anthropic',
    wireFormat: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    auth: ['apikey', 'oauth'],
    defaultModel: 'claude-opus-4-8',
    models: ['claude-opus-4-8', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
    wave: 1,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    wireFormat: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    auth: ['apikey', 'oauth'],
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini', 'o4-mini'],
    wave: 1,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    wireFormat: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    auth: ['apikey'],
    defaultModel: 'anthropic/claude-3.5-sonnet',
    models: [
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o',
      'google/gemini-2.0-flash',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat',
    ],
    wave: 1,
    catalogHint: 'centenas via OpenRouter (veja o catálogo público do provider)',
  },
  // ── Onda 2 — vendors OpenAI-compatible diretos / Gemini ───────────────────
  {
    id: 'google',
    label: 'Google Gemini',
    wireFormat: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    auth: ['apikey'],
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-1.5-pro'],
    wave: 2,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    wireFormat: 'openai-compat',
    baseUrl: 'https://api.deepseek.com',
    auth: ['apikey'],
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    wave: 2,
  },
  {
    id: 'groq',
    label: 'Groq',
    wireFormat: 'openai-compat',
    baseUrl: 'https://api.groq.com/openai/v1',
    auth: ['apikey'],
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    wave: 2,
  },
  {
    id: 'mistral',
    label: 'Mistral',
    wireFormat: 'openai-compat',
    baseUrl: 'https://api.mistral.ai/v1',
    auth: ['apikey'],
    defaultModel: 'mistral-large-latest',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    wave: 2,
  },
  // ── Onda 3 — cauda / local ────────────────────────────────────────────────
  {
    id: 'xai',
    label: 'xAI (Grok)',
    wireFormat: 'openai-compat',
    baseUrl: 'https://api.x.ai/v1',
    auth: ['apikey'],
    defaultModel: 'grok-2-latest',
    models: ['grok-2-latest', 'grok-2-vision-latest'],
    wave: 3,
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    wireFormat: 'openai-compat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    auth: ['none'],
    defaultModel: 'llama3.2',
    models: ['llama3.2', 'qwen2.5-coder', 'deepseek-r1'],
    wave: 3,
    notes: 'roda local; sem credencial (auth none). O egress local ainda é pinado/validado.',
  },
];

/**
 * O catálogo default EMBUTIDO. É a FONTE única dos defaults locais — tudo que era
 * constante hardcoded (default model, base_url, auth modes, catalog hint) deriva DAQUI.
 * PURO; sem I/O. Já ordenado.
 */
export function defaultLocalCatalog(): LocalProviderCatalog {
  return { entries: sortEntries(DEFAULT_ENTRIES) };
}

// ─────────────────────────────────────────────────────────────────────────────
// SANITIZE de UMA entrada vinda do JSON do usuário (DADO NÃO-confiável). Espelha o
// `sanitize` do UserConfigStore: descarta campo/entrada inválida, NUNCA lança.
// ─────────────────────────────────────────────────────────────────────────────

/** Teto defensivo p/ strings (anti arquivo gigante adulterado). */
const MAX_STR = 256;
/** Teto de modelos listados por entrada (display). */
const MAX_MODELS = 200;

const WIRE_FORMATS: readonly WireFormat[] = ['openai-compat', 'anthropic', 'gemini'];
const AUTH_MODES: readonly LocalAuthMode[] = ['apikey', 'oauth', 'none'];

/** Caractere de controle (C0 + DEL) — sinal de arquivo adulterado. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;

/** String razoável: não-vazia, curta, sem caractere de controle. PURO. */
function okStr(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t === '' || t.length > MAX_STR) return false;
  return !CONTROL_CHAR.test(t);
}

/** Normaliza a lista de `auth` (string única OU array). Inválidos descartados. PURO. */
function parseAuth(raw: unknown): readonly LocalAuthMode[] | undefined {
  const arr = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  const out: LocalAuthMode[] = [];
  for (const v of arr) {
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase();
      if ((AUTH_MODES as readonly string[]).includes(t) && !out.includes(t as LocalAuthMode)) {
        out.push(t as LocalAuthMode);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Normaliza a lista de `models` (descarta itens inválidos, dedup, teto). PURO. */
function parseModels(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (okStr(v)) {
      const t = v.trim();
      if (!out.includes(t)) out.push(t);
    }
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

function parseWave(raw: unknown): ProviderWave | undefined {
  return raw === 1 || raw === 2 || raw === 3 ? raw : undefined;
}

/**
 * Saneia UM objeto cru (do JSON do usuário) p/ uma `LocalProviderEntry` válida, ou
 * `undefined` se inválida (entrada some, as demais valem — fail-soft). Exige os campos
 * OBRIGATÓRIOS mínimos: `id`, `wireFormat` conhecido, `baseUrl`, `auth` não-vazio,
 * `defaultModel`. `label` ausente ⇒ usa o `id`. PURO; NUNCA lança.
 */
export function sanitizeEntry(raw: unknown): LocalProviderEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (!okStr(o.id)) return undefined;
  const id = o.id.trim();
  if (!okStr(o.wireFormat)) return undefined;
  const wireFormat = o.wireFormat.trim().toLowerCase();
  if (!(WIRE_FORMATS as readonly string[]).includes(wireFormat)) return undefined;
  if (!okStr(o.baseUrl)) return undefined;
  const auth = parseAuth(o.auth);
  if (auth === undefined) return undefined;
  if (!okStr(o.defaultModel)) return undefined;

  const label = okStr(o.label) ? o.label.trim() : id;
  const entry: {
    id: string;
    label: string;
    wireFormat: WireFormat;
    baseUrl: string;
    auth: readonly LocalAuthMode[];
    defaultModel: string;
    models: readonly string[];
    wave?: ProviderWave;
    catalogHint?: string;
    notes?: string;
  } = {
    id,
    label,
    wireFormat: wireFormat as WireFormat,
    baseUrl: o.baseUrl.trim(),
    auth,
    defaultModel: o.defaultModel.trim(),
    models: parseModels(o.models),
  };
  const wave = parseWave(o.wave);
  if (wave !== undefined) entry.wave = wave;
  if (okStr(o.catalogHint)) entry.catalogHint = o.catalogHint.trim();
  if (okStr(o.notes)) entry.notes = o.notes.trim();
  return entry;
}

/**
 * Saneia uma lista crua (o `providers.json` do usuário) p/ entradas válidas. Aceita
 * tanto `LocalProviderEntry[]` quanto `{ providers: LocalProviderEntry[] }` (mais
 * amigável p/ editar à mão). Entradas inválidas/duplicadas (por `id`) são descartadas;
 * a ÚLTIMA por `id` vence (consistente com o merge). PURO; NUNCA lança.
 */
export function sanitizeUserEntries(raw: unknown): readonly LocalProviderEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' &&
        raw !== null &&
        Array.isArray((raw as Record<string, unknown>).providers)
      ? ((raw as Record<string, unknown>).providers as unknown[])
      : [];
  const byId = new Map<string, LocalProviderEntry>();
  for (const item of list) {
    const entry = sanitizeEntry(item);
    if (entry !== undefined) byId.set(entry.id, entry); // última por id vence
  }
  return [...byId.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE: override do usuário sobre o default embutido (por `id`). PURO.
// ─────────────────────────────────────────────────────────────────────────────

/** Ordem determinística: wave asc (ausente=99), depois id asc. PURO. */
function sortEntries(entries: readonly LocalProviderEntry[]): readonly LocalProviderEntry[] {
  return [...entries].sort((a, b) => {
    const wa = a.wave ?? 99;
    const wb = b.wave ?? 99;
    if (wa !== wb) return wa - wb;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Mescla o catálogo: as entradas do usuário SOBREPÕEM (por `id`) e ESTENDEM (novos `id`)
 * o default embutido. O override de um `id` existente SUBSTITUI a entrada inteira (o
 * usuário declarou a forma completa via `sanitizeUserEntries`). Resultado ordenado.
 * PURO; sem I/O.
 */
export function mergeLocalCatalog(
  base: LocalProviderCatalog,
  userEntries: readonly LocalProviderEntry[],
): LocalProviderCatalog {
  const byId = new Map<string, LocalProviderEntry>();
  for (const e of base.entries) byId.set(e.id, e);
  for (const e of userEntries) byId.set(e.id, e); // usuário sobrepõe/estende
  return { entries: sortEntries([...byId.values()]) };
}

/**
 * Açúcar: monta o catálogo EFETIVO a partir do DADO cru do `providers.json` do usuário
 * (já lido pelo locus). `userRaw` ausente/inválido ⇒ só o default embutido (fail-soft).
 * PURO; o locus faz o I/O e passa o objeto parseado.
 */
export function buildLocalCatalog(userRaw?: unknown): LocalProviderCatalog {
  const base = defaultLocalCatalog();
  if (userRaw === undefined || userRaw === null) return base;
  return mergeLocalCatalog(base, sanitizeUserEntries(userRaw));
}

/** Busca uma entrada por `id` (case-insensitive no `id`). `undefined` se ausente. PURO. */
export function findProvider(
  catalog: LocalProviderCatalog,
  id: string,
): LocalProviderEntry | undefined {
  const want = id.trim().toLowerCase();
  return catalog.entries.find((e) => e.id.toLowerCase() === want);
}
