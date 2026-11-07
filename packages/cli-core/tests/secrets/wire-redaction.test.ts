// ADR 0005 — último ponto antes do FIO: nenhum valor do cofre sai no corpo da requisição ao
// provedor, mesmo que o dono tenha colado o valor no chat ou um comando o tenha impresso.

import { afterEach, describe, expect, it } from 'vitest';
import { BrokerModelClient } from '../../src/model/broker-client.js';
import { OpenAiCompatAdapter } from '../../src/model/local/openai-adapter.js';
import { AnthropicAdapter } from '../../src/model/local/anthropic-adapter.js';
import { SECRET_REDACTED, secretVault } from '../../src/index.js';
import { makeBrokerFetch, sseBody } from '../model/helpers.js';

const CANARY = 'ZIMBRO-canario-7f3a91c2e8';
afterEach(() => secretVault.clear());

describe('corpo da requisição', () => {
  it('BrokerModelClient: mensagem com o valor sai redigida (cru e escapado)', async () => {
    secretVault.set('API_KEY', CANARY);
    const { fetch, calls } = makeBrokerFetch({
      status: 200,
      sse: sseBody([{ event: 'done', data: { finish_reason: 'stop' } }]),
    });
    const client = new BrokerModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'tok',
      fetch,
    });
    for await (const _ of client.stream({
      request: {
        tier: 'aluy-strata',
        messages: [
          { role: 'user', content: `minha chave é ${CANARY}` },
          { role: 'assistant', content: `ok "${CANARY}"` },
        ],
      },
    }))
      void _;
    const corpo = JSON.stringify(calls[0]?.body);
    expect(corpo).not.toContain(CANARY);
    expect(corpo).toContain(SECRET_REDACTED);
  });

  it('adaptadores BYO (openai-compat e anthropic) também redigem', () => {
    secretVault.set('API_KEY', CANARY);
    const credential = { kind: 'apikey', apiKey: 'k' } as never;
    const request = {
      model: 'm',
      maxTokens: 10,
      system: 'sys',
      messages: [{ role: 'user', content: `valor ${CANARY}` }],
    } as never;
    const adapters = [
      new OpenAiCompatAdapter({ provider: 'x', defaultBaseUrl: 'https://x.test/v1' } as never),
      new AnthropicAdapter(),
    ];
    for (const adapter of adapters) {
      const built = adapter.buildRequest({ request, baseUrl: 'https://x.test/v1', credential });
      expect(built.body).not.toContain(CANARY);
      expect(built.body).toContain(SECRET_REDACTED);
    }
  });
});
