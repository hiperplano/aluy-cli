// EST-0948 · CA-1 (núcleo) — StreamingModelCaller: o caminho que faz o `aluy`
// mostrar token-a-token. Exercita o switch de eventos SSE, a agregação dos deltas,
// o threading do `session_id` ENTRE turnos (ADR-0034) e o `usage` final — com um
// `BrokerModelClient` FAKE que emite `start`/`delta`/`usage`/`done` (e `error`).
//
// O controller.test.ts faz fake do `ModelCaller` INTEIRO (pula esta classe); aqui
// o fake é o CLIENTE de broker (camada abaixo), então o caller real é exercitado.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BrokerError,
  DegenerateLoopError,
  type BrokerModelClient,
  type ModelStreamEvent,
  type ModelUsage,
  type StreamCallArgs,
} from '@aluy/cli-core';
import { StreamingModelCaller, type StreamSink } from '../../src/session/streaming-caller.js';

/**
 * Fake do `BrokerModelClient`: cada `stream()` consome o PRÓXIMO roteiro da fila
 * e emite seus eventos (ou lança). Captura cada `request` p/ provar o threading
 * do `session_id`. Só `stream()` é tocado pelo caller — castamos pela borda.
 */
function fakeClient(scripts: readonly ModelStreamEvent[][]): {
  client: BrokerModelClient;
  requests: StreamCallArgs['request'][];
} {
  const requests: StreamCallArgs['request'][] = [];
  let turn = 0;
  const client = {
    async *stream(args: StreamCallArgs): AsyncGenerator<ModelStreamEvent> {
      requests.push(args.request);
      const script = scripts[Math.min(turn, scripts.length - 1)] ?? [];
      turn += 1;
      for (const ev of script) yield ev;
    },
  };
  return { client: client as unknown as BrokerModelClient, requests };
}

/** Sink-espião que grava a ordem/conteúdo dos callbacks da UI. */
function spySink(): {
  sink: StreamSink;
  events: string[];
  deltas: string[];
  usages: ModelUsage[];
} {
  const events: string[] = [];
  const deltas: string[] = [];
  const usages: ModelUsage[] = [];
  return {
    sink: {
      onStart: () => events.push('start'),
      onDelta: (c) => {
        events.push('delta');
        deltas.push(c);
      },
      onUsage: (u) => {
        events.push('usage');
        usages.push(u);
      },
      onDone: () => events.push('done'),
    },
    events,
    deltas,
    usages,
  };
}

const USAGE: ModelUsage = { request_id: 'r1', tier: 'aluy-flux', tokens_in: 12, tokens_out: 34 };

describe('StreamingModelCaller — agregação de deltas + usage final', () => {
  it('concatena os deltas, devolve usage/finish_reason e emite o sink na ordem', async () => {
    const { client } = fakeClient([
      [
        { type: 'start', request_id: 'req-1', session_id: 'sess-1' },
        { type: 'delta', content: 'olá' },
        { type: 'delta', content: ', ' },
        { type: 'delta', content: 'mundo' },
        { type: 'usage', usage: USAGE },
        { type: 'done', finish_reason: 'stop' },
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });

    const result = await caller.call({ messages: [], idempotencyKey: 'k1' });

    // agregação: os 3 deltas viram o content final
    expect(result.content).toBe('olá, mundo');
    expect(result.request_id).toBe('req-1');
    expect(result.session_id).toBe('sess-1');
    expect(result.finish_reason).toBe('stop');
    expect(result.usage).toEqual(USAGE);

    // o sink viu cada delta token-a-token + start/usage/done na ordem
    expect(s.deltas).toEqual(['olá', ', ', 'mundo']);
    expect(s.events).toEqual(['start', 'delta', 'delta', 'delta', 'usage', 'done']);
    expect(s.usages).toEqual([USAGE]);
  });

  it('sem evento usage ⇒ result.usage ausente; finish_reason default = stop', async () => {
    const { client } = fakeClient([
      [
        { type: 'start', request_id: 'req-x' },
        { type: 'delta', content: 'oi' },
        // sem `usage`, sem `done` explícito de finish — agregador usa default
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });

    const result = await caller.call({ messages: [], idempotencyKey: 'k' });

    expect(result.content).toBe('oi');
    expect(result.usage).toBeUndefined();
    expect(result.finish_reason).toBe('stop');
    expect(result.session_id).toBeUndefined();
    // onDone sempre fecha o turno na UI mesmo sem evento `done` do broker
    expect(s.events).toEqual(['start', 'delta', 'done']);
  });
});

describe('StreamingModelCaller — threading do session_id entre turnos (ADR-0034)', () => {
  it('o session_id do `start` do turno 1 é reenviado no request do turno 2', async () => {
    const { client, requests } = fakeClient([
      [
        { type: 'start', request_id: 'r1', session_id: 'S-42' },
        { type: 'delta', content: 'turno 1' },
        { type: 'done', finish_reason: 'stop' },
      ],
      [
        { type: 'start', request_id: 'r2', session_id: 'S-42' },
        { type: 'delta', content: 'turno 2' },
        { type: 'done', finish_reason: 'stop' },
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });

    await caller.call({ messages: [], idempotencyKey: 'k1' });
    await caller.call({ messages: [], idempotencyKey: 'k2' });

    // turno 1: sem session_id (primeira chamada); turno 2: carrega o S-42 capturado.
    expect(requests[0]?.session_id).toBeUndefined();
    expect(requests[1]?.session_id).toBe('S-42');
  });

  it('honra o sessionId inicial passado nas opções já no 1º request', async () => {
    const { client, requests } = fakeClient([
      [
        { type: 'start', request_id: 'r1', session_id: 'S-seed' },
        { type: 'done', finish_reason: 'stop' },
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'aluy-flux',
      sessionId: 'S-seed',
      sink: s.sink,
    });

    await caller.call({ messages: [], idempotencyKey: 'k' });

    expect(requests[0]?.session_id).toBe('S-seed');
  });
});

describe('StreamingModelCaller — troca de tier em runtime (EST-0962)', () => {
  it('setTier muda a ÚNICA pista de modelo da PRÓXIMA chamada (HG-2)', async () => {
    const { client, requests } = fakeClient([
      [{ type: 'done', finish_reason: 'stop' }],
      [{ type: 'done', finish_reason: 'stop' }],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });

    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(caller.tier).toBe('aluy-flux');
    expect(requests[0]?.tier).toBe('aluy-flux');

    caller.setTier('aluy-deep');
    expect(caller.tier).toBe('aluy-deep');

    await caller.call({ messages: [], idempotencyKey: 'k2' });
    // a 2ª chamada usa o NOVO tier; nada além do tier mudou no request (HG-2).
    expect(requests[1]?.tier).toBe('aluy-deep');
  });
});

describe('StreamingModelCaller — via Custom (ADR-0030 §3 / EST-0962)', () => {
  it('tier:custom + model ⇒ a chamada envia o slug junto do tier', async () => {
    const { client, requests } = fakeClient([[{ type: 'done', finish_reason: 'stop' }]]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'custom',
      model: 'meta-llama/llama-3.1-8b-instruct',
      sink: s.sink,
    });

    await caller.call({ messages: [], idempotencyKey: 'k1' });

    expect(caller.tier).toBe('custom');
    expect(caller.model).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(requests[0]?.tier).toBe('custom');
    expect(requests[0]?.model).toBe('meta-llama/llama-3.1-8b-instruct');
  });

  it('setTier("custom", slug) em runtime ⇒ a PRÓXIMA chamada vira Custom com o slug', async () => {
    const { client, requests } = fakeClient([
      [{ type: 'done', finish_reason: 'stop' }],
      [{ type: 'done', finish_reason: 'stop' }],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });

    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.tier).toBe('aluy-flux');
    expect(requests[0]?.model).toBeUndefined(); // tier canônico ⇒ sem model

    caller.setTier('custom', 'openrouter/some-model');
    await caller.call({ messages: [], idempotencyKey: 'k2' });
    expect(requests[1]?.tier).toBe('custom');
    expect(requests[1]?.model).toBe('openrouter/some-model');
  });

  it('voltar de Custom p/ um tier canônico LIMPA o slug (Custom não vaza — HG-2)', async () => {
    const { client, requests } = fakeClient([
      [{ type: 'done', finish_reason: 'stop' }],
      [{ type: 'done', finish_reason: 'stop' }],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'custom',
      model: 'x/y',
      sink: s.sink,
    });

    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.model).toBe('x/y');

    // troca p/ um tier canônico SEM passar model ⇒ o slug é zerado.
    caller.setTier('aluy-deep');
    expect(caller.model).toBeUndefined();
    await caller.call({ messages: [], idempotencyKey: 'k2' });
    expect(requests[1]?.tier).toBe('aluy-deep');
    expect(requests[1]?.model).toBeUndefined();
  });
});

// EST-0962 (`--provider`/`/provider`) — o NOME do provider acompanha o slug Custom (par
// model+provider): boot (`--provider`) + runtime (`/provider` via setProvider).
describe('StreamingModelCaller — provider Custom (--provider//provider)', () => {
  it('boot --provider em par com tier:custom+model ⇒ a chamada envia o provider', async () => {
    const { client, requests } = fakeClient([[{ type: 'done', finish_reason: 'stop' }]]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'custom',
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      sink: s.sink,
    });
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(caller.provider).toBe('deepseek');
    expect(requests[0]?.tier).toBe('custom');
    expect(requests[0]?.model).toBe('deepseek-v4-pro');
    expect(requests[0]?.provider).toBe('deepseek');
  });

  it('SEM provider ⇒ a chamada NÃO envia provider (retrocompat — broker escolhe)', async () => {
    const { client, requests } = fakeClient([[{ type: 'done', finish_reason: 'stop' }]]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'custom',
      model: 'deepseek-v4-pro',
      sink: s.sink,
    });
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.model).toBe('deepseek-v4-pro');
    expect(requests[0]?.provider).toBeUndefined();
  });

  it('--provider SEM model (tier canônico) é IGNORADO no boot (par exige slug)', async () => {
    const { client, requests } = fakeClient([[{ type: 'done', finish_reason: 'stop' }]]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'aluy-flux',
      provider: 'deepseek',
      sink: s.sink,
    });
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(caller.provider).toBeUndefined();
    expect(requests[0]?.provider).toBeUndefined();
    expect(requests[0]?.model).toBeUndefined();
  });

  it('setProvider em runtime ⇒ a PRÓXIMA chamada Custom envia o provider', async () => {
    const { client, requests } = fakeClient([
      [{ type: 'done', finish_reason: 'stop' }],
      [{ type: 'done', finish_reason: 'stop' }],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'custom',
      model: 'x/y',
      sink: s.sink,
    });
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.provider).toBeUndefined(); // sem provider ainda ⇒ broker escolhe

    caller.setProvider('openrouter');
    await caller.call({ messages: [], idempotencyKey: 'k2' });
    expect(caller.provider).toBe('openrouter');
    expect(requests[1]?.provider).toBe('openrouter');
  });

  it('setProvider FORA de Custom é no-op (par exige um slug Custom — HG-2)', async () => {
    const { client, requests } = fakeClient([[{ type: 'done', finish_reason: 'stop' }]]);
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });
    caller.setProvider('deepseek');
    expect(caller.provider).toBeUndefined();
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.provider).toBeUndefined();
  });

  it('setTier (trocar de modelo via /model) DESCARTA o provider corrente', async () => {
    const { client, requests } = fakeClient([
      [{ type: 'done', finish_reason: 'stop' }],
      [{ type: 'done', finish_reason: 'stop' }],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'custom',
      model: 'x/y',
      provider: 'deepseek',
      sink: s.sink,
    });
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.provider).toBe('deepseek');

    // trocar p/ outro slug Custom ⇒ o provider do slug anterior é descartado.
    caller.setTier('custom', 'a/b');
    expect(caller.provider).toBeUndefined();
    await caller.call({ messages: [], idempotencyKey: 'k2' });
    expect(requests[1]?.model).toBe('a/b');
    expect(requests[1]?.provider).toBeUndefined();
  });
});

describe('StreamingModelCaller — propaga erro estruturado (CA-5)', () => {
  it('um stream que LANÇA BrokerError sobe sem virar uma 2ª rota/retry', async () => {
    const boom = new BrokerError({ status: 502, code: 'PROVIDER_ERROR', title: 'broker fora' });
    const client = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        throw boom;
      },
    } as unknown as BrokerModelClient;
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });

    await expect(caller.call({ messages: [], idempotencyKey: 'k' })).rejects.toBe(boom);
    // o turno começou na UI (onStart) antes do erro subir — o controller mapeia o erro.
    expect(s.events).toEqual(['start']);
  });
});

describe('StreamingModelCaller — EST-0969 guarda anti-repetição (loop degenerado)', () => {
  it('stream que repete a MESMA linha muitas vezes ⇒ call() lança DegenerateLoopError', async () => {
    // 40 deltas da mesma linha — o caminho de STREAM da TUI alimenta a MESMA guarda
    // do core; ela corta o turno mid-stream (igual ao broker-client).
    const deltas: ModelStreamEvent[] = [{ type: 'start', request_id: 'r1', session_id: 's1' }];
    for (let i = 0; i < 40; i++) deltas.push({ type: 'delta', content: '<<<EDIT_STDIN>/>/>\n' });
    deltas.push({ type: 'done', finish_reason: 'stop' });
    const { client } = fakeClient([deltas]);
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });

    await expect(caller.call({ messages: [], idempotencyKey: 'k' })).rejects.toBeInstanceOf(
      DegenerateLoopError,
    );
    // a UI VIU os tokens parciais antes do corte (não engole o stream); só não cospe os 217.
    expect(s.deltas.length).toBeGreaterThan(0);
    expect(s.deltas.length).toBeLessThan(40);
  });

  it('stream NORMAL e variado ⇒ agrega normalmente (sem regressão da guarda)', async () => {
    const { client } = fakeClient([
      [
        { type: 'start', request_id: 'r1' },
        { type: 'delta', content: 'linha um\n' },
        { type: 'delta', content: 'linha dois\n' },
        { type: 'delta', content: 'fim.' },
        { type: 'done', finish_reason: 'stop' },
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });
    const res = await caller.call({ messages: [], idempotencyKey: 'k' });
    expect(res.content).toBe('linha um\nlinha dois\nfim.');
  });
});

describe('StreamingModelCaller — EST-1010 (BUG-0020) teto de BYTES (stream gigante não-repetitivo)', () => {
  const PREV = process.env.ALUY_STREAM_MAX_BYTES;
  beforeEach(() => {
    // teto BAIXO p/ o teste (sem gerar 24 MiB): 4 KiB. O caller lê o env.
    process.env.ALUY_STREAM_MAX_BYTES = String(4 * 1024);
  });
  afterEach(() => {
    if (PREV === undefined) delete process.env.ALUY_STREAM_MAX_BYTES;
    else process.env.ALUY_STREAM_MAX_BYTES = PREV;
  });

  /**
   * Gerador "bugado": emite deltas ÚNICOS (sem repetição ⇒ a guarda de degeneração
   * NUNCA dispara) e NUNCA manda `done` — simula broker pendurado / `done` que não
   * chega. Conta quantos deltas chegou a emitir p/ provar que o consumo PAROU.
   */
  function neverEndingUniqueDeltas(emitted: { count: number }): BrokerModelClient {
    const client = {
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        yield { type: 'start', request_id: 'r1', session_id: 's1' };
        for (let i = 0; ; i++) {
          emitted.count = i + 1;
          // conteúdo ÚNICO por chunk (índice incremental) ⇒ NÃO degenera; ~64 B cada.
          yield { type: 'delta', content: `chunk-${i}-${'x'.repeat(50)}-${i}\n` };
        }
        // inalcançável: nunca há `done`.
      },
    };
    return client as unknown as BrokerModelClient;
  }

  it('stream gigante NÃO-repetitivo ⇒ corta no teto, NÃO cresce sem limite, finish_reason marcado', async () => {
    const emitted = { count: 0 };
    const client = neverEndingUniqueDeltas(emitted);
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });

    const result = await caller.call({ messages: [], idempotencyKey: 'k' });

    // 1) ENCERROU (não pendurou no gerador infinito): a promise resolveu.
    // 2) o conteúdo é BOUNDED — perto do teto (4 KiB), não milhões de bytes.
    const bytes = Buffer.byteLength(result.content, 'utf8');
    expect(bytes).toBeGreaterThan(4 * 1024); // cruzou o teto (por isso cortou)
    expect(bytes).toBeLessThan(4 * 1024 + 1024); // mas só pelo último chunk — não explode
    // 3) motivo HONESTO do corte client-side.
    expect(result.finish_reason).toBe('length_client_cap');
    // 4) o gerador foi ABANDONADO cedo — não emitiu um número astronômico de chunks.
    expect(emitted.count).toBeLessThan(200);
    // 5) a UI viu os tokens parciais (renderizou até o corte).
    expect(s.deltas.length).toBeGreaterThan(0);
    expect(s.events).toContain('done'); // onDone() roda no encerramento normal pós-corte
  });

  it('stream normal ABAIXO do teto ⇒ NÃO corta (sem regressão; finish_reason intacto)', async () => {
    const { client } = fakeClient([
      [
        { type: 'start', request_id: 'r1' },
        { type: 'delta', content: 'pequeno e honesto' },
        { type: 'done', finish_reason: 'stop' },
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });
    const res = await caller.call({ messages: [], idempotencyKey: 'k' });
    expect(res.content).toBe('pequeno e honesto');
    expect(res.finish_reason).toBe('stop'); // NÃO marcou o corte
  });
});

// EST-0962 (`--effort`/`/effort`) — reasoning_effort PASSTHROUGH (SEM tier-gate).
describe('StreamingModelCaller — reasoning_effort (--effort//effort)', () => {
  it('boot --effort ⇒ a chamada envia reasoning_effort (SEM tier-gate)', async () => {
    const { client, requests } = fakeClient([
      [
        { type: 'start', request_id: 'r1' },
        { type: 'done', finish_reason: 'stop' },
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'aluy-flux',
      effort: 'minimal',
      sink: s.sink,
    });
    expect(caller.effort).toBe('minimal');
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.reasoning_effort).toBe('minimal');
  });

  it('SEM effort ⇒ a chamada NÃO envia reasoning_effort', async () => {
    const { client, requests } = fakeClient([
      [
        { type: 'start', request_id: 'r1' },
        { type: 'done', finish_reason: 'stop' },
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });
    expect(caller.effort).toBeUndefined();
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.reasoning_effort).toBeUndefined();
  });

  it('setEffort em runtime ⇒ a PRÓXIMA chamada envia reasoning_effort (SEM tier-gate)', async () => {
    const { client, requests } = fakeClient([
      [
        { type: 'start', request_id: 'r1' },
        { type: 'done', finish_reason: 'stop' },
      ],
      [
        { type: 'start', request_id: 'r2' },
        { type: 'done', finish_reason: 'stop' },
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: s.sink });
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.reasoning_effort).toBeUndefined();

    caller.setEffort('high');
    expect(caller.effort).toBe('high');
    await caller.call({ messages: [], idempotencyKey: 'k2' });
    expect(requests[1]?.reasoning_effort).toBe('high');
  });

  it('setEffort(undefined) limpa o reasoning_effort', async () => {
    const { client, requests } = fakeClient([
      [
        { type: 'start', request_id: 'r1' },
        { type: 'done', finish_reason: 'stop' },
      ],
      [
        { type: 'start', request_id: 'r2' },
        { type: 'done', finish_reason: 'stop' },
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'aluy-flux',
      effort: 'low',
      sink: s.sink,
    });
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.reasoning_effort).toBe('low');

    caller.setEffort(undefined);
    expect(caller.effort).toBeUndefined();
    await caller.call({ messages: [], idempotencyKey: 'k2' });
    expect(requests[1]?.reasoning_effort).toBeUndefined();
  });

  it('effort vale em QUALQUER tier (SEM tier-gate, inclusive tier canônico)', async () => {
    const { client, requests } = fakeClient([
      [
        { type: 'start', request_id: 'r1' },
        { type: 'done', finish_reason: 'stop' },
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'aluy-strata', // tier canônico, não custom
      effort: 'minimal',
      sink: s.sink,
    });
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.reasoning_effort).toBe('minimal');
  });

  it('esforço CUSTOM (qualquer string ≤32) é enviado literal', async () => {
    const { client, requests } = fakeClient([
      [
        { type: 'start', request_id: 'r1' },
        { type: 'done', finish_reason: 'stop' },
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'custom',
      model: 'some-model',
      effort: 'my-custom-effort',
      sink: s.sink,
    });
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.reasoning_effort).toBe('my-custom-effort');
  });

  it('setTier NÃO zera o effort (effort independe do tier)', async () => {
    const { client, requests } = fakeClient([
      [
        { type: 'start', request_id: 'r1' },
        { type: 'done', finish_reason: 'stop' },
      ],
      [
        { type: 'start', request_id: 'r2' },
        { type: 'done', finish_reason: 'stop' },
      ],
    ]);
    const s = spySink();
    const caller = new StreamingModelCaller({
      client,
      tier: 'aluy-flux',
      effort: 'low',
      sink: s.sink,
    });
    await caller.call({ messages: [], idempotencyKey: 'k1' });
    expect(requests[0]?.reasoning_effort).toBe('low');

    caller.setTier('aluy-strata');
    expect(caller.effort).toBe('low'); // NÃO foi zerado
    await caller.call({ messages: [], idempotencyKey: 'k2' });
    expect(requests[1]?.reasoning_effort).toBe('low');
  });
});
