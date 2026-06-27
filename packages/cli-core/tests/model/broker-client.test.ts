import { describe, expect, it, vi } from 'vitest';
import { BrokerModelClient, buildChatBody } from '../../src/model/broker-client.js';
import {
  BrokerError,
  BrokerTransportError,
  ModelCallAbortedError,
} from '../../src/model/errors.js';
import type { ModelCallRequest, ModelStreamEvent } from '../../src/model/types.js';
import { bytes, makeBrokerFetch, sseBody } from './helpers.js';

const BASE = 'https://broker.test';
const token = async (): Promise<string> => 'eyJhbGciOiJ.payload.sig'; // device JWT fake

function req(over: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return {
    tier: 'aluy-strata',
    messages: [{ role: 'user', content: 'Oi' }],
    ...over,
  };
}

const HAPPY_SSE = sseBody([
  { event: 'start', data: { request_id: 'r1', tier: 'aluy-strata', session_id: 's1' } },
  { event: 'delta', data: { content: 'Olá' } },
  { event: 'delta', data: { content: ', mundo' } },
  {
    event: 'usage',
    data: {
      request_id: 'r1',
      tier: 'aluy-strata',
      provider: 'anthropic',
      model: 'claude-x',
      tokens_in: 12,
      tokens_out: 4,
      cost: '0.001',
      balance_after: '42.0',
    },
  },
  { event: 'done', data: { finish_reason: 'stop' } },
]);

async function drain(gen: AsyncGenerator<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('BrokerModelClient — CA-1 (chamada brokerada com ator headless)', () => {
  it('POSTa em /v1/chat com a credencial headless no Authorization (broker resolve ator)', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: HAPPY_SSE });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    await drain(client.stream({ request: req() }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://broker.test/v1/chat');
    expect(calls[0]?.method).toBe('POST');
    // A ÚNICA credencial é a headless de usuário — o broker introspecta e resolve
    // X-Actor-User/X-Org. O CLI NÃO seta esses headers (topologia direta, Q2).
    expect(calls[0]?.headers['authorization']).toBe('Bearer eyJhbGciOiJ.payload.sig');
    expect(calls[0]?.headers['x-actor-user']).toBeUndefined();
    expect(calls[0]?.headers['x-org']).toBeUndefined();
  });

  it('envia tier + messages + stream — e NADA de provider/model/api_key (HG-2/CLI-SEC-7)', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: HAPPY_SSE });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    await drain(client.stream({ request: req({ session_id: 's1', max_tokens: 256 }) }));

    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.tier).toBe('aluy-strata');
    expect(body.stream).toBe(true);
    expect(body.session_id).toBe('s1');
    expect(body.max_tokens).toBe(256);
    expect(body.messages).toEqual([{ role: 'user', content: 'Oi' }]);
    for (const forbidden of ['provider', 'model', 'api_key', 'base_url', 'markup', 'quota']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});

describe('BrokerModelClient.stream — CA-2 (streaming SSE token-a-token)', () => {
  it('emite start/delta/usage/done na ordem', async () => {
    const { fetch } = makeBrokerFetch({ status: 200, sse: HAPPY_SSE });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const events = await drain(client.stream({ request: req() }));
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'usage', 'done']);
    expect(events[0]).toMatchObject({ type: 'start', request_id: 'r1', session_id: 's1' });
    expect(events[1]).toEqual({ type: 'delta', content: 'Olá' });
    expect(events[3]).toMatchObject({
      type: 'usage',
      usage: { provider: 'anthropic', cost: '0.001' },
    });
  });

  it('preserva a ordem mesmo com o stream fatiado em muitos chunks TCP', async () => {
    const { fetch } = makeBrokerFetch({ status: 200, sse: bytes(HAPPY_SSE, 17) });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const deltas = (await drain(client.stream({ request: req() })))
      .filter((e): e is { type: 'delta'; content: string } => e.type === 'delta')
      .map((e) => e.content);
    expect(deltas.join('')).toBe('Olá, mundo');
  });

  it('call() agrega o stream em { content, usage, finish_reason }', async () => {
    const { fetch } = makeBrokerFetch({ status: 200, sse: HAPPY_SSE });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const res = await client.call({ request: req() });
    expect(res.content).toBe('Olá, mundo');
    expect(res.request_id).toBe('r1');
    expect(res.session_id).toBe('s1');
    expect(res.finish_reason).toBe('stop');
    expect(res.usage?.tokens_out).toBe(4);
  });

  it('call() não-stream ainda passa stream:true no corpo (mesmo caminho, sem 2ª rota)', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: HAPPY_SSE });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    await client.call({ request: req() });
    expect((calls[0]?.body as Record<string, unknown>).stream).toBe(true);
  });
});

describe('BrokerModelClient — CA-5 (propagação honesta de erro)', () => {
  it('429 BUDGET_EXHAUSTED ⇒ BrokerError estruturado (status/code/retryable)', async () => {
    const { fetch } = makeBrokerFetch({
      status: 429,
      json: {
        status: 429,
        code: 'BUDGET_EXHAUSTED',
        title: 'Too Many Requests',
        detail: 'Limite de custo do período atingido (hard cap).',
        retry_after: null,
      },
    });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const err = await drain(client.stream({ request: req() })).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).status).toBe(429);
    expect((err as BrokerError).code).toBe('BUDGET_EXHAUSTED');
    expect((err as BrokerError).isQuota).toBe(true);
  });

  it('401 UNAUTHENTICATED (credencial headless inválida/revogada) ⇒ isAuth', async () => {
    const { fetch } = makeBrokerFetch({
      status: 401,
      json: { status: 401, code: 'UNAUTHENTICATED', detail: 'credencial inválida.' },
    });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const err = (await drain(client.stream({ request: req() })).catch((e) => e)) as BrokerError;
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.isAuth).toBe(true);
    expect(err.retryable).toBe(false); // 401 não é retryable (sem retry infinito)
  });

  it('502 PROVIDER_ERROR ⇒ retryable + retry_after preservados (sem mascarar)', async () => {
    const { fetch } = makeBrokerFetch({
      status: 502,
      json: {
        status: 502,
        code: 'PROVIDER_ERROR',
        detail: 'O provedor falhou após a cadeia de fallback.',
        retryable: true,
        retry_after: 3,
      },
    });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const err = (await drain(client.stream({ request: req() })).catch((e) => e)) as BrokerError;
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.retryable).toBe(true);
    expect(err.retryAfter).toBe(3);
    // O corpo NUNCA cita provider/model — só o `detail` honesto (HG-2/SEC-4).
    expect(err.message).not.toContain('anthropic');
  });

  it('usa o header Retry-After quando o corpo não traz retry_after', async () => {
    const { fetch } = makeBrokerFetch({
      status: 429,
      json: { status: 429, code: 'RATE_LIMITED' },
      headers: { 'retry-after': '7' },
    });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const err = (await drain(client.stream({ request: req() })).catch((e) => e)) as BrokerError;
    expect(err.retryAfter).toBe(7);
  });

  it('event: error NO MEIO do stream ⇒ BrokerError lançado (encerra o stream)', async () => {
    const midError = sseBody([
      { event: 'start', data: { request_id: 'r1' } },
      { event: 'delta', data: { content: 'parc' } },
      {
        event: 'error',
        data: { status: 502, code: 'PROVIDER_ERROR', detail: 'caiu no meio', retryable: true },
      },
    ]);
    const { fetch } = makeBrokerFetch({ status: 200, sse: midError });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const seen: string[] = [];
    const err = await (async () => {
      try {
        for await (const ev of client.stream({ request: req() })) seen.push(ev.type);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(seen).toEqual(['start', 'delta']); // recebeu o parcial antes do erro
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).code).toBe('PROVIDER_ERROR');
  });

  it('falha de rede ⇒ BrokerTransportError (não mascara como BrokerError)', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new BrokerModelClient({
      baseUrl: BASE,
      getAccessToken: token,
      fetch: fetch as never,
    });
    const err = await drain(client.stream({ request: req() })).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerTransportError);
  });
});

describe('BrokerModelClient — cancelamento (AbortSignal)', () => {
  it('sinal já abortado ⇒ ModelCallAbortedError antes de qualquer fetch', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: HAPPY_SSE });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const ac = new AbortController();
    ac.abort();
    const err = await drain(client.stream({ request: req(), signal: ac.signal })).catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallAbortedError);
    expect(calls).toHaveLength(0); // nem chegou a chamar o broker
  });

  it('abort no MEIO do stream ⇒ para de emitir e lança ModelCallAbortedError', async () => {
    const ac = new AbortController();
    // Aborta assim que o 2º chunk (1º delta) for produzido.
    const stream = bytes(HAPPY_SSE, 40, (i) => {
      if (i === 6) ac.abort();
    });
    const { fetch } = makeBrokerFetch({ status: 200, sse: stream });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const seen: string[] = [];
    const err = await (async () => {
      try {
        for await (const ev of client.stream({ request: req(), signal: ac.signal })) {
          seen.push(ev.type);
        }
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ModelCallAbortedError);
  });
});

describe('BrokerModelClient — robustez de contrato', () => {
  it('422 UNKNOWN_TIER (tier desconhecido pelo servidor) ⇒ BrokerError não-retryable', async () => {
    const { fetch } = makeBrokerFetch({
      status: 422,
      json: { status: 422, code: 'UNKNOWN_TIER', detail: "tier 'aluy-turbo' não existe." },
    });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const err = (await drain(client.stream({ request: req({ tier: 'aluy-turbo' }) })).catch(
      (e) => e,
    )) as BrokerError;
    expect(err.code).toBe('UNKNOWN_TIER');
    expect(err.retryable).toBe(false);
  });

  it('2xx sem corpo de stream ⇒ BrokerTransportError (não trava silenciosamente)', async () => {
    const { fetch } = makeBrokerFetch({ status: 200 }); // sem `sse`
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const err = await drain(client.stream({ request: req() })).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerTransportError);
  });

  it('ignora evento SSE desconhecido (heartbeat/extensão futura) sem quebrar', async () => {
    const withUnknown = sseBody([
      { event: 'start', data: { request_id: 'r1' } },
      { event: 'ping', data: { t: 1 } }, // desconhecido
      { event: 'delta', data: { content: 'x' } },
      { event: 'done', data: { finish_reason: 'stop' } },
    ]);
    const { fetch } = makeBrokerFetch({ status: 200, sse: withUnknown });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const types = (await drain(client.stream({ request: req() }))).map((e) => e.type);
    expect(types).toEqual(['start', 'delta', 'done']);
  });

  it('repassa o trailer usage com partial:true (stream cortado pelo broker)', async () => {
    const cut = sseBody([
      { event: 'start', data: { request_id: 'r1' } },
      { event: 'delta', data: { content: 'parc' } },
      {
        event: 'usage',
        data: { request_id: 'r1', tier: 'aluy-strata', partial: true, cost: '0.0001' },
      },
    ]);
    const { fetch } = makeBrokerFetch({ status: 200, sse: cut });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const res = await client.call({ request: req() });
    expect(res.content).toBe('parc');
    expect(res.usage?.partial).toBe(true);
  });

  it('falha de transporte DURANTE a leitura do stream ⇒ BrokerTransportError', async () => {
    async function* boom(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('event: start\ndata: {"request_id":"r1"}\n\n');
      throw new Error('socket hangup');
    }
    const { fetch } = makeBrokerFetch({ status: 200, sse: boom() });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const seen: string[] = [];
    const err = await (async () => {
      try {
        for await (const ev of client.stream({ request: req() })) seen.push(ev.type);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(seen).toEqual(['start']);
    expect(err).toBeInstanceOf(BrokerTransportError);
  });
});

describe('buildChatBody (CLI-SEC-7 — corpo só com tier/messages)', () => {
  it('omite campos opcionais ausentes (exactOptionalPropertyTypes)', () => {
    const body = buildChatBody(req(), true);
    expect(Object.keys(body).sort()).toEqual(['messages', 'stream', 'tier']);
  });
});

describe('buildChatBody — via Custom (ADR-0030 §3 / ADR-0065 — model só sob tier:custom)', () => {
  it('tier:custom + model ⇒ o corpo INCLUI o model (slug)', () => {
    const body = buildChatBody(
      req({ tier: 'custom', model: 'meta-llama/llama-3.1-8b-instruct' }),
      true,
    );
    expect(body.tier).toBe('custom');
    expect(body.model).toBe('meta-llama/llama-3.1-8b-instruct');
  });

  it('model presente MAS tier canônico ⇒ o corpo NÃO inclui model (trava dupla HG-2)', () => {
    // Mesmo que um caller passe `model` por engano num tier normal, ele NÃO sai.
    const body = buildChatBody(req({ tier: 'aluy-strata', model: 'algum/slug' }), true);
    expect(body.tier).toBe('aluy-strata');
    expect(body).not.toHaveProperty('model');
  });

  it('tier:custom SEM model ⇒ não inventa model (omitido)', () => {
    const body = buildChatBody(req({ tier: 'custom' }), true);
    expect(body.tier).toBe('custom');
    expect(body).not.toHaveProperty('model');
  });

  it('Custom SEM provider (--provider//provider) não vaza provider; NUNCA api_key/base_url (HG-1)', () => {
    // Sem `request.provider`, o broker escolhe (retrocompat). Credencial NUNCA sai.
    const body = buildChatBody(req({ tier: 'custom', model: 'x/y' }), true);
    // sem provider no request ⇒ campo ausente (retrocompat). SEGREDO nunca sai.
    for (const forbidden of ['provider', 'api_key', 'base_url', 'markup', 'quota']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});

// EST-0962 (`--provider`/`/provider`) — o NOME do provider sai SÓ com a trava tripla
// (tier:custom + model + provider). É só o NOME (DADO), nunca credencial.
describe('buildChatBody — `--provider`//provider (EST-0962 · só o NOME, em par com model sob custom)', () => {
  it('tier:custom + model + provider ⇒ o corpo INCLUI provider (NOME) + model + tier', () => {
    const body = buildChatBody(
      req({ tier: 'custom', model: 'deepseek-v4-pro', provider: 'deepseek' }),
      true,
    );
    expect(body.tier).toBe('custom');
    expect(body.model).toBe('deepseek-v4-pro');
    expect(body.provider).toBe('deepseek');
  });

  it('SEM provider ⇒ o corpo NÃO tem o campo provider (retrocompat — broker escolhe)', () => {
    const body = buildChatBody(req({ tier: 'custom', model: 'deepseek-v4-pro' }), true);
    expect(body.model).toBe('deepseek-v4-pro');
    expect(body).not.toHaveProperty('provider');
  });

  it('provider presente MAS tier canônico ⇒ NÃO sai (trava: só sob custom)', () => {
    const body = buildChatBody(
      req({ tier: 'aluy-strata', model: 'x/y', provider: 'deepseek' }),
      true,
    );
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('model');
  });

  it('provider SEM model (mesmo sob custom) ⇒ NÃO sai (provider é PAR do model)', () => {
    const body = buildChatBody(req({ tier: 'custom', provider: 'deepseek' }), true);
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('model');
  });

  it('o provider carrega só o NOME — nunca api_key/base_url junto (CLI-SEC-7)', () => {
    const body = buildChatBody(
      req({ tier: 'custom', model: 'deepseek-v4-pro', provider: 'deepseek' }),
      true,
    );
    expect(body.provider).toBe('deepseek');
    for (const forbidden of ['api_key', 'base_url', 'markup', 'quota', 'credential']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});

// HUNT-CATALOG (roteamento) — campos VAZIOS/só-espaços são AUSÊNCIA, não escolha: o
// builder NÃO pode mandá-los crus (`undefined`→`''`), senão o broker roteia errado / 422a
// com um par ambíguo. DEGRADAÇÃO HONESTA = OMITIR o campo (broker recusa/escolhe o default
// com erro claro), nunca um valor mudo. Cada caso FALHA sem o guard de trim.
describe('buildChatBody — HUNT-CATALOG: campo vazio é ausência (omite, não manda string vazia)', () => {
  it('tier:custom + model:"" ⇒ NÃO manda model (slug vazio = sem slug, não `model:""`)', () => {
    // Antes do fix: `'' !== undefined` ⇒ vazava `model:""` ⇒ broker recebia (custom,'').
    const body = buildChatBody(req({ tier: 'custom', model: '' }), true);
    expect(body.tier).toBe('custom');
    expect(body).not.toHaveProperty('model');
  });

  it('tier:custom + model:"   " (só espaços) ⇒ NÃO manda model', () => {
    const body = buildChatBody(req({ tier: 'custom', model: '   ' }), true);
    expect(body).not.toHaveProperty('model');
  });

  it('model com espaços de borda ⇒ é TRIMADO no corpo (NOME canônico)', () => {
    const body = buildChatBody(req({ tier: 'custom', model: '  deepseek-v4-pro  ' }), true);
    expect(body.model).toBe('deepseek-v4-pro');
  });

  it('provider:"" (mesmo com model válido) ⇒ NÃO manda provider (vazio = sem provider)', () => {
    const body = buildChatBody(req({ tier: 'custom', model: 'x/y', provider: '' }), true);
    expect(body.model).toBe('x/y');
    expect(body).not.toHaveProperty('provider');
  });

  it('provider:"  " (só espaços) ⇒ NÃO manda provider', () => {
    const body = buildChatBody(req({ tier: 'custom', model: 'x/y', provider: '   ' }), true);
    expect(body).not.toHaveProperty('provider');
  });

  it('provider com espaços de borda ⇒ é TRIMADO no corpo', () => {
    const body = buildChatBody(
      req({ tier: 'custom', model: 'x/y', provider: '  deepseek  ' }),
      true,
    );
    expect(body.provider).toBe('deepseek');
  });

  it('reasoning_effort:"" ⇒ NÃO manda reasoning_effort (vazio = usar default do provider)', () => {
    const body = buildChatBody(req({ tier: 'aluy-strata', reasoning_effort: '' }), true);
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('reasoning_effort:"   " (só espaços) ⇒ NÃO manda reasoning_effort', () => {
    const body = buildChatBody(req({ tier: 'aluy-strata', reasoning_effort: '   ' }), true);
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('reasoning_effort com espaços de borda ⇒ é TRIMADO no corpo', () => {
    const body = buildChatBody(req({ tier: 'aluy-strata', reasoning_effort: '  high  ' }), true);
    expect(body.reasoning_effort).toBe('high');
  });
});
