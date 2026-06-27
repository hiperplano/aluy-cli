// ADR-0120 / EST-1113 — adapter ANTHROPIC-DIRECT (Messages API) + LocalModelClient.
import { describe, expect, it } from 'vitest';
import { LocalModelClient } from '../../../src/model/local/local-client.js';
import {
  AnthropicAdapter,
  toAnthropicMessages,
} from '../../../src/model/local/anthropic-adapter.js';
import type { ModelCallRequest, ModelStreamEvent } from '../../../src/model/types.js';
import type { ResolvedCredential } from '../../../src/model/local/types.js';
import { makeBrokerFetch, sseBody } from '../helpers.js';

const apiKey = async (): Promise<ResolvedCredential> => ({ kind: 'apikey', secret: 'sk-ant-xxx' });
const oauthTok = async (): Promise<ResolvedCredential> => ({ kind: 'oauth', secret: 'oat-yyy' });

function req(over: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return {
    tier: 'aluy-flux',
    messages: [
      { role: 'system', content: 'Você é útil.' },
      { role: 'user', content: 'Oi' },
    ],
    ...over,
  };
}

async function drain(gen: AsyncGenerator<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function client(opts: {
  fetch: ReturnType<typeof makeBrokerFetch>['fetch'];
  cred?: () => Promise<ResolvedCredential>;
}): LocalModelClient {
  return new LocalModelClient({
    adapter: new AnthropicAdapter(),
    config: {
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      auth: opts.cred === oauthTok ? 'oauth' : 'apikey',
    },
    baseUrl: 'https://api.anthropic.com',
    getCredential: opts.cred ?? apiKey,
    fetch: opts.fetch,
    maxTokens: 4096,
  });
}

const HAPPY = sseBody([
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: { id: 'msg_1', model: 'claude-opus-4-8', usage: { input_tokens: 10 } },
    },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Olá' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', mundo' } },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

describe('AnthropicAdapter — request building (Messages API)', () => {
  it('POSTa em /v1/messages com system SEPARADO, max_tokens, x-api-key + anthropic-version', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: HAPPY });
    await drain(client({ fetch }).stream({ request: req() }));
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.system).toBe('Você é útil.');
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: 'user', content: 'Oi' }]); // system NÃO entra em messages
    expect(calls[0]?.headers['x-api-key']).toBe('sk-ant-xxx');
    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]?.headers['authorization']).toBeUndefined(); // apikey ⇒ sem Bearer
  });

  it('via OAuth: Authorization Bearer + anthropic-beta, SEM x-api-key (ADR-0120)', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: HAPPY });
    await drain(client({ fetch, cred: oauthTok }).stream({ request: req() }));
    expect(calls[0]?.headers['authorization']).toBe('Bearer oat-yyy');
    expect(calls[0]?.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(calls[0]?.headers['x-api-key']).toBeUndefined();
  });

  it('mapeia o SSE Anthropic → delta+usage+done; agrega no call()', async () => {
    const { fetch } = makeBrokerFetch({ status: 200, sse: HAPPY });
    const result = await client({ fetch }).call({ request: req(), idempotencyKey: 'k1' });
    expect(result.content).toBe('Olá, mundo');
    expect(result.finish_reason).toBe('stop'); // end_turn → 'stop' (vocabulário do CLI)
    expect(result.usage?.tokens_in).toBe(10);
    expect(result.usage?.tokens_out).toBe(5);
    expect(result.usage?.provider).toBe('anthropic');
  });

  it('tool_use via input_json_delta vira tool_call; stop_reason tool_use → tool_calls', async () => {
    const sse = sseBody([
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: { id: 'm', model: 'c', usage: { input_tokens: 3 } },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'grep' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"q":' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"foo"}' },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 8 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const result = await client({ fetch }).call({ request: req(), idempotencyKey: 'k' });
    expect(result.finish_reason).toBe('tool_calls');
    expect(result.tool_calls).toEqual([{ id: 'toolu_1', name: 'grep', input: { q: 'foo' } }]);
  });

  it('converte tools do shape OpenAI p/ {name,description,input_schema}', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: HAPPY });
    await drain(
      client({ fetch }).stream({
        request: req({
          tools: [
            {
              type: 'function',
              function: {
                name: 'ls',
                description: 'lista',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
        }),
      }),
    );
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.tools).toEqual([
      { name: 'ls', description: 'lista', input_schema: { type: 'object', properties: {} } },
    ]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });
});

describe('toAnthropicMessages — conversão de papéis', () => {
  it('role:tool vira user com bloco tool_result', () => {
    const out = toAnthropicMessages([{ role: 'tool', content: 'resultado', tool_call_id: 'tc1' }]);
    expect(out).toEqual([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'resultado' }],
      },
    ]);
  });
  it('assistant com tool_calls vira blocos tool_use (+ texto)', () => {
    const out = toAnthropicMessages([
      {
        role: 'assistant',
        content: 'vou ler',
        tool_calls: [{ id: 't1', name: 'read', input: { p: 'a' } }],
      },
    ]);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'vou ler' },
          { type: 'tool_use', id: 't1', name: 'read', input: { p: 'a' } },
        ],
      },
    ]);
  });
});
