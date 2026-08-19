// F-UP — o FIO INTEIRO do roteamento de upstream: `providers[].upstreamByModel` (config
// do dono) → `LocalProviderConfig.upstreamByModel` → `LocalRequest.extraBody` → corpo da
// requisição. O `extra-body.test.ts` cobre a PONTA (o adapter mescla o fragmento); aqui o
// que se trava é o MEIO, que é onde a feature estava CORTADA: o mapa existia na config e
// o `extraBody` existia no adapter, e nada ligava um no outro — o dono declarava
// `upstreamByModel` e a requisição saía sem nada, EM SILÊNCIO.
import { describe, expect, it } from 'vitest';
import { LocalModelClient } from '../../../src/model/local/local-client.js';
import { OpenAiCompatAdapter } from '../../../src/model/local/openai-adapter.js';
import type { ModelCallRequest } from '../../../src/model/types.js';
import type { ResolvedCredential } from '../../../src/model/local/types.js';
import { makeBrokerFetch } from '../helpers.js';

const cred = async (): Promise<ResolvedCredential> => ({ kind: 'apikey', secret: 'sk' });

const GMI = { provider: { only: ['gmicloud'], allow_fallbacks: false } };

function run(over: {
  upstreamByModel?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  model?: string;
  request?: Partial<ModelCallRequest>;
}): Promise<Record<string, unknown>> {
  const { fetch, calls } = makeBrokerFetch({ status: 200, sse: 'data: [DONE]\n\n' });
  const client = new LocalModelClient({
    adapter: new OpenAiCompatAdapter({
      provider: 'openrouter',
      defaultBaseUrl: 'https://openrouter.ai/api/v1',
    }),
    config: {
      provider: 'openrouter',
      model: over.model ?? 'qwen/qwen3-27b',
      ...(over.upstreamByModel ? { upstreamByModel: over.upstreamByModel } : {}),
    },
    baseUrl: 'https://openrouter.ai/api/v1',
    getCredential: cred,
    fetch,
  });
  const request: ModelCallRequest = {
    tier: 'aluy-flux',
    messages: [{ role: 'user', content: 'Oi' }],
    ...over.request,
  };
  return (async () => {
    for await (const _ of client.stream({ request })) void _;
    return calls[0].body as Record<string, unknown>;
  })();
}

describe('F-UP — upstream declarado chega ao corpo da requisição', () => {
  it('slug ATIVO com fragmento declarado ⇒ o fragmento vai no corpo', async () => {
    const body = await run({ upstreamByModel: { 'qwen/qwen3-27b': GMI } });
    expect(body.provider).toEqual({ only: ['gmicloud'], allow_fallbacks: false });
  });

  it('SEM mapa nenhum ⇒ corpo intocado (não-regressão de quem nunca declarou upstream)', async () => {
    const body = await run({});
    expect(body).not.toHaveProperty('provider');
  });

  it('mapa presente mas SEM entrada p/ o slug ativo ⇒ nada é mandado (não inventa)', async () => {
    const body = await run({ upstreamByModel: { 'outro/modelo': GMI } });
    expect(body).not.toHaveProperty('provider');
  });

  // O ponto que obriga a consulta a ser POR REQUEST: `/model` troca o slug pelo caminho
  // `tier:'custom'` SEM reconstruir o client. Resolver o fragmento no boot congelaria o
  // roteamento do PRIMEIRO modelo em todos os seguintes — e o dono não veria nada.
  it('/model troca o slug no MESMO client ⇒ pega o fragmento do slug NOVO', async () => {
    const map = {
      'qwen/qwen3-27b': GMI,
      'deepseek/deepseek-v3': { provider: { only: ['deepinfra'] } },
    };
    const body = await run({
      upstreamByModel: map,
      request: { tier: 'custom', model: 'deepseek/deepseek-v3' },
    });
    expect(body.model).toBe('deepseek/deepseek-v3');
    expect(body.provider).toEqual({ only: ['deepinfra'] });
  });

  it('/model p/ um slug SEM entrada ⇒ para de mandar o fragmento do anterior', async () => {
    const body = await run({
      upstreamByModel: { 'qwen/qwen3-27b': GMI },
      request: { tier: 'custom', model: 'meta/llama-3' },
    });
    expect(body.model).toBe('meta/llama-3');
    expect(body).not.toHaveProperty('provider');
  });

  // O dono escreve o slug à mão no config; o provider o reporta como veio. Casar por
  // igualdade CRUA faria a declaração falhar em silêncio por uma maiúscula — MESMA
  // disciplina já usada pelo `contextByModel`.
  it('casa o slug case-insensitive e com espaço sobrando', async () => {
    const body = await run({ upstreamByModel: { '  QWEN/Qwen3-27B ': GMI } });
    expect(body.provider).toEqual({ only: ['gmicloud'], allow_fallbacks: false });
  });

  it('valor não-objeto no mapa ⇒ ignorado (fronteira com DADO de disco)', async () => {
    const body = await run({
      upstreamByModel: { 'qwen/qwen3-27b': ['nope'] as unknown as Record<string, unknown> },
    });
    expect(body).not.toHaveProperty('provider');
  });
});
