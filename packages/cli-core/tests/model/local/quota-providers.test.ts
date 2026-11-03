// PAUSA POR COTA — tabela por provider do catálogo local: resposta de erro (status +
// headers + corpo representativos) → classificação (cota/sabor/horário de reset/manual) ou
// "não é cota". Cada linha diz se o formato foi VERIFICADO na doc oficial ou é SUPOSTO
// (ver docs/pausa-por-cota.md). O caminho é o real: LocalModelClient → BrokerError → classifyQuota.
import { describe, expect, it } from 'vitest';
import { LocalModelClient } from '../../../src/model/local/local-client.js';
import { OpenAiCompatAdapter } from '../../../src/model/local/openai-adapter.js';
import { BrokerError } from '../../../src/model/errors.js';
import {
  classifyQuota,
  exceedsShortRetry,
  type QuotaScope,
} from '../../../src/model/quota-pause.js';
import type { ModelCallRequest, ModelStreamEvent } from '../../../src/model/types.js';
import { makeBrokerFetch } from '../helpers.js';

const req = (): ModelCallRequest => ({
  tier: 'aluy-flux',
  messages: [{ role: 'user', content: 'Oi' }],
});
async function drain(gen: AsyncGenerator<ModelStreamEvent>): Promise<void> {
  for await (const _ of gen) void _;
}

async function errorOf(
  provider: string,
  baseUrl: string,
  status: number,
  json: unknown,
  headers: Record<string, string> = {},
): Promise<BrokerError> {
  const { fetch } = makeBrokerFetch({ status, json, headers });
  const client = new LocalModelClient({
    adapter: new OpenAiCompatAdapter({ provider, defaultBaseUrl: baseUrl }),
    config: { provider, model: 'm' },
    baseUrl,
    getCredential: async () => ({ kind: 'apikey', secret: 'sk' }),
    fetch,
  });
  const e = await drain(client.stream({ request: req() })).catch((x) => x);
  return e as BrokerError;
}

/** "YYYY-MM-DD" e "HH:MM" em UTC, daqui a `ms`. */
function utcParts(ms: number): { d: string; t: string } {
  const iso = new Date(Date.now() + ms).toISOString();
  return { d: iso.slice(0, 10), t: iso.slice(11, 16) };
}

const MIN = 60_000;
const H = 3_600_000;
const DAY = 24 * H;

interface Row {
  readonly name: string;
  readonly provider: string;
  readonly baseUrl?: string;
  readonly status: number;
  readonly headers?: () => Record<string, string>;
  readonly body: () => unknown;
  /** `null` = NÃO é cota. */
  readonly scope: QuotaScope | null;
  readonly manual?: boolean;
  /** Reset esperado a partir de agora (±2 min); `'none'` = sem horário. */
  readonly resetIn?: number | 'none';
  /** O retry curto deve cuidar (rate-limit curto)? Default: depende do escopo. */
  readonly shortRetry?: boolean;
  readonly verified: boolean;
}

const rows: readonly Row[] = [
  // ── OpenAI ────────────────────────────────────────────────────────────────
  {
    name: 'openai · 429 insufficient_quota (saldo)',
    provider: 'openai',
    status: 429,
    body: () => ({
      error: {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    }),
    scope: 'credito',
    manual: true,
    resetIn: 'none',
    verified: true,
  },
  {
    name: 'openai · 429 credit_balance_exhausted',
    provider: 'openai',
    status: 429,
    body: () => ({
      error: { message: 'Billing hard limit', type: 'x', code: 'credit_balance_exhausted' },
    }),
    scope: 'credito',
    manual: true,
    verified: true,
  },
  {
    name: 'openai · 429 organization_spend_limit_exceeded',
    provider: 'openai',
    status: 429,
    body: () => ({ error: { message: 'limit', code: 'organization_spend_limit_exceeded' } }),
    scope: 'credito',
    manual: true,
    verified: true,
  },
  {
    name: 'openai · 429 rate limit curto (reset-requests 1s)',
    provider: 'openai',
    status: 429,
    headers: () => ({ 'x-ratelimit-reset-requests': '1s' }),
    body: () => ({
      error: {
        message: 'Rate limit reached for requests',
        type: 'requests',
        code: 'rate_limit_exceeded',
      },
    }),
    scope: 'taxa',
    resetIn: 1000,
    shortRetry: true,
    verified: false, // corpo/header exatos: formato conhecido, exemplo não confirmado na doc atual
  },
  {
    name: 'openai · 429 rate limit longo (reset-tokens 6m0s)',
    provider: 'openai',
    status: 429,
    headers: () => ({ 'x-ratelimit-reset-tokens': '6m0s' }),
    body: () => ({
      error: { message: 'Rate limit reached', type: 'tokens', code: 'rate_limit_exceeded' },
    }),
    scope: 'taxa',
    resetIn: 6 * MIN,
    shortRetry: false,
    verified: false,
  },
  // ── Anthropic ─────────────────────────────────────────────────────────────
  {
    name: 'anthropic · 429 teto de gasto mensal (enforced_spend_limit_reached)',
    provider: 'anthropic',
    status: 429,
    body: () => {
      const { d } = utcParts(2 * DAY);
      return {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: `You have reached your API usage limits: your organization has crossed its monthly API usage threshold. You will regain access on ${d} at 00:00 UTC.`,
          details: { error_code: 'enforced_spend_limit_reached' },
        },
      };
    },
    scope: 'orcamento',
    manual: false,
    resetIn: 'none', // preenchido abaixo (data absoluta 00:00 UTC, 1–3 dias)
    verified: true,
  },
  {
    name: 'anthropic · 400 limite de gasto próprio',
    provider: 'anthropic',
    status: 400,
    body: () => {
      const { d } = utcParts(3 * DAY);
      return {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `You have reached your specified API usage limits. You will regain access on ${d} at 00:00 UTC.`,
        },
      };
    },
    scope: 'orcamento',
    manual: false,
    verified: true, // texto inicial documentado; a frase de retomada é a mesma do 429 (suposto)
  },
  {
    name: 'anthropic · 400 saldo de créditos baixo',
    provider: 'anthropic',
    status: 400,
    body: () => ({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message:
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      },
    }),
    scope: 'credito',
    manual: true,
    verified: false, // mensagem conhecida da prática; a doc atual só cita 402 billing_error
  },
  {
    name: 'anthropic · 402 billing_error',
    provider: 'anthropic',
    status: 402,
    body: () => ({ type: 'error', error: { type: 'billing_error', message: 'billing issue' } }),
    scope: 'credito',
    manual: true,
    verified: true,
  },
  {
    name: 'anthropic · 429 rate_limit_error com retry-after 30 e reset RFC 3339',
    provider: 'anthropic',
    status: 429,
    headers: () => ({
      'retry-after': '30',
      'anthropic-ratelimit-tokens-reset': new Date(Date.now() + 25_000).toISOString(),
    }),
    body: () => ({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Number of request tokens has exceeded your per-minute rate limit',
      },
    }),
    scope: 'taxa',
    resetIn: 30_000,
    shortRetry: true,
    verified: true,
  },
  // ── DeepSeek ──────────────────────────────────────────────────────────────
  {
    name: 'deepseek · 402 Insufficient Balance',
    provider: 'deepseek',
    status: 402,
    body: () => ({
      error: {
        message: 'Insufficient Balance',
        type: 'unknown_error',
        code: 'invalid_request_error',
      },
    }),
    scope: 'credito',
    manual: true,
    verified: true,
  },
  {
    name: 'deepseek · 429 rate limit',
    provider: 'deepseek',
    status: 429,
    body: () => ({ error: { message: 'Rate Limit Reached', type: 'rate_limit_reached' } }),
    scope: 'taxa',
    shortRetry: true,
    verified: true,
  },
  // ── Google (Gemini) ───────────────────────────────────────────────────────
  {
    name: 'google · 429 RESOURCE_EXHAUSTED com RetryInfo 27s (por minuto)',
    provider: 'google',
    status: 429,
    body: () => [
      {
        error: {
          code: 429,
          message: 'You exceeded your current quota, please check your plan and billing details.',
          status: 'RESOURCE_EXHAUSTED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }],
            },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '27s' },
          ],
        },
      },
    ],
    scope: 'taxa',
    resetIn: 27_000,
    shortRetry: true,
    verified: false, // doc oficial não mostra o corpo; formato confirmado em fóruns do Google AI
  },
  {
    name: 'google · 429 cota DIÁRIA (PerDay) com retryDelay enganoso de 1s',
    provider: 'google',
    status: 429,
    body: () => ({
      error: {
        code: 429,
        message: 'You exceeded your current quota.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' },
        ],
      },
    }),
    scope: 'janela',
    manual: false,
    resetIn: 'none',
    verified: false,
  },
  {
    name: 'google · 429 RetryInfo longo (10 min)',
    provider: 'google',
    status: 429,
    body: () => ({
      error: {
        code: 429,
        message: 'Quota exceeded',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '600s' }],
      },
    }),
    scope: 'taxa',
    resetIn: 10 * MIN,
    shortRetry: false,
    verified: false,
  },
  // ── Groq ──────────────────────────────────────────────────────────────────
  {
    name: 'groq · 429 tokens por dia (TPD) com "try again in 9m38.4s"',
    provider: 'groq',
    status: 429,
    headers: () => ({ 'retry-after': '579' }),
    body: () => ({
      error: {
        message:
          'Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 100000, Used 97050, Requested 3619. Please try again in 9m38.4s.',
        type: 'tokens',
        code: 'rate_limit_exceeded',
      },
    }),
    scope: 'janela',
    resetIn: 579_000,
    verified: false, // Retry-After e durações "2m59.56s" verificados; corpo vem de issue de terceiros
  },
  {
    name: 'groq · 429 por minuto com x-ratelimit-reset-tokens 7.66s',
    provider: 'groq',
    status: 429,
    headers: () => ({ 'x-ratelimit-reset-tokens': '7.66s', 'x-ratelimit-reset-requests': '2.5s' }),
    body: () => ({
      error: {
        message: 'Rate limit reached on tokens per minute (TPM)',
        type: 'tokens',
        code: 'rate_limit_exceeded',
      },
    }),
    scope: 'taxa',
    resetIn: 7660,
    shortRetry: true,
    verified: true, // formato de duração do header verificado na doc
  },
  // ── Mistral ───────────────────────────────────────────────────────────────
  {
    name: 'mistral · 429 com Retry-After 60',
    provider: 'mistral',
    status: 429,
    headers: () => ({ 'retry-after': '60' }),
    body: () => ({
      object: 'error',
      message: 'Rate limit exceeded',
      type: 'rate_limit_error',
      param: null,
      code: null,
    }),
    scope: 'taxa',
    resetIn: 60_000,
    shortRetry: true,
    verified: true,
  },
  {
    name: 'mistral · 402 pagamento (saldo/limite de gasto)',
    provider: 'mistral',
    status: 402,
    body: () => ({
      object: 'error',
      message: 'Payment required: prepaid balance is zero',
      type: 'invalid_request_error',
    }),
    scope: 'credito',
    manual: true,
    verified: true, // status e causas na doc; texto do corpo é ilustrativo
  },
  // ── OpenRouter ────────────────────────────────────────────────────────────
  {
    name: 'openrouter · 402 créditos insuficientes',
    provider: 'openrouter',
    status: 402,
    body: () => ({
      error: {
        code: 402,
        message: 'Insufficient credits. Add more using https://openrouter.ai/credits',
      },
    }),
    scope: 'credito',
    manual: true,
    verified: true,
  },
  {
    name: 'openrouter · 429 limite diário de modelos :free (X-RateLimit-Reset em ms)',
    provider: 'openrouter',
    status: 429,
    headers: () => ({ 'x-ratelimit-reset': String(Date.now() + 5 * H) }),
    body: () => ({
      error: {
        code: 429,
        message: 'Rate limit exceeded: free-models-per-day',
        metadata: { error_type: 'rate_limit_exceeded' },
      },
    }),
    scope: 'janela',
    resetIn: 5 * H,
    verified: false, // unidade do header não documentada (13 dígitos em log de terceiros)
  },
  {
    name: 'openrouter · 429 curto com Retry-After 5',
    provider: 'openrouter',
    status: 429,
    headers: () => ({ 'retry-after': '5' }),
    body: () => ({
      error: {
        code: 429,
        message: 'Rate limit exceeded',
        metadata: { error_type: 'rate_limit_exceeded' },
      },
    }),
    scope: 'taxa',
    resetIn: 5000,
    shortRetry: true,
    verified: true,
  },
  // ── xAI ───────────────────────────────────────────────────────────────────
  {
    name: 'xai · 429 rate limit',
    provider: 'xai',
    status: 429,
    body: () => ({ error: 'Too many requests' }),
    scope: 'taxa',
    shortRetry: true,
    verified: true, // só o 429 é documentado
  },
  {
    name: 'xai · 403 créditos esgotados / limite de gasto',
    provider: 'xai',
    status: 403,
    body: () => ({
      code: 'The caller does not have permission to execute the specified operation',
      error:
        'Your team has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.',
    }),
    scope: 'credito',
    manual: true,
    verified: false, // 403 por saldo vem de guias de terceiros, não da doc da xAI
  },
  // ── Ollama ────────────────────────────────────────────────────────────────
  {
    name: 'ollama (local) · 429 nunca é cota',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    status: 429,
    body: () => ({ error: { message: 'too many requests' } }),
    scope: null,
    verified: true, // local não tem cota (decisão de design: loopback = sem pausa)
  },
  {
    name: 'ollama (local) · 503 servidor ocupado não é cota',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    status: 503,
    body: () => ({ error: { message: 'server busy, please try again' } }),
    scope: null,
    verified: true,
  },
  {
    name: 'ollama cloud · 429 limite semanal/de sessão (formato NÃO verificado)',
    provider: 'ollama',
    baseUrl: 'https://ollama.com/v1',
    status: 429,
    body: () => ({ error: 'you have reached your weekly usage limit, upgrade for more usage' }),
    scope: 'semanal',
    verified: false, // doc oficial não descreve o erro; casado por texto genérico
  },
  // ── Z.ai (geral) e GLM Coding Plan ────────────────────────────────────────
  {
    name: 'zai · 429 código 1113 saldo insuficiente',
    provider: 'zai',
    status: 429,
    body: () => ({
      error: {
        code: '1113',
        message: 'Insufficient balance or no resource package. Please recharge.',
      },
    }),
    scope: 'credito',
    manual: true,
    verified: true,
  },
  {
    name: 'zai-coding · 429 código 1308 janela de 5h com horário',
    provider: 'zai-coding',
    status: 429,
    body: () => {
      // a Z.ai escreve a hora de Pequim (UTC+8) sem fuso
      const t = new Date(Date.now() + 2 * H + 8 * H).toISOString();
      return {
        error: {
          code: '1308',
          message: `Usage limit reached for 5 hour. Your limit will reset at ${t.slice(0, 10)} ${t.slice(11, 19)}`,
        },
      };
    },
    scope: 'janela',
    resetIn: 2 * H,
    verified: true, // código verificado; formato da mensagem vem da descrição do dono (UTC+8 suposto)
  },
  {
    name: 'zai-coding · 429 código 1310 limite semanal/mensal',
    provider: 'zai-coding',
    status: 429,
    body: () => ({
      error: {
        code: '1310',
        message: 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2099-01-01 00:00:00',
      },
    }),
    scope: 'semanal',
    verified: true,
  },
  {
    name: 'zai-coding · 429 código 1316 janela + saldo insuficiente p/ uso extra',
    provider: 'zai-coding',
    status: 429,
    body: () => ({
      error: {
        code: '1316',
        message: '5-hour limit reached; insufficient balance for extra usage',
      },
    }),
    scope: 'janela',
    verified: true,
  },
  {
    name: 'zai-coding · 429 código 1309 plano expirado',
    provider: 'zai-coding',
    status: 429,
    body: () => ({ error: { code: '1309', message: 'GLM Coding Plan has expired, please renew' } }),
    scope: 'credito',
    manual: true,
    verified: true,
  },
  {
    name: 'zai-coding · 429 código 1302 rate limit',
    provider: 'zai-coding',
    status: 429,
    body: () => ({ error: { code: '1302', message: 'Request rate limit reached' } }),
    scope: 'taxa',
    shortRetry: true,
    verified: true,
  },
  {
    name: 'zai-coding · 429 código 1311 plano sem o modelo NÃO é cota',
    provider: 'zai-coding',
    status: 429,
    body: () => ({ error: { code: '1311', message: 'plan does not include this model' } }),
    scope: null,
    verified: true,
  },
  {
    name: 'zai-coding · 400 código 1301 conteúdo sinalizado NÃO é cota',
    provider: 'zai-coding',
    status: 400,
    body: () => ({ error: { code: '1301', message: 'unsafe content' } }),
    scope: null,
    verified: true,
  },
  // ── falhas definitivas em qualquer provider ───────────────────────────────
  ...(
    ['openai', 'anthropic', 'deepseek', 'google', 'groq', 'mistral', 'openrouter', 'xai'] as const
  ).flatMap((provider): Row[] => [
    {
      name: `${provider} · 401 chave inválida NÃO é cota`,
      provider,
      status: 401,
      body: () => ({ error: { message: 'Invalid API key (quota)', type: 'authentication_error' } }),
      scope: null,
      verified: true,
    },
    {
      name: `${provider} · 404 modelo inexistente NÃO é cota`,
      provider,
      status: 404,
      body: () => ({ error: { message: 'model not found' } }),
      scope: null,
      verified: true,
    },
  ]),
];

describe('PAUSA POR COTA · tabela por provider (resposta real → classificação)', () => {
  it.each(rows.map((r) => [r.name, r] as const))('%s', async (_name, r) => {
    const baseUrl = r.baseUrl ?? 'https://api.example.test/v1';
    const err = await errorOf(r.provider, baseUrl, r.status, r.body(), r.headers?.() ?? {});
    expect(err).toBeInstanceOf(BrokerError);
    const now = Date.now();
    const v = classifyQuota(err, now);
    if (r.scope === null) {
      expect(v).toBeNull();
      return;
    }
    expect(v?.scope).toBe(r.scope);
    if (r.manual !== undefined) expect(v?.manual).toBe(r.manual);
    if (typeof r.resetIn === 'number') {
      expect(v?.resetAtMs).toBeDefined();
      expect(Math.abs(v!.resetAtMs! - (now + r.resetIn))).toBeLessThan(2 * MIN);
    } else if (r.resetIn === 'none') {
      // (Anthropic usa data absoluta — coberta no teste dedicado abaixo)
      if (r.provider !== 'anthropic') expect(v?.resetAtMs).toBeUndefined();
    }
    if (r.shortRetry !== undefined) expect(exceedsShortRetry(err, now)).toBe(!r.shortRetry);
  });

  it('Anthropic: "regain access on <data> at 00:00 UTC" vira o horário de reset (429 e 400)', async () => {
    for (const status of [429, 400]) {
      const { d } = utcParts(2 * DAY);
      const err = await errorOf('anthropic', 'https://api.anthropic.com/v1', status, {
        type: 'error',
        error: {
          type: status === 429 ? 'rate_limit_error' : 'invalid_request_error',
          message:
            status === 429
              ? `You have reached your API usage limits. You will regain access on ${d} at 00:00 UTC.`
              : `You have reached your specified API usage limits. You will regain access on ${d} at 00:00 UTC.`,
          ...(status === 429 ? { details: { error_code: 'enforced_spend_limit_reached' } } : {}),
        },
      });
      const v = classifyQuota(err, Date.now());
      expect(v?.scope).toBe('orcamento');
      expect(v?.resetAtMs).toBe(Date.parse(`${d}T00:00:00Z`));
      expect(v?.manual).toBe(false);
    }
  });

  it('OpenRouter: X-RateLimit-Reset em ms (13 dígitos) e em s (10 dígitos) dão o mesmo instante', async () => {
    const at = Date.now() + 2 * H;
    const ms = await errorOf(
      'openrouter',
      'https://openrouter.ai/api/v1',
      429,
      { error: { message: 'x' } },
      { 'x-ratelimit-reset': String(at) },
    );
    const sec = await errorOf(
      'openrouter',
      'https://openrouter.ai/api/v1',
      429,
      { error: { message: 'x' } },
      { 'x-ratelimit-reset': String(Math.round(at / 1000)) },
    );
    expect(Math.abs(ms.resetAtMs! - sec.resetAtMs!)).toBeLessThan(1000);
  });

  it('a tabela cobre todos os providers do catálogo local', () => {
    const covered = new Set(rows.map((r) => r.provider));
    for (const id of [
      'anthropic',
      'deepseek',
      'google',
      'groq',
      'mistral',
      'ollama',
      'openai',
      'openrouter',
      'xai',
      'zai',
      'zai-coding',
    ]) {
      expect(covered.has(id), id).toBe(true);
    }
  });
});
