// PAUSA POR COTA — o horário de reset chega ao BrokerError a partir dos headers do provider
// (backend LOCAL/BYO) e do broker.
import { describe, expect, it } from 'vitest';
import { LocalModelClient } from '../../../src/model/local/local-client.js';
import { OpenAiCompatAdapter } from '../../../src/model/local/openai-adapter.js';
import { BrokerModelClient } from '../../../src/model/broker-client.js';
import { BrokerError } from '../../../src/model/errors.js';
import { classifyQuota } from '../../../src/model/quota-pause.js';
import type { ModelCallRequest, ModelStreamEvent } from '../../../src/model/types.js';
import { makeBrokerFetch } from '../helpers.js';

const req = (): ModelCallRequest => ({
  tier: 'aluy-flux',
  messages: [{ role: 'user', content: 'Oi' }],
});
async function drain(gen: AsyncGenerator<ModelStreamEvent>): Promise<void> {
  for await (const _ of gen) void _;
}
const local = (fetch: ReturnType<typeof makeBrokerFetch>['fetch']): LocalModelClient =>
  new LocalModelClient({
    adapter: new OpenAiCompatAdapter({
      provider: 'openai',
      defaultBaseUrl: 'https://api.openai.com/v1',
    }),
    config: { provider: 'openai', model: 'gpt-4o' },
    baseUrl: 'https://api.openai.com/v1',
    getCredential: async () => ({ kind: 'apikey', secret: 'sk' }),
    fetch,
  });

describe('reset de cota a partir dos headers', () => {
  it('OpenAI 429 com x-ratelimit-reset-tokens vira resetAtMs', async () => {
    const { fetch } = makeBrokerFetch({
      status: 429,
      json: { error: { message: 'Rate limit reached', type: 'tokens' } },
      headers: { 'x-ratelimit-reset-tokens': '6m0s' },
    });
    const before = Date.now();
    const err = (await drain(local(fetch).stream({ request: req() })).catch(
      (e) => e,
    )) as BrokerError;
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.resetAtMs).toBeGreaterThanOrEqual(before + 360_000);
    expect(err.resetAtMs).toBeLessThanOrEqual(Date.now() + 360_000);
    const v = classifyQuota(err, Date.now());
    expect(v?.scope).toBe('taxa');
    expect(v?.resetAtMs).toBe(err.resetAtMs);
  });

  it('Anthropic: reset RFC 3339 em 429', async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const { fetch } = makeBrokerFetch({
      status: 429,
      json: { error: { message: 'rate limited' } },
      headers: { 'anthropic-ratelimit-tokens-reset': at },
    });
    const err = (await drain(local(fetch).stream({ request: req() })).catch(
      (e) => e,
    )) as BrokerError;
    expect(err.resetAtMs).toBe(Date.parse(at));
  });

  it('insufficient_quota (429 do OpenAI) é crédito; 401 não pausa', async () => {
    const quota = makeBrokerFetch({
      status: 429,
      json: { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } },
    });
    const e1 = (await drain(local(quota.fetch).stream({ request: req() })).catch(
      (e) => e,
    )) as BrokerError;
    expect(classifyQuota(e1, Date.now())?.scope).toBe('credito');
    const auth = makeBrokerFetch({ status: 401, json: { error: { message: 'bad key' } } });
    const e2 = (await drain(local(auth.fetch).stream({ request: req() })).catch(
      (e) => e,
    )) as BrokerError;
    expect(classifyQuota(e2, Date.now())).toBeNull();
  });

  it('broker 429 USAGE_WINDOW_EXHAUSTED com Retry-After', async () => {
    const { fetch } = makeBrokerFetch({
      status: 429,
      json: { status: 429, code: 'USAGE_WINDOW_EXHAUSTED' },
      headers: { 'retry-after': '1800' },
    });
    const client = new BrokerModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'jwt',
      fetch,
    });
    const err = (await drain(client.stream({ request: req() })).catch((e) => e)) as BrokerError;
    const v = classifyQuota(err, Date.now());
    expect(v?.scope).toBe('janela');
    expect(v!.resetAtMs! - Date.now()).toBeGreaterThan(1_790_000);
  });
});
