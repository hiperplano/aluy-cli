// ATIVIDADE DE STREAM — os clientes avisam cada evento recebido, para o heartbeat do
// sub-agente saber que a chamada está viva (relato do dono de 16/09: sub-agente morto por
// "travado" no fim de meia hora, com o modelo ainda respondendo).
import { describe, expect, it } from 'vitest';
import { BrokerModelClient } from '../../src/model/broker-client.js';
import { LocalModelClient } from '../../src/model/local/local-client.js';
import { OpenAiCompatAdapter } from '../../src/model/local/openai-adapter.js';
import { BrokerModelCaller } from '../../src/agent/model-caller.js';
import type { ModelClient, StreamCallArgs } from '../../src/model/broker-client.js';
import type { ModelCallRequest } from '../../src/model/types.js';
import { makeBrokerFetch, sseBody } from './helpers.js';

const req: ModelCallRequest = { tier: 'aluy-flux', messages: [{ role: 'user', content: 'Oi' }] };

describe('onActivity nos clientes de modelo', () => {
  it('BrokerModelClient.call avisa uma vez por evento do stream', async () => {
    const sse = sseBody([
      { event: 'start', data: { request_id: 'r1', tier: 'aluy-flux' } },
      { event: 'delta', data: { content: 'a' } },
      { event: 'delta', data: { content: 'b' } },
      { event: 'done', data: { finish_reason: 'stop' } },
    ]);
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new BrokerModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 't',
      fetch,
    });
    let n = 0;
    const r = await client.call({ request: req, onActivity: () => (n += 1) });
    expect(r.content).toBe('ab');
    expect(n).toBe(4);
  });

  it('LocalModelClient.call avisa a cada chunk do provider (inclusive raciocínio)', async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'hmm' } }] },
      { choices: [{ index: 0, delta: { reasoning_content: ' pensando' } }] },
      { choices: [{ index: 0, delta: { content: 'oi' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new LocalModelClient({
      adapter: new OpenAiCompatAdapter({
        provider: 'openai',
        defaultBaseUrl: 'https://api.openai.com/v1',
      }),
      config: { provider: 'openai', model: 'gpt-4o' },
      baseUrl: 'https://api.openai.com/v1',
      getCredential: async () => ({ kind: 'apikey', secret: 'sk' }),
      fetch,
    });
    let n = 0;
    const r = await client.call({ request: req, onActivity: () => (n += 1) });
    expect(r.content).toBe('oi');
    expect(n).toBeGreaterThanOrEqual(3); // os dois de raciocínio + a fala, no mínimo
  });

  it('BrokerModelCaller repassa o onActivity do loop ao cliente', async () => {
    let received: StreamCallArgs['onActivity'];
    const client: ModelClient = {
      async *stream() {},
      async call(args) {
        received = args.onActivity;
        args.onActivity?.();
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
      },
    };
    let n = 0;
    await new BrokerModelCaller({ client, tier: 'aluy-flux' }).call({
      messages: [{ role: 'user', content: 'x' }],
      idempotencyKey: 'k',
      onActivity: () => (n += 1),
    });
    expect(received).toBeTypeOf('function');
    expect(n).toBe(1);
  });
});
