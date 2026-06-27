// EST-0996 — TOOL-CALLING NATIVO no broker-client (envio de `tools` + parse do
// `tool_calls` estruturado: stream `event: tool_call` E não-stream JSON).
//
// CLI-SEC-7/HG-2: `tools` é o CATÁLOGO LOCAL de ferramentas — nome/descrição/JSONSchema —
// NÃO credencial. Ok mandar. Os asserts conferem que o corpo carrega `tools`/`tool_choice`
// e que NENHUM provider/api_key/base_url vaza (o `cli-sec-7.test.ts` cobre o resto).

import { describe, expect, it } from 'vitest';
import {
  BrokerModelClient,
  buildChatBody,
  parseNativeToolCall,
  parseToolCalls,
  pushOrMergeToolCall,
} from '../../src/model/broker-client.js';
import type { NativeToolCall } from '../../src/model/types.js';
import { BrokerError } from '../../src/model/errors.js';
import type { ModelCallRequest, ToolFunctionSchema } from '../../src/model/types.js';
import { makeBrokerFetch, sseBody } from './helpers.js';

const BASE = 'https://broker.test';
const token = async (): Promise<string> => 'eyJhbGciOiJ.payload.sig';

const TOOLS: readonly ToolFunctionSchema[] = [
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Escreve um arquivo.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

function req(over: Partial<ModelCallRequest> = {}): ModelCallRequest {
  return { tier: 'aluy-strata', messages: [{ role: 'user', content: 'Oi' }], ...over };
}

describe('EST-0996 — buildChatBody com tools', () => {
  it('manda `tools`/`tool_choice` quando há tools (default tool_choice=auto)', () => {
    const body = buildChatBody(req({ tools: TOOLS }), true);
    expect(body.tools).toEqual(TOOLS);
    expect(body.tool_choice).toBe('auto');
    // HG-2: nenhum provider/credencial — só o catálogo + tier + messages.
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('api_key');
    expect(body).not.toHaveProperty('base_url');
  });

  it('respeita tool_choice explícito e parallel_tool_calls', () => {
    const body = buildChatBody(
      req({ tools: TOOLS, tool_choice: 'required', parallel_tool_calls: true }),
      true,
    );
    expect(body.tool_choice).toBe('required');
    expect(body.parallel_tool_calls).toBe(true);
  });

  it('SEM tools (baseline) ⇒ corpo NÃO carrega tools/tool_choice (não-regressão)', () => {
    const body = buildChatBody(req(), true);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('parallel_tool_calls');
  });

  it('tools vazio ⇒ não emite tools (degrade limpo)', () => {
    const body = buildChatBody(req({ tools: [] }), true);
    expect(body).not.toHaveProperty('tools');
  });

  it('serializa role:"tool" (tool_call_id) e o eco assistant(tool_calls) no corpo', () => {
    const body = buildChatBody(
      req({
        messages: [
          { role: 'user', content: 'crie' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', name: 'edit_file', input: { path: 'a.txt' } }],
          },
          { role: 'tool', content: 'criado', tool_call_id: 'c1' },
        ],
      }),
      false,
    );
    const msgs = body.messages as Record<string, unknown>[];
    const assistant = msgs.find((m) => m.role === 'assistant')!;
    // O eco vira o shape de função do provider: function.arguments STRING JSON.
    const calls = assistant.tool_calls as Record<string, unknown>[];
    expect(calls[0]!.id).toBe('c1');
    expect(calls[0]!.type).toBe('function');
    const fn = calls[0]!.function as Record<string, unknown>;
    expect(fn.name).toBe('edit_file');
    expect(JSON.parse(fn.arguments as string)).toEqual({ path: 'a.txt' });
    const toolMsg = msgs.find((m) => m.role === 'tool')!;
    expect(toolMsg.tool_call_id).toBe('c1');
  });
});

describe('EST-0996 — parseNativeToolCall / parseToolCalls (boundary tolerante)', () => {
  // O SHAPE REAL do broker (capturado do SSE cru): `arguments` STRING JSON no TOPO
  // (NÃO dentro de `function`) + `index`. Era o caso que furava ⇒ input vazio ⇒ a
  // tool rodava sem args ("run_command requer command"). Mock ≠ realidade pegou todo
  // mundo no #111. Este é o caso que TEM que passar.
  it('shape REAL do broker {id, name, arguments(JSON string no TOPO), index}', () => {
    const call = parseNativeToolCall({
      id: 'call_5a5c',
      name: 'run_command',
      arguments: '{"command":"ls -la"}',
      index: 0,
    });
    expect(call).toEqual({ id: 'call_5a5c', name: 'run_command', input: { command: 'ls -la' } });
  });

  it('shape REAL do broker: arguments STRING inválida ⇒ input {} (não quebra)', () => {
    const call = parseNativeToolCall({
      id: 'call_x',
      name: 'run_command',
      arguments: '{bad',
      index: 1,
    });
    expect(call).toEqual({ id: 'call_x', name: 'run_command', input: {} });
  });

  it('shape REAL do broker: arguments AUSENTE ⇒ input {} (não quebra)', () => {
    const call = parseNativeToolCall({ id: 'call_y', name: 'list_dir', index: 2 });
    expect(call).toEqual({ id: 'call_y', name: 'list_dir', input: {} });
  });

  it('tolerância: shape OpenAI aninhado {id, function:{name, arguments(JSON string)}}', () => {
    const call = parseNativeToolCall({
      id: 'x1',
      type: 'function',
      function: { name: 'run_command', arguments: '{"command":"ls"}' },
    });
    expect(call).toEqual({ id: 'x1', name: 'run_command', input: { command: 'ls' } });
  });

  it('tolerância: shape achatado normalizado {id, name, input}', () => {
    const call = parseNativeToolCall({ id: 'x2', name: 'grep', input: { pattern: 'foo' } });
    expect(call).toEqual({ id: 'x2', name: 'grep', input: { pattern: 'foo' } });
  });

  it('tolerância: arguments STRING inválido em function.arguments ⇒ input {} (não lança)', () => {
    const call = parseNativeToolCall({ id: 'x3', function: { name: 'x', arguments: '{bad' } });
    expect(call).toEqual({ id: 'x3', name: 'x', input: {} });
  });

  it('precedência: input-objeto > function.arguments > arguments-topo', () => {
    // input-objeto ganha de tudo.
    expect(
      parseNativeToolCall({
        name: 'f',
        input: { a: 1 },
        function: { arguments: '{"b":2}' },
        arguments: '{"c":3}',
      }),
    ).toEqual({ id: '', name: 'f', input: { a: 1 } });
    // sem input-objeto, function.arguments ganha do arguments-topo.
    expect(
      parseNativeToolCall({ name: 'f', function: { arguments: '{"b":2}' }, arguments: '{"c":3}' }),
    ).toEqual({ id: '', name: 'f', input: { b: 2 } });
  });

  it('sem name ⇒ null (descarta)', () => {
    expect(parseNativeToolCall({ id: 'x4', input: {} })).toBeNull();
    expect(parseNativeToolCall('lixo')).toBeNull();
  });

  // #6 — `typeof [] === 'object'` fazia um ARRAY passar por `isRecord` ⇒ um
  // `input:[]` / `arguments:[...]` / `function:[...]` entrava castado a Record SEM
  // normalização (input malformado). Array NÃO é mapa de args ⇒ tem que cair em `{}`.
  it('#6 — input ARRAY ⇒ NÃO é tratado como Record (normaliza p/ {})', () => {
    // input array no shape achatado: não vira o Record, cai no fallback `{}`.
    expect(parseNativeToolCall({ id: 'a1', name: 'grep', input: [1, 2, 3] })).toEqual({
      id: 'a1',
      name: 'grep',
      input: {},
    });
  });

  it('#6 — arguments ARRAY (topo e function.arguments) ⇒ coerceArgs devolve {}', () => {
    // arguments array no topo.
    expect(parseNativeToolCall({ id: 'a2', name: 'run_command', arguments: ['ls'] })).toEqual({
      id: 'a2',
      name: 'run_command',
      input: {},
    });
    // arguments array dentro de function.
    expect(
      parseNativeToolCall({ id: 'a3', function: { name: 'x', arguments: [{ k: 'v' }] } }),
    ).toEqual({ id: 'a3', name: 'x', input: {} });
  });

  it('#6 — raw ARRAY / function ARRAY ⇒ não passa por isRecord (descarta/ignora)', () => {
    // o próprio raw sendo array ⇒ null (não é um tool-call).
    expect(parseNativeToolCall([{ name: 'grep' }])).toBeNull();
    // `function` array ⇒ ignorado (sem name no topo ⇒ null).
    expect(parseNativeToolCall({ id: 'a4', function: ['x'] })).toBeNull();
  });

  it('parseToolCalls extrai o array (top-level e dentro de message), saneando lixo', () => {
    const top = parseToolCalls({ tool_calls: [{ id: 'a', name: 'grep', input: {} }, 42, {}] });
    expect(top.map((c) => c.id)).toEqual(['a']);
    const nested = parseToolCalls({ message: { tool_calls: [{ id: 'b', name: 'read_file' }] } });
    expect(nested.map((c) => c.name)).toEqual(['read_file']);
    expect(parseToolCalls({})).toEqual([]);
  });
});

describe('EST-0996 — stream: event tool_call AGREGADO ⇒ ModelCallResult.tool_calls', () => {
  // PROVA DE PONTA com o SHAPE REAL do broker: `event: tool_call` com `arguments`
  // STRING JSON no TOPO + `index` (o payload exato capturado do SSE cru). Antes do
  // fix, o `input` saía vazio aqui ⇒ a tool rodava sem args. Misturo também uma
  // entrada no shape aninhado p/ provar a tolerância no MESMO stream.
  it('acumula tool_calls do SSE com o shape REAL do broker (arguments string no topo)', async () => {
    const sse = sseBody([
      { event: 'start', data: { request_id: 'r1', tier: 'aluy-strata', session_id: 's1' } },
      {
        event: 'tool_call',
        // SHAPE REAL: achatado, `arguments` STRING no topo, `index`.
        data: { id: 'call_5a5c', name: 'run_command', arguments: '{"command":"ls -la"}', index: 0 },
      },
      {
        event: 'tool_call',
        // Tolerância: shape aninhado OpenAI no MESMO stream (não regride).
        data: {
          id: 'c2',
          type: 'function',
          function: { name: 'edit_file', arguments: '{"path":"a.txt"}' },
          index: 1,
        },
      },
      {
        event: 'usage',
        data: { request_id: 'r1', tier: 'aluy-strata', tokens_in: 5, tokens_out: 3 },
      },
      { event: 'done', data: { finish_reason: 'tool_calls' } },
    ]);
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });

    const res = await client.call({ request: req({ tools: TOOLS }) });

    expect(res.tool_calls).toBeDefined();
    expect(res.tool_calls!.map((c) => ({ id: c.id, name: c.name, input: c.input }))).toEqual([
      // O `input` NÃO está vazio: o `command` chegou (o bug que o #111 não pegou).
      { id: 'call_5a5c', name: 'run_command', input: { command: 'ls -la' } },
      { id: 'c2', name: 'edit_file', input: { path: 'a.txt' } },
    ]);
    // O request MANDOU tools (catálogo) — prova o envio no caminho de stream.
    expect((calls[0]!.body as Record<string, unknown>).tools).toBeDefined();
  });

  it('stream() emite o evento tool_call discriminado, na ordem', async () => {
    const sse = sseBody([
      { event: 'start', data: { request_id: 'r1', tier: 'aluy-strata' } },
      { event: 'delta', data: { content: 'pensando…' } },
      { event: 'tool_call', data: { id: 'c1', name: 'grep', input: { pattern: 'x' } } },
      { event: 'done', data: { finish_reason: 'tool_calls' } },
    ]);
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });

    const types: string[] = [];
    let captured: unknown;
    for await (const ev of client.stream({ request: req({ tools: TOOLS }) })) {
      types.push(ev.type);
      if (ev.type === 'tool_call') captured = ev.call;
    }
    expect(types).toContain('tool_call');
    expect(captured).toEqual({ id: 'c1', name: 'grep', input: { pattern: 'x' } });
  });

  it('SEM tool_call no stream ⇒ result.tool_calls AUSENTE (cai no parser de texto)', async () => {
    const sse = sseBody([
      { event: 'start', data: { request_id: 'r1', tier: 'aluy-strata' } },
      { event: 'delta', data: { content: 'só texto' } },
      { event: 'done', data: { finish_reason: 'stop' } },
    ]);
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const res = await client.call({ request: req() });
    expect(res.tool_calls).toBeUndefined();
    expect(res.content).toBe('só texto');
  });
});

describe('EST-0996 — 422 TOOLS_UNSUPPORTED', () => {
  it('BrokerError.isToolsUnsupported casa por code+status', () => {
    const err = new BrokerError({ status: 422, code: 'TOOLS_UNSUPPORTED', detail: 'sem tools' });
    expect(err.isToolsUnsupported).toBe(true);
    const other = new BrokerError({ status: 422, code: 'VALIDATION_FAILED' });
    expect(other.isToolsUnsupported).toBe(false);
  });

  it('o broker pode responder 422 TOOLS_UNSUPPORTED como problem+json (LANÇA BrokerError)', async () => {
    const { fetch } = makeBrokerFetch({
      status: 422,
      json: { status: 422, code: 'TOOLS_UNSUPPORTED', detail: 'modelo sem function-calling' },
    });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    await expect(client.call({ request: req({ tools: TOOLS }) })).rejects.toMatchObject({
      name: 'BrokerError',
      code: 'TOOLS_UNSUPPORTED',
    });
  });
});

// HUNT-SSE — COALESCÊNCIA de `event: tool_call` fragmentado/duplicado por `id`.
//
// Bug: se o broker emitir MAIS DE UM `event: tool_call` com o MESMO `id` (provider
// que vaza os deltas de `function.arguments` sem aprumar — nome num frame, args
// noutro), o acumulador EMPILHAVA duas `NativeToolCall` de id duplicado. O loop então
// ECOA dois `tool_calls` de mesmo id e gera dois `role:"tool"` com o MESMO
// `tool_call_id` ⇒ provedores OpenAI-compat REJEITAM (400) ⇒ turno/`[c]`/resume quebram.
describe('HUNT-SSE — pushOrMergeToolCall (coalescência por id)', () => {
  it('funde dois frames do MESMO id: nome no 1º, args no 2º ⇒ UMA call com args', () => {
    const acc: NativeToolCall[] = [];
    pushOrMergeToolCall(acc, { id: 'call_1', name: 'edit_file', input: {} });
    pushOrMergeToolCall(acc, { id: 'call_1', name: 'edit_file', input: { path: 'a.txt' } });
    expect(acc).toEqual([{ id: 'call_1', name: 'edit_file', input: { path: 'a.txt' } }]);
  });

  it('frame só-nome (input {}) NÃO apaga args já acumulados do mesmo id', () => {
    const acc: NativeToolCall[] = [];
    pushOrMergeToolCall(acc, { id: 'c', name: 'run', input: { command: 'ls' } });
    pushOrMergeToolCall(acc, { id: 'c', name: 'run', input: {} });
    expect(acc).toEqual([{ id: 'c', name: 'run', input: { command: 'ls' } }]);
  });

  it('chaves do frame novo sobrescrevem; preserva as antigas (merge raso)', () => {
    const acc: NativeToolCall[] = [];
    pushOrMergeToolCall(acc, { id: 'c', name: 'f', input: { a: 1, b: 2 } });
    pushOrMergeToolCall(acc, { id: 'c', name: 'f', input: { b: 9, c: 3 } });
    expect(acc).toEqual([{ id: 'c', name: 'f', input: { a: 1, b: 9, c: 3 } }]);
  });

  it('ids DISTINTOS preservam DUAS calls na ordem (paralelo — não funde)', () => {
    const acc: NativeToolCall[] = [];
    pushOrMergeToolCall(acc, { id: 'c1', name: 'f', input: { x: 1 } });
    pushOrMergeToolCall(acc, { id: 'c2', name: 'g', input: { y: 2 } });
    expect(acc.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('id VAZIO não parea ⇒ sempre empilha (best-effort, baseline)', () => {
    const acc: NativeToolCall[] = [];
    pushOrMergeToolCall(acc, { id: '', name: 'f', input: { x: 1 } });
    pushOrMergeToolCall(acc, { id: '', name: 'f', input: { x: 2 } });
    expect(acc).toHaveLength(2);
  });

  it('REGRESSÃO end-to-end: stream com 2 frames tool_call do MESMO id ⇒ UMA call agregada', async () => {
    // Sem o fix: `res.tool_calls` teria DUAS entradas com id `call_1` (a 1ª com
    // input {}, a 2ª com os args) ⇒ tool_call_id duplicado no histórico ⇒ 400.
    const sse = sseBody([
      { event: 'start', data: { request_id: 'r1' } },
      // frame 1: nome, ainda sem args (arguments STRING vazia).
      { event: 'tool_call', data: { id: 'call_1', name: 'edit_file', arguments: '' } },
      // frame 2: MESMO id, agora com os args completos.
      {
        event: 'tool_call',
        data: { id: 'call_1', name: 'edit_file', arguments: '{"path":"a.txt"}' },
      },
      { event: 'done', data: { finish_reason: 'tool_calls' } },
    ]);
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const res = await client.call({ request: req({ tools: TOOLS }) });
    expect(res.tool_calls).toEqual([{ id: 'call_1', name: 'edit_file', input: { path: 'a.txt' } }]);
    // O pareamento depende de id ÚNICO: nenhum id repetido sobrevive.
    const ids = (res.tool_calls ?? []).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
