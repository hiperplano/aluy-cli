// Auditoria — PROMPT-ENXUTO no StreamingModelCaller (caminho de stream da TUI):
//   • com `tools` nativo no body a variante SEM o catálogo em texto (`messagesNative`) é a que
//     vai; no degrade 422 (passada sem tools) volta a completa (`messages`);
//   • `onGenerated` recebe o tamanho do que foi gerado por canal: texto, raciocínio e
//     argumentos de tool — por progresso quando o provider streama, ou pela call agregada
//     (uma vez) quando não streama.

import { describe, expect, it } from 'vitest';
import {
  BrokerError,
  NativeToolsCapability,
  type BrokerModelClient,
  type ModelStreamEvent,
  type StreamCallArgs,
  type ToolFunctionSchema,
} from '@hiperplano/aluy-cli-core';
import { StreamingModelCaller, type StreamSink } from '../../src/session/streaming-caller.js';

const SCHEMA: readonly ToolFunctionSchema[] = [
  {
    type: 'function',
    function: { name: 'edit_file', description: 'x', parameters: { type: 'object' } },
  },
];

function fakeClient(responder: (req: StreamCallArgs['request']) => ModelStreamEvent[]): {
  client: BrokerModelClient;
  requests: StreamCallArgs['request'][];
} {
  const requests: StreamCallArgs['request'][] = [];
  const client = {
    async *stream(args: StreamCallArgs): AsyncGenerator<ModelStreamEvent> {
      requests.push(args.request);
      for (const ev of responder(args.request)) yield ev;
    },
  };
  return { client: client as unknown as BrokerModelClient, requests };
}

const COMPLETA = [{ role: 'system' as const, content: 'COMPLETA com catálogo em texto' }];
const ENXUTA = [{ role: 'system' as const, content: 'ENXUTA sem catálogo' }];
const texto = (m: StreamCallArgs['request']['messages']): string =>
  m.map((x) => (typeof x.content === 'string' ? x.content : '')).join('|');

describe('variante do prompt segue a mesma flag do `tools` nativo', () => {
  it('com tools nativo: manda a ENXUTA; sem capacidade de tools: manda a COMPLETA', async () => {
    const a = fakeClient(() => [
      { type: 'start', request_id: 'r' },
      { type: 'done', finish_reason: 'stop' },
    ]);
    await new StreamingModelCaller({
      client: a.client,
      tier: 'aluy-flux',
      sink: { onDelta: () => {} },
      nativeTools: new NativeToolsCapability({ tools: SCHEMA }),
    }).call({ messages: COMPLETA, messagesNative: ENXUTA, idempotencyKey: 'k' });
    expect(a.requests[0]!.tools).toBeDefined();
    expect(texto(a.requests[0]!.messages)).toContain('ENXUTA');

    const b = fakeClient(() => [
      { type: 'start', request_id: 'r' },
      { type: 'done', finish_reason: 'stop' },
    ]);
    await new StreamingModelCaller({
      client: b.client,
      tier: 'aluy-flux',
      sink: { onDelta: () => {} },
    }).call({ messages: COMPLETA, messagesNative: ENXUTA, idempotencyKey: 'k' });
    expect(b.requests[0]!.tools).toBeUndefined();
    expect(texto(b.requests[0]!.messages)).toContain('COMPLETA');
  });

  it('422 de tools: a repetição SEM tools usa a COMPLETA (o modelo precisa do catálogo em texto)', async () => {
    const { client, requests } = fakeClient((req) => {
      if (req.tools !== undefined) {
        throw new BrokerError({ status: 422, code: 'TOOLS_UNSUPPORTED', detail: 'sem tools' });
      }
      return [
        { type: 'start', request_id: 'r' },
        { type: 'done', finish_reason: 'stop' },
      ];
    });
    await new StreamingModelCaller({
      client,
      tier: 'aluy-flux',
      sink: { onDelta: () => {} },
      nativeTools: new NativeToolsCapability({ tools: SCHEMA }),
    }).call({ messages: COMPLETA, messagesNative: ENXUTA, idempotencyKey: 'k' });
    expect(requests).toHaveLength(2);
    expect(texto(requests[0]!.messages)).toContain('ENXUTA');
    expect(requests[1]!.tools).toBeUndefined();
    expect(texto(requests[1]!.messages)).toContain('COMPLETA');
  });

  it('sem `messagesNative` (caller antigo) usa `messages` mesmo com tools nativo', async () => {
    const { client, requests } = fakeClient(() => [
      { type: 'start', request_id: 'r' },
      { type: 'done', finish_reason: 'stop' },
    ]);
    await new StreamingModelCaller({
      client,
      tier: 'aluy-flux',
      sink: { onDelta: () => {} },
      nativeTools: new NativeToolsCapability({ tools: SCHEMA }),
    }).call({ messages: COMPLETA, idempotencyKey: 'k' });
    expect(texto(requests[0]!.messages)).toContain('COMPLETA');
  });
});

describe('onGenerated · tamanho gerado por canal', () => {
  async function aguardar(eventos: ModelStreamEvent[]): Promise<Array<[string, number]>> {
    const vistos: Array<[string, number]> = [];
    const sink: StreamSink = {
      onDelta: () => {},
      onReasoning: () => {},
      onGenerated: (k, n) => vistos.push([k, n]),
    };
    const { client } = fakeClient(() => eventos);
    await new StreamingModelCaller({
      client,
      tier: 'aluy-flux',
      sink,
      nativeTools: new NativeToolsCapability({ tools: SCHEMA }),
    }).call({ messages: COMPLETA, idempotencyKey: 'k' });
    return vistos;
  }

  it('texto e raciocínio: um evento por delta, com o tamanho de cada um', async () => {
    const v = await aguardar([
      { type: 'start', request_id: 'r' },
      { type: 'reasoning', content: 'hmm...' },
      { type: 'delta', content: 'olá' },
      { type: 'delta', content: ' mundo' },
      { type: 'done', finish_reason: 'stop' },
    ]);
    expect(v).toEqual([
      ['reasoning', 6],
      ['text', 3],
      ['text', 6],
    ]);
  });

  it('provider que streama os argumentos: cada `progress` conta e a call agregada NÃO conta de novo', async () => {
    const call = { id: 'c1', name: 'edit_file', input: { path: 'a.txt' } };
    const v = await aguardar([
      { type: 'start', request_id: 'r' },
      { type: 'progress', kind: 'tool_args', chars: 10 },
      { type: 'progress', kind: 'tool_args', chars: 7 },
      { type: 'tool_call', call },
      { type: 'done', finish_reason: 'tool_calls' },
    ]);
    expect(v).toEqual([
      ['tool_args', 10],
      ['tool_args', 7],
    ]);
  });

  it('provider que NÃO streama (broker agrega): a call inteira conta UMA vez pelo tamanho do JSON', async () => {
    const call = { id: 'c1', name: 'edit_file', input: { path: 'a.txt' } };
    const v = await aguardar([
      { type: 'start', request_id: 'r' },
      { type: 'tool_call', call },
      { type: 'done', finish_reason: 'tool_calls' },
    ]);
    expect(v).toEqual([['tool_args', JSON.stringify(call).length]]);
  });
});
