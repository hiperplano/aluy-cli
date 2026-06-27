// HUNT-LOOP — bug-hunt: batch de tool_calls NATIVO interrompido a meio (teto de
// tool-calls) deixava o eco `model_tool_calls` SEM os `tool_result` pareados ⇒
// histórico CORROMPIDO (provider rejeita assistant.tool_calls sem tool result).
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { NativeToolCall } from '../../src/model/types.js';
import { ScriptedModelCaller, makePorts, allowAllEngine } from './helpers.js';

function tc(id: string, name: string, input: Record<string, unknown>): NativeToolCall {
  return { id, name, input };
}
const tools = () => new ToolRegistry(NATIVE_TOOLS);

describe('HUNT-LOOP — batch nativo interrompido pelo teto', () => {
  it('todo tool_call ecoado tem um tool_result pareado (mesmo parando no teto)', async () => {
    const { ports } = makePorts();
    // Um turno com 3 tool_calls nativas; o teto de tool-calls é 1.
    const model = new ScriptedModelCaller([
      {
        toolCalls: [
          tc('c1', 'write_file', { path: 'a.txt', content: 'a' }),
          tc('c2', 'write_file', { path: 'b.txt', content: 'b' }),
          tc('c3', 'write_file', { path: 'c.txt', content: 'c' }),
        ],
      },
      { text: 'pronto' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: tools(),
      ports,
      sessionId: 'sess-batch',
      limits: { maxIterations: 50, maxToolCalls: 1, maxTokens: 1_000_000 },
    });

    const res = await loop.run('escreva 3 arquivos');
    expect(res.stop.kind).toBe('limit');

    // INVARIANTE de protocolo: todo id ecoado em `model_tool_calls` deve ter um
    // `tool_result` com o MESMO `toolCallId` no histórico.
    const echoedIds = res.history
      .filter((h) => h.role === 'model_tool_calls')
      .flatMap((h) => (h.role === 'model_tool_calls' ? h.calls.map((c) => c.id) : []));
    const resultIds = new Set(
      res.history
        .filter((h) => h.role === 'tool_result')
        .map((h) => (h.role === 'tool_result' ? h.toolCallId : '')),
    );
    expect(echoedIds.length).toBe(3);
    for (const id of echoedIds) {
      expect(resultIds.has(id)).toBe(true);
    }
  });
});
