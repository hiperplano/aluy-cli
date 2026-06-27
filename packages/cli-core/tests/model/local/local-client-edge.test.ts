// ADR-0120 / EST-1113 — LocalModelClient: caminhos de erro/borda (abort, transporte,
// credencial, system/tools no toLocalRequest, max_tokens default).
import { describe, expect, it } from 'vitest';
import { LocalModelClient } from '../../../src/model/local/local-client.js';
import { OpenAiCompatAdapter } from '../../../src/model/local/openai-adapter.js';
import { BrokerTransportError, ModelCallAbortedError } from '../../../src/model/errors.js';
import type { StreamFetch, StreamResponse } from '../../../src/model/broker-client.js';
import type { ModelCallRequest, ModelStreamEvent } from '../../../src/model/types.js';
import type { ResolvedCredential } from '../../../src/model/local/types.js';
import { makeBrokerFetch } from '../helpers.js';

const cred = async (): Promise<ResolvedCredential> => ({ kind: 'apikey', secret: 'sk' });
const adapter = (): OpenAiCompatAdapter =>
  new OpenAiCompatAdapter({ provider: 'openai', defaultBaseUrl: 'https://api.openai.com/v1' });

function client(over: {
  fetch: StreamFetch;
  getCredential?: () => Promise<ResolvedCredential>;
}): LocalModelClient {
  return new LocalModelClient({
    adapter: adapter(),
    config: { provider: 'openai', model: 'gpt-4o' },
    baseUrl: 'https://api.openai.com/v1',
    getCredential: over.getCredential ?? cred,
    fetch: over.fetch,
  });
}

const req = (over: Partial<ModelCallRequest> = {}): ModelCallRequest => ({
  tier: 'aluy-flux',
  messages: [{ role: 'user', content: 'Oi' }],
  ...over,
});

async function drain(gen: AsyncGenerator<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('LocalModelClient — bordas', () => {
  it('signal já abortado ⇒ ModelCallAbortedError (antes do fetch)', async () => {
    const { fetch } = makeBrokerFetch({ status: 200, sse: 'data: [DONE]\n\n' });
    const ac = new AbortController();
    ac.abort();
    await expect(
      drain(client({ fetch }).stream({ request: req(), signal: ac.signal })),
    ).rejects.toBeInstanceOf(ModelCallAbortedError);
  });

  it('falha de rede no fetch ⇒ BrokerTransportError (sem vazar segredo)', async () => {
    const fetch: StreamFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const err = await drain(client({ fetch }).stream({ request: req() })).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerTransportError);
    expect(String((err as Error).message)).not.toContain('sk');
  });

  it('2xx sem corpo de stream ⇒ BrokerTransportError', async () => {
    const fetch: StreamFetch = async (): Promise<StreamResponse> => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: null,
      json: async () => ({}),
      text: async () => '',
    });
    await expect(drain(client({ fetch }).stream({ request: req() }))).rejects.toBeInstanceOf(
      BrokerTransportError,
    );
  });

  it('credencial ausente (provedor lança) ⇒ propaga o erro do resolvedor', async () => {
    const { fetch } = makeBrokerFetch({ status: 200, sse: 'data: [DONE]\n\n' });
    const getCredential = async (): Promise<ResolvedCredential> => {
      throw new Error('sem credencial p/ openai');
    };
    await expect(
      drain(client({ fetch, getCredential }).stream({ request: req() })),
    ).rejects.toThrow(/sem credencial/);
  });

  it('toLocalRequest: 1ª system vira `system`; usa default max_tokens quando não há request.max_tokens', async () => {
    const sse =
      'data: ' +
      JSON.stringify({ id: 'c', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) +
      '\n\ndata: [DONE]\n\n';
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse });
    await drain(
      client({ fetch }).stream({
        request: req({
          messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'oi' },
          ],
        }),
      }),
    );
    const body = calls[0]?.body as Record<string, unknown>;
    // openai-compat: system vira a 1ª mensagem role:system (campo do CLI extraído e re-injetado).
    expect((body.messages as unknown[])[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.max_tokens).toBe(8192); // DEFAULT_MAX_TOKENS quando não configurado.
  });

  it('toLocalRequest: tools + tool_choice viajam quando presentes', async () => {
    const sse = 'data: [DONE]\n\n';
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse });
    await drain(
      client({ fetch }).stream({
        request: req({
          tools: [{ type: 'function', function: { name: 'x', description: 'd', parameters: {} } }],
          tool_choice: 'auto',
          temperature: 0.5,
          reasoning_effort: 'high',
        }),
      }),
    );
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.tools).toBeDefined();
    expect(body.tool_choice).toBe('auto');
    expect(body.temperature).toBe(0.5);
    expect(body.reasoning_effort).toBe('high');
  });

  // F146 · FIX: /model → Custom sobrescreve o model do boot.
  it('toLocalRequest: tier custom + model slug ⇒ sobrepõe config.model', async () => {
    const sse = 'data: [DONE]\n\n';
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse });
    await drain(
      client({ fetch }).stream({
        request: req({ tier: 'custom', model: ' claude-opus-4-8 ' }),
      }),
    );
    const body = calls[0]?.body as Record<string, unknown>;
    // Slug com espaços em volta → trim deve acontecer.
    expect(body.model).toBe('claude-opus-4-8');
  });

  it('toLocalRequest: tier canônico (sem custom) ⇒ ignora model e usa config.model', async () => {
    const sse = 'data: [DONE]\n\n';
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse });
    await drain(
      client({ fetch }).stream({
        request: req({ tier: 'aluy-flux', model: 'outro-slug' }),
      }),
    );
    const body = calls[0]?.body as Record<string, unknown>;
    // Fora de custom, model do request é IGNORADO — cai em config.model.
    expect(body.model).toBe('gpt-4o');
  });

  it('toLocalRequest: tier custom com model vazio ⇒ fallback config.model', async () => {
    const sse = 'data: [DONE]\n\n';
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse });
    await drain(
      client({ fetch }).stream({
        request: req({ tier: 'custom', model: '   ' }),
      }),
    );
    const body = calls[0]?.body as Record<string, unknown>;
    // Slug só com espaços ⇒ cai em config.model.
    expect(body.model).toBe('gpt-4o');
  });
});
