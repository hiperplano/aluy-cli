// HUNT-TOOLPARSE (EST-0996 / ADR-0071) — HANDLE de pareamento robusto no batch nativo.
//
// Um broker/provider que OMITA o `id` da tool-call (ou o repita) faria o loop ECOAR
// duas calls com o MESMO `tool_call_id` (`''`/colidente) e emitir dois `role:"tool"`
// de id idêntico — e provedores OpenAI-compat REJEITAM (400) histórico com
// `tool_call_id` duplicado, quebrando o PRÓXIMO turno / `[c] continuar` / resume
// (o risco que a memória ADR-0071 anota). `ensureUniqueToolCallIds` sintetiza um
// handle único e não-vazio por call ANTES do eco/pareamento, sem tocar a catraca.

import { describe, it, expect } from 'vitest';
import { AgentLoop, ensureUniqueToolCallIds } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { NativeToolCall } from '../../src/model/types.js';
import { ScriptedModelCaller, makePorts, allowAllEngine } from './helpers.js';

const tools = () => new ToolRegistry(NATIVE_TOOLS);
const tc = (id: string, name: string, input: Record<string, unknown>): NativeToolCall => ({
  id,
  name,
  input,
});

describe('HUNT-TOOLPARSE — pareamento por id no batch nativo', () => {
  it('ensureUniqueToolCallIds: ids VAZIOS viram handles únicos e não-vazios', () => {
    const out = ensureUniqueToolCallIds([
      tc('', 'write_file', { path: 'a.txt' }),
      tc('', 'write_file', { path: 'b.txt' }),
    ]);
    const ids = out.map((c) => c.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2); // distintos
    // {name,input} preservados (handle é o único campo tocado).
    expect(out.map((c) => c.input)).toEqual([{ path: 'a.txt' }, { path: 'b.txt' }]);
  });

  it('ensureUniqueToolCallIds: ids NÃO-vazios COLIDENTES são desambiguados', () => {
    const out = ensureUniqueToolCallIds([
      tc('dup', 'write_file', { path: 'a.txt' }),
      tc('dup', 'write_file', { path: 'b.txt' }),
    ]);
    expect(new Set(out.map((c) => c.id)).size).toBe(2);
    expect(out[0]!.id).toBe('dup'); // o 1º mantém o handle original
  });

  it('ensureUniqueToolCallIds: caso normal (ids únicos) devolve o MESMO array', () => {
    const input = [tc('x', 'write_file', {}), tc('y', 'run_command', {})];
    expect(ensureUniqueToolCallIds(input)).toBe(input); // sem cópia desnecessária
  });

  it('REGRESSÃO: broker OMITE o id em DUAS calls ⇒ cada role:"tool" tem tool_call_id ÚNICO (não há 400 por id duplicado)', async () => {
    const { ports, fs } = makePorts();
    const model = new ScriptedModelCaller([
      {
        // O provider propôs DUAS tool-calls SEM `id` (broker não mandou o handle).
        toolCalls: [
          tc('', 'write_file', { path: 'one.txt', content: '1' }),
          tc('', 'write_file', { path: 'two.txt', content: '2' }),
        ],
      },
      { text: 'feito.' },
    ]);
    await new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: tools(),
      ports,
    }).run('escreva dois arquivos');

    // Ambas rodaram (efeito real).
    expect(fs.snapshot().get('one.txt')).toBe('1');
    expect(fs.snapshot().get('two.txt')).toBe('2');

    // O turno seguinte (o que o modelo recebe de volta) carrega:
    //  - o eco assistant com tool_calls (model_tool_calls);
    //  - DOIS role:"tool", cada um com um tool_call_id NÃO-VAZIO e DISTINTO.
    const second = model.calls[1]!.messages;
    const toolIds = second.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(toolIds).toHaveLength(2);
    expect(toolIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(toolIds).size).toBe(2); // SEM duplicata (o que o provider rejeitaria)

    // E o eco assistant (model_tool_calls) usa os MESMOS ids (consistência eco↔resultado).
    const assistant = second.find((m) => m.role === 'assistant' && m.tool_calls !== undefined);
    const echoIds = (assistant?.tool_calls ?? []).map((c) => c.id);
    expect(new Set(echoIds)).toEqual(new Set(toolIds));
  });
});
