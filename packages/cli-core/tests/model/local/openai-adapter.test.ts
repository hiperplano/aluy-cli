// ADR-0120 / EST-1113 — adapter OpenAI-compat (openrouter/openai) + LocalModelClient.
import { describe, expect, it } from 'vitest';
import { LocalModelClient } from '../../../src/model/local/local-client.js';
import { OpenAiCompatAdapter } from '../../../src/model/local/openai-adapter.js';
import { BrokerError } from '../../../src/model/errors.js';
import type { ModelCallRequest, ModelStreamEvent } from '../../../src/model/types.js';
import type { ResolvedCredential } from '../../../src/model/local/types.js';
import { makeBrokerFetch } from '../helpers.js';

/** SSE estilo OpenAI: linhas `data: {...}` SEM `event:` (terminado por [DONE]). */
function openAiSse(chunks: unknown[]): string {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

const cred = async (): Promise<ResolvedCredential> => ({ kind: 'apikey', secret: 'sk-test-key' });

function adapter(): OpenAiCompatAdapter {
  return new OpenAiCompatAdapter({
    provider: 'openrouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  });
}

function req(over: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return { tier: 'aluy-flux', messages: [{ role: 'user', content: 'Oi' }], ...over };
}

async function drain(gen: AsyncGenerator<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('OpenAiCompatAdapter — request building', () => {
  it('POSTa em /chat/completions com Bearer + model + max_tokens + stream', async () => {
    const sse = openAiSse([
      { id: 'cmpl-1', choices: [{ delta: { content: 'Olá' } }] },
      {
        id: 'cmpl-1',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
    ]);
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
      maxTokens: 1024,
    });
    await drain(client.stream({ request: req() }));
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]?.headers['authorization']).toBe('Bearer sk-test-key');
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.model).toBe('anthropic/claude-3.5-sonnet');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toEqual([{ role: 'user', content: 'Oi' }]);
  });

  it('auth `none` (Ollama local) ⇒ NÃO manda header Authorization', async () => {
    const credNone = async (): Promise<ResolvedCredential> => ({ kind: 'none', secret: '' });
    const sse = openAiSse([
      { id: 'c', choices: [{ delta: { content: 'oi' } }] },
      { id: 'c', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'ollama', model: 'llama3.2' },
      baseUrl: 'http://127.0.0.1:11434/v1',
      getCredential: credNone,
      fetch,
      maxTokens: 1024,
    });
    await drain(client.stream({ request: req() }));
    // SEM Authorization — o Ollama no loopback não usa credencial.
    expect(calls[0]?.headers['authorization']).toBeUndefined();
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('mapeia o stream p/ delta+usage+done; agrega o texto no call()', async () => {
    const sse = openAiSse([
      { id: 'c1', model: 'x', choices: [{ delta: { content: 'Olá' } }] },
      { id: 'c1', choices: [{ delta: { content: ', mundo' } }] },
      {
        id: 'c1',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      },
    ]);
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
    });
    const result = await client.call({ request: req(), idempotencyKey: 'k1' });
    expect(result.content).toBe('Olá, mundo');
    expect(result.finish_reason).toBe('stop');
    expect(result.usage?.tokens_in).toBe(7);
    expect(result.usage?.tokens_out).toBe(3);
    expect(result.usage?.provider).toBe('openrouter');
  });

  it('acumula tool_calls fragmentadas por index e emite a call completa', async () => {
    const sse = openAiSse([
      {
        id: 'c1',
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file' } }] } },
        ],
      },
      {
        id: 'c1',
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
      },
      {
        id: 'c1',
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }],
      },
      { id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
    });
    const result = await client.call({ request: req(), idempotencyKey: 'k1' });
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls?.[0]).toEqual({
      id: 'call_1',
      name: 'read_file',
      input: { path: 'a.ts' },
    });
  });

  it('converte um 401 do provider em BrokerError de auth', async () => {
    const { fetch } = makeBrokerFetch({ status: 401, json: { error: { message: 'invalid key' } } });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
    });
    await expect(drain(client.stream({ request: req() }))).rejects.toBeInstanceOf(BrokerError);
  });

  it('400 citando "tools" ⇒ TOOLS_UNSUPPORTED (degrade do loop, status 422)', async () => {
    const { fetch } = makeBrokerFetch({
      status: 400,
      json: { error: { message: 'model does not support tools' } },
    });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
    });
    try {
      await drain(client.stream({ request: req({ tools: [] }) }));
      throw new Error('deveria ter lançado');
    } catch (e) {
      expect(e).toBeInstanceOf(BrokerError);
      expect((e as BrokerError).isToolsUnsupported).toBe(true);
    }
  });

  it('envia HTTP-Referer/X-Title de atribuição no openrouter', async () => {
    const sse = openAiSse([{ id: 'c', choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
    });
    await drain(client.stream({ request: req() }));
    expect(calls[0]?.headers['x-title']).toBe('aluy-cli');
    expect(calls[0]?.headers['http-referer']).toBeTruthy();
  });

  it('erro mid-stream ({error:{message}} no data) ⇒ BrokerError lançado', async () => {
    const sse =
      'data: ' +
      JSON.stringify({ id: 'c', choices: [{ delta: { content: 'parcial' } }] }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({ error: { message: 'rate limited', code: 429 } }) +
      '\n\n';
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
    });
    await expect(drain(client.stream({ request: req() }))).rejects.toBeInstanceOf(BrokerError);
  });

  it('500 do provider ⇒ PROVIDER_ERROR (status preservado)', async () => {
    const { fetch } = makeBrokerFetch({
      status: 500,
      json: { error: { message: 'upstream down' } },
    });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
    });
    const err = (await drain(client.stream({ request: req() })).catch((e) => e)) as BrokerError;
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.status).toBe(500);
  });
});
