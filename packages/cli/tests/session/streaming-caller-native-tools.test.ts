// EST-0996 — TOOL-CALLING NATIVO no StreamingModelCaller (caminho de STREAM da TUI).
//
// Prova, na camada que faz o `aluy` mostrar token-a-token:
//  • manda `tools` quando a capacidade está ativa, acumula `event: tool_call` no
//    `ModelCallResult.tool_calls`, e os deltas seguem indo pro sink (UI);
//  • num `422 TOOLS_UNSUPPORTED`, REPETE 1× SEM tools (degrade gracioso, #99) e
//    a sessão segue sem tools;
//  • `attachNativeTools` liga a capacidade DEPOIS de construído (o controller é o
//    dono do toolset final).

import { describe, expect, it } from 'vitest';
import {
  BrokerError,
  NativeToolsCapability,
  type BrokerModelClient,
  type ModelStreamEvent,
  type StreamCallArgs,
  type ToolFunctionSchema,
} from '@aluy/cli-core';
import { StreamingModelCaller, type StreamSink } from '../../src/session/streaming-caller.js';

const SCHEMA: readonly ToolFunctionSchema[] = [
  {
    type: 'function',
    function: { name: 'edit_file', description: 'x', parameters: { type: 'object' } },
  },
];

/** Fake do cliente: o `responder` decide os eventos (ou lança) por request. */
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

const noopSink: StreamSink = { onDelta: () => {} };

describe('EST-0996 — StreamingModelCaller nativo', () => {
  it('manda tools e acumula event:tool_call em result.tool_calls (deltas seguem pro sink)', async () => {
    const deltas: string[] = [];
    const sink: StreamSink = { onDelta: (c) => deltas.push(c) };
    const { client, requests } = fakeClient(() => [
      { type: 'start', request_id: 'r1' },
      { type: 'delta', content: 'pensando…' },
      { type: 'tool_call', call: { id: 'c1', name: 'edit_file', input: { path: 'a.txt' } } },
      { type: 'done', finish_reason: 'tool_calls' },
    ]);
    const caller = new StreamingModelCaller({
      client,
      tier: 'aluy-flux',
      sink,
      nativeTools: new NativeToolsCapability({ tools: SCHEMA }),
    });

    const res = await caller.call({
      messages: [{ role: 'user', content: 'x' }],
      idempotencyKey: 'k',
    });

    expect(requests[0]!.tools).toBeDefined();
    expect(res.tool_calls).toEqual([{ id: 'c1', name: 'edit_file', input: { path: 'a.txt' } }]);
    // A prosa foi pro sink (UI); a tool-call NÃO (vira a linha ⏺ que o loop pinta).
    expect(deltas).toEqual(['pensando…']);
  });

  it('422 TOOLS_UNSUPPORTED ⇒ repete SEM tools (degrade) e prossegue', async () => {
    const { client, requests } = fakeClient((req) => {
      if (req.tools !== undefined) {
        throw new BrokerError({ status: 422, code: 'TOOLS_UNSUPPORTED', detail: 'sem tools' });
      }
      return [
        { type: 'start', request_id: 'r2' },
        { type: 'delta', content: 'texto' },
        { type: 'done', finish_reason: 'stop' },
      ];
    });
    const cap = new NativeToolsCapability({ tools: SCHEMA });
    const caller = new StreamingModelCaller({
      client,
      tier: 'aluy-flux',
      sink: noopSink,
      nativeTools: cap,
    });

    const res = await caller.call({
      messages: [{ role: 'user', content: 'x' }],
      idempotencyKey: 'k',
    });

    expect(res.content).toBe('texto');
    // 1ª COM tools (422), 2ª SEM tools (ok).
    expect(requests[0]!.tools).toBeDefined();
    expect(requests[1]!.tools).toBeUndefined();
    // A sessão DESLIGOU o nativo: a PRÓXIMA chamada já não manda tools (1 só passada).
    const before = requests.length;
    await caller.call({ messages: [{ role: 'user', content: 'y' }], idempotencyKey: 'k2' });
    expect(requests.length - before).toBe(1);
    expect(requests[requests.length - 1]!.tools).toBeUndefined();
  });

  it('attachNativeTools liga a capacidade depois de construído (o controller é o dono)', async () => {
    const { client, requests } = fakeClient(() => [
      { type: 'start', request_id: 'r1' },
      { type: 'done', finish_reason: 'stop' },
    ]);
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: noopSink });
    // Antes do attach: SEM tools.
    await caller.call({ messages: [{ role: 'user', content: 'a' }], idempotencyKey: 'k1' });
    expect(requests[0]!.tools).toBeUndefined();
    // Depois do attach: COM tools.
    caller.attachNativeTools(new NativeToolsCapability({ tools: SCHEMA }));
    await caller.call({ messages: [{ role: 'user', content: 'b' }], idempotencyKey: 'k2' });
    expect(requests[1]!.tools).toBeDefined();
  });

  // HUNT-SSE — fragmentação de tool_call por id no caminho de STREAM da TUI: dois
  // `event: tool_call` do MESMO id (nome no 1º, args no 2º) DEVEM coalescer numa só
  // call. Sem o fix, `result.tool_calls` traria id duplicado ⇒ `tool_call_id` repetido
  // no histórico ⇒ 400 do provider no `[c] continuar`/resume.
  it('coalesce dois event:tool_call do MESMO id em UMA call (anti-id-duplicado)', async () => {
    const { client } = fakeClient(() => [
      { type: 'start', request_id: 'r1' },
      { type: 'tool_call', call: { id: 'c1', name: 'edit_file', input: {} } },
      { type: 'tool_call', call: { id: 'c1', name: 'edit_file', input: { path: 'a.txt' } } },
      { type: 'done', finish_reason: 'tool_calls' },
    ]);
    const caller = new StreamingModelCaller({
      client,
      tier: 'aluy-flux',
      sink: noopSink,
      nativeTools: new NativeToolsCapability({ tools: SCHEMA }),
    });
    const res = await caller.call({
      messages: [{ role: 'user', content: 'crie' }],
      idempotencyKey: 'k',
    });
    expect(res.tool_calls).toEqual([{ id: 'c1', name: 'edit_file', input: { path: 'a.txt' } }]);
    const ids = (res.tool_calls ?? []).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // nenhum id repetido
  });
});
