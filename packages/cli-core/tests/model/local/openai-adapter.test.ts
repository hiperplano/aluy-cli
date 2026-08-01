// ADR-0120 / EST-1113 — adapter OpenAI-compat (openrouter/openai) + LocalModelClient.
import { describe, expect, it } from 'vitest';
import { LocalModelClient } from '../../../src/model/local/local-client.js';
import { OpenAiCompatAdapter } from '../../../src/model/local/openai-adapter.js';
import { newSseAccumulator, MAX_TRAILER_EVENTS } from '../../../src/model/local/adapter.js';
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
      {
        id: 'c',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
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

// ADR-0159 — `ContentPart[]` (imagem via `@mention`/`--image`): o adapter aprende a
// serializar o shape MULTIMODAL da OpenAI (vision) sem mudar o caminho de texto puro
// (a 1ª asserção acima, `body.messages` com `content: 'Oi'` string, já cobre o
// não-regressão — mantida intocada).
describe('OpenAiCompatAdapter — ADR-0159 (ContentPart[] · vision)', () => {
  async function bodyFor(request: ModelCallRequest): Promise<Record<string, unknown>> {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: 'data: [DONE]\n\n' });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
    });
    await drain(client.stream({ request }));
    return calls[0]?.body as Record<string, unknown>;
  }

  it('content ContentPart[] só-imagem ⇒ vira array com bloco image_url (data URL)', async () => {
    const body = await bodyFor(
      req({
        messages: [
          { role: 'user', content: [{ type: 'image', mimeType: 'image/png', base64: 'QUJD' }] },
        ],
      }),
    );
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }],
      },
    ]);
  });

  it('content ContentPart[] texto+imagem ⇒ ambos os blocos, na ordem', async () => {
    const body = await bodyFor(
      req({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'o que tem aqui?' },
              { type: 'image', mimeType: 'image/webp', base64: 'ZmFrZQ==' },
            ],
          },
        ],
      }),
    );
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'o que tem aqui?' },
          { type: 'image_url', image_url: { url: 'data:image/webp;base64,ZmFrZQ==' } },
        ],
      },
    ]);
  });

  it('mensagem STRING (texto puro) continua saindo IDÊNTICA — não-regressão', async () => {
    const body = await bodyFor(req({ messages: [{ role: 'user', content: 'texto normal' }] }));
    expect(body.messages).toEqual([{ role: 'user', content: 'texto normal' }]);
  });
});

// BUG-TRAILER — o `usage` real (stream_options.include_usage) chega num chunk
// TRAILER, DEPOIS do chunk que traz `finish_reason`. Antes do fix, o `done` saía na
// hora do `finish_reason` e o `LocalModelClient` fechava o socket ⇒ o trailer NUNCA
// era lido ⇒ `ModelCallResult.usage` undefined (a raiz do "⛁ 0% janela" no BYO).
// Estes casos cobrem: trailer separado (a), fim sem `[DONE]` via `finalize` (b),
// idempotência do `done` (c), teto anti-hang (d) e o caminho send-once (e) —
// sem regredir o comportamento já coberto acima.
describe('OpenAiCompatAdapter — BUG-TRAILER (usage no chunk trailer, pós finish_reason)', () => {
  it('(a) usage no chunk TRAILER separado do finish_reason ⇒ chega em ModelCallResult.usage', async () => {
    const sse = openAiSse([
      { id: 'c1', choices: [{ delta: { content: 'Olá' } }] },
      // finish_reason SEM usage no mesmo chunk.
      { id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      // trailer: usage REAL, num chunk `choices:[]` SEPARADO — o caso que quebrava.
      { id: 'c1', choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } },
    ]);
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
    });
    const events = await drain(client.stream({ request: req() }));
    // ORDEM: delta → usage (do trailer) → done. O usage chega ANTES do done, nunca
    // depois (o consumidor `call()` já teria fechado o loop no done).
    expect(events.map((e) => e.type)).toEqual(['delta', 'usage', 'done']);

    const result = await client.call({ request: req(), idempotencyKey: 'k' });
    expect(result.usage?.tokens_in).toBe(11);
    expect(result.usage?.tokens_out).toBe(4);
    expect(result.finish_reason).toBe('stop');
  });

  it('(b) provider fecha a conexão SEM [DONE] ⇒ `finalize` fecha o turno com o finish_reason REAL', async () => {
    // Sem o `data: [DONE]\n\n` final — simula um proxy/timeout que corta o corpo
    // logo após o trailer de usage.
    const sse =
      'data: ' +
      JSON.stringify({ id: 'c1', choices: [{ delta: { content: 'oi' } }] }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({ id: 'c1', choices: [{ delta: {}, finish_reason: 'length' }] }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({ id: 'c1', choices: [], usage: { prompt_tokens: 3, completion_tokens: 9 } }) +
      '\n\n';
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
    });
    const events = await drain(client.stream({ request: req() }));
    expect(events.map((e) => e.type)).toEqual(['delta', 'usage', 'done']);
    const done = events.find((e) => e.type === 'done') as Extract<
      ModelStreamEvent,
      { type: 'done' }
    >;
    // `finish_reason` REAL ('length'), NUNCA um 'stop' inventado pelo fallback.
    expect(done.finish_reason).toBe('length');
    const usage = events.find((e) => e.type === 'usage') as Extract<
      ModelStreamEvent,
      { type: 'usage' }
    >;
    expect(usage.usage.tokens_in).toBe(3);
    expect(usage.usage.tokens_out).toBe(9);
  });

  it('(b.2) fim de stream sem finish_reason nenhum ⇒ finalize fecha como "stop" (default histórico)', async () => {
    // Corpo termina no meio (nem finish_reason, nem [DONE]) — o teto de idempotência
    // não deve inventar um finish_reason específico; cai no default 'stop'.
    const sse =
      'data: ' + JSON.stringify({ id: 'c1', choices: [{ delta: { content: 'x' } }] }) + '\n\n';
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
    });
    const events = await drain(client.stream({ request: req() }));
    expect(events.map((e) => e.type)).toEqual(['delta', 'done']);
    const done = events.find((e) => e.type === 'done') as Extract<
      ModelStreamEvent,
      { type: 'done' }
    >;
    expect(done.finish_reason).toBe('stop');
  });

  it('(c) idempotência — `finalize` depois do `[DONE]` já ter fechado o turno NÃO duplica o done', () => {
    const a = adapter();
    const acc = newSseAccumulator();
    // finish_reason + [DONE], como um turno normal.
    a.mapSse(
      '',
      JSON.stringify({ id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }] }),
      acc,
    );
    const doneEvents = a.mapSse('', '[DONE]', acc);
    expect(doneEvents).toEqual([{ type: 'done', finish_reason: 'stop' }]);
    expect(acc.emittedDone).toBe(true);
    // chamar `finalize` DEPOIS (ex.: o client chamando a rede por segurança) não
    // deve emitir um segundo `done` nem duplicar tool-calls.
    expect(a.finalize?.(acc)).toEqual([]);
  });

  it('(c.2) idempotência — dois `[DONE]` seguidos no MESMO corpo não duplicam o done', () => {
    const a = adapter();
    const acc = newSseAccumulator();
    a.mapSse(
      '',
      JSON.stringify({ id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }] }),
      acc,
    );
    expect(a.mapSse('', '[DONE]', acc)).toEqual([{ type: 'done', finish_reason: 'stop' }]);
    // um `[DONE]` redundante (provider mal-comportado) ⇒ [] (não repete o evento).
    expect(a.mapSse('', '[DONE]', acc)).toEqual([]);
  });

  it('(d) teto anti-hang — provider nunca manda [DONE]; fecha à força após MAX_TRAILER_EVENTS', async () => {
    // finish_reason chega, seguido de MUITO mais que MAX_TRAILER_EVENTS chunks de
    // keep-alive (`choices:[]`, sem usage) — nunca um `[DONE]`. O `done` deve sair à
    // força, com o finish_reason REAL, sem esperar o resto dos keep-alives.
    const keepAlive = { id: 'c1', choices: [] as unknown[] };
    const chunks = [
      { id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ...Array.from({ length: MAX_TRAILER_EVENTS + 12 }, () => keepAlive),
    ];
    // SEM usar o helper `openAiSse` (que sempre acrescenta `[DONE]`) — aqui o corpo
    // não deve fechar nunca via sentinela.
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch,
    });
    const events = await drain(client.stream({ request: req() }));
    // Fechou à força — NÃO leu os 12 keep-alives excedentes (só emite `done`, uma
    // vez, com o finish_reason REAL do 1º chunk).
    expect(events).toEqual([{ type: 'done', finish_reason: 'tool_calls' }]);
  });

  it('(e) usage no MESMO chunk do finish_reason (send-once) ⇒ NÃO regride: chega em ModelCallResult.usage', async () => {
    // Caso já coberto acima ("mapeia o stream p/ delta+usage+done…"), repetido aqui
    // de forma explícita como guarda de não-regressão do BUG-TRAILER: quando o
    // provider manda tudo de uma vez (finish_reason + usage no mesmo objeto), o
    // adiamento do `done` NÃO deve quebrar esse caminho — só espera o `[DONE]`
    // seguinte, que chega imediatamente.
    const sse = openAiSse([
      {
        id: 'c1',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 6 },
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
    const events = await drain(client.stream({ request: req() }));
    expect(events.map((e) => e.type)).toEqual(['usage', 'done']);
    const result = await client.call({ request: req(), idempotencyKey: 'k' });
    expect(result.usage?.tokens_in).toBe(20);
    expect(result.usage?.tokens_out).toBe(6);
  });

  it('(f) tool-calls acumuladas saem ANTES do done tanto em [DONE] quanto em finalize', async () => {
    // [DONE] normal.
    const sseDone = openAiSse([
      {
        id: 'c1',
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{}' } }],
            },
          },
        ],
      },
      { id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const { fetch: fetchDone } = makeBrokerFetch({ status: 200, sse: sseDone });
    const clientDone = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch: fetchDone,
    });
    const eventsDone = await drain(clientDone.stream({ request: req() }));
    expect(eventsDone.map((e) => e.type)).toEqual(['tool_call', 'done']);

    // finalize (sem [DONE]) — mesma garantia.
    const sseNoDone =
      'data: ' +
      JSON.stringify({
        id: 'c1',
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{}' } }],
            },
          },
        ],
      }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({ id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
      '\n\n';
    const { fetch: fetchNoDone } = makeBrokerFetch({ status: 200, sse: sseNoDone });
    const clientNoDone = new LocalModelClient({
      adapter: adapter(),
      config: { provider: 'openrouter', model: 'm' },
      baseUrl: 'https://openrouter.ai/api/v1',
      getCredential: cred,
      fetch: fetchNoDone,
    });
    const eventsNoDone = await drain(clientNoDone.stream({ request: req() }));
    expect(eventsNoDone.map((e) => e.type)).toEqual(['tool_call', 'done']);
  });
});
