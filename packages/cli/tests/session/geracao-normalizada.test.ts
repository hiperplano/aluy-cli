// CONTADOR DE GERAÇÃO NORMALIZADO — `↓ N tokens` / `↑ N` independem do provider.
//
// A TUI só consome (a) o sinal normalizado `onGenerated(kind, chars)` e (b) o uso final
// `{tokens_in, tokens_out, tokens_reasoning?}`. Cada cenário abaixo passa os eventos de UM
// backend pelo adaptador REAL (ou, no broker, pelos eventos agregados que ele emite) →
// `StreamingModelCaller` → sink do controller, e afirma o `↓` AO VIVO (estimativa) e depois
// da reconciliação com o uso real.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type BrokerModelClient,
  type ModelStreamEvent,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { OpenAiCompatAdapter } from '../../../cli-core/src/model/local/openai-adapter.js';
import { AnthropicAdapter } from '../../../cli-core/src/model/local/anthropic-adapter.js';
import { newSseAccumulator } from '../../../cli-core/src/model/local/adapter.js';
import { StreamingModelCaller, type StreamSink } from '../../src/session/streaming-caller.js';
import { SessionController } from '../../src/session/controller.js';

const oa = (): OpenAiCompatAdapter =>
  new OpenAiCompatAdapter({ provider: 'openrouter', defaultBaseUrl: 'https://x/v1' });
const an = (): AnthropicAdapter => new AnthropicAdapter({ provider: 'anthropic' } as never);

function viaOpenAi(chunks: readonly unknown[]): ModelStreamEvent[] {
  const a = oa();
  const acc = newSseAccumulator();
  const out: ModelStreamEvent[] = [];
  for (const c of chunks) out.push(...a.mapSse('', JSON.stringify(c), acc));
  out.push(...a.mapSse('', '[DONE]', acc));
  return out;
}
function viaAnthropic(frames: readonly (readonly [string, unknown])[]): ModelStreamEvent[] {
  const a = an();
  const acc = newSseAccumulator();
  const out: ModelStreamEvent[] = [];
  for (const [ev, data] of frames) out.push(...a.mapSse(ev, JSON.stringify(data), acc));
  return out;
}

const ports = {} as unknown as ToolPorts;
const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

/** Roda os eventos pelo caller real e devolve o `↓` visto após cada geração e o final. */
async function rodar(events: readonly ModelStreamEvent[], promptChars = 84_000) {
  const controller = new SessionController({
    model: {
      async call() {
        return { request_id: 'x', content: '', finish_reason: 'stop' };
      },
    },
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports,
    askResolver: approveAll,
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  const interno = controller as unknown as { onParentProgress(s: unknown): void };
  interno.onParentProgress({ kind: 'model-call', promptChars });
  const aoVivo: number[] = [];
  const antesDoUso: { ate?: number } = {};
  const alvo = controller.sink;
  const sink: StreamSink = {
    onStart: () => alvo.onStart?.(),
    onDelta: (c) => alvo.onDelta(c),
    onReasoning: (c) => alvo.onReasoning?.(c),
    onGenerated: (k, n) => {
      alvo.onGenerated?.(k, n);
      aoVivo.push(controller.turnOutputTokens());
    },
    onUsage: (u) => {
      antesDoUso.ate = controller.turnOutputTokens();
      alvo.onUsage?.(u);
    },
    onDone: () => alvo.onDone?.(),
  };
  const client = {
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      for (const ev of events) yield ev;
    },
  } as unknown as BrokerModelClient;
  const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink });
  await caller.call({ messages: [{ role: 'user', content: 'x' }], idempotencyKey: 'k' });
  const r = {
    aoVivo,
    antesDoUso: antesDoUso.ate,
    final: controller.turnOutputTokens(),
    entrada: controller.turnInputTokens(),
  };
  controller.dispose();
  return r;
}

const x = (n: number): string => 'x'.repeat(n);

interface Caso {
  readonly nome: string;
  readonly eventos: () => ModelStreamEvent[];
  /** `↓` observado após cada geração (estimativa chars/4, acumulada). */
  readonly aoVivo: readonly number[];
  /** `↓` ao fim, já reconciliado com o uso real. */
  readonly final: number;
  /** `↑` ao fim: real (`tokens_in`) quando o uso trouxe; senão a estimativa. */
  readonly entrada: { tokens: number; estimado: boolean };
}

const CASOS: readonly Caso[] = [
  {
    nome: 'openai-compat COM raciocínio (reasoning_content) + fala + uso',
    eventos: () =>
      viaOpenAi([
        { choices: [{ delta: { content: null, reasoning_content: x(200) } }] },
        { choices: [{ delta: { content: null, reasoning_content: x(200) } }] },
        { choices: [{ delta: { content: x(200) } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 21_000, completion_tokens: 150 } },
      ]),
    aoVivo: [50, 100, 150],
    final: 150,
    entrada: { tokens: 21_000, estimado: false },
  },
  {
    nome: 'openai-compat SEM raciocínio: só fala; estimativa reconciliada com o uso',
    eventos: () =>
      viaOpenAi([
        { choices: [{ delta: { content: x(80) } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 5_000, completion_tokens: 25 } },
      ]),
    aoVivo: [20],
    final: 25,
    entrada: { tokens: 5_000, estimado: false },
  },
  {
    nome: 'anthropic: thinking_delta + text_delta; output_tokens do message_delta',
    eventos: () =>
      viaAnthropic([
        ['message_start', { type: 'message_start', message: { usage: { input_tokens: 500 } } }],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: x(400) },
          },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: x(40) } },
        ],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 130 },
          },
        ],
      ]),
    aoVivo: [100, 110],
    final: 130,
    entrada: { tokens: 500, estimado: false },
  },
  {
    nome: 'passo SÓ de tool-call (openai-compat): os argumentos streamados contam',
    eventos: () =>
      viaOpenAi([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c1', function: { name: 'edit_file', arguments: x(60) } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: x(60) } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 9_000, completion_tokens: 45 } },
      ]),
    // 60 chars ⇒ 15; 120 ⇒ 30; o evento agregado `tool_call` NÃO conta de novo (já streamou)
    aoVivo: [15, 30],
    final: 45,
    entrada: { tokens: 9_000, estimado: false },
  },
  {
    nome: 'BROKER (agrega a tool-call; sem progress): conta na chegada da call',
    eventos: () => [
      { type: 'start', request_id: 'r' },
      { type: 'delta', content: x(40) },
      { type: 'tool_call', call: { id: 'c', name: 'read_file', input: { path: 'a.txt' } } },
      { type: 'usage', usage: { request_id: 'r', tier: 't', tokens_in: 7_000, tokens_out: 33 } },
      { type: 'done', finish_reason: 'tool_calls' },
    ],
    aoVivo: [
      10,
      10 +
        Math.ceil(
          JSON.stringify({ id: 'c', name: 'read_file', input: { path: 'a.txt' } }).length / 4,
        ),
    ],
    final: 33,
    entrada: { tokens: 7_000, estimado: false },
  },
  {
    nome: 'só uso (provider esconde o raciocínio: o1/o3) — reasoning_tokens DENTRO de completion_tokens',
    eventos: () =>
      viaOpenAi([
        { choices: [{ delta: { content: x(40) } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 3_000,
            completion_tokens: 940,
            completion_tokens_details: { reasoning_tokens: 900 },
          },
        },
      ]),
    aoVivo: [10],
    final: 940,
    entrada: { tokens: 3_000, estimado: false },
  },
  {
    nome: 'só uso — provider reporta o raciocínio FORA de completion_tokens (soma)',
    eventos: () =>
      viaOpenAi([
        { choices: [{ delta: { content: x(40) } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 3_000,
            completion_tokens: 40,
            completion_tokens_details: { reasoning_tokens: 900 },
          },
        },
      ]),
    aoVivo: [10],
    final: 940,
    entrada: { tokens: 3_000, estimado: false },
  },
  {
    nome: 'sem uso nenhum: a estimativa vale e o ↑ segue estimado (chars/4 das mensagens)',
    eventos: () => [
      { type: 'start', request_id: 'r' },
      { type: 'delta', content: x(80) },
      { type: 'done', finish_reason: 'stop' },
    ],
    aoVivo: [20],
    final: 20,
    entrada: { tokens: 21_000, estimado: true },
  },
];

describe('contador de geração normalizado (todos os backends)', () => {
  it.each(CASOS)('$nome', async (c) => {
    const r = await rodar(c.eventos());
    expect(r.aoVivo).toEqual(c.aoVivo);
    expect(r.final).toBe(c.final);
    expect(r.entrada).toEqual(c.entrada);
  });
});

describe('↑ calibrado pela sobrecarga medida (schema de tools fora das mensagens)', () => {
  it('a 2ª estimativa soma a diferença real − chars/4 da chamada anterior', () => {
    const controller = new SessionController({
      model: {
        async call() {
          return { request_id: 'x', content: '', finish_reason: 'stop' };
        },
      },
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
    });
    const i = controller as unknown as { onParentProgress(s: unknown): void };
    i.onParentProgress({ kind: 'model-call', promptChars: 40_000 });
    expect(controller.turnInputTokens()).toEqual({ tokens: 10_000, estimado: true });
    controller.sink.onUsage?.({ request_id: 'r', tier: 't', tokens_in: 15_000, tokens_out: 5 });
    expect(controller.turnInputTokens()).toEqual({ tokens: 15_000, estimado: false });
    i.onParentProgress({ kind: 'model-call', promptChars: 44_000 });
    expect(controller.turnInputTokens()).toEqual({ tokens: 11_000 + 5_000, estimado: true });
    controller.dispose();
  });
});
