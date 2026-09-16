// HISTÓRICO DO TURNO INTERROMPIDO — o ESC não pode apagar o turno da memória da conversa.
//
// Visto pelo dono em 16/09: pediu três agentes, apertou ESC e perguntou "o que vc fez"; o
// modelo respondeu "nada ainda" (e inventou outra conversa). Com um provider falso: a chamada
// seguinte ao ESC levava só `[system, "o que vc fez"]` — o pedido, a chamada do
// `spawn_agent` e o aviso de que os agentes seguiam rodando tinham sumido. Na `main` também.
//
// A causa: o controller só guarda o histórico da conversa quando o turno TERMINA
// (`afterRun`); o cancelamento sobe como `ModelCallAbortedError` e o histórico parcial, que
// vivia só dentro do loop, era descartado. Agora o erro carrega o parcial, e
// `closeInterruptedHistory` o deixa válido para o provider (toda tool-call nativa ganha
// resultado — a API da OpenAI recusa `tool_calls` sem `role:"tool"` pareado).

import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { closeInterruptedHistory, type HistoryItem } from '../../src/agent/index.js';
import { ModelCallAbortedError } from '../../src/model/errors.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { ScriptedModelCaller, allowAllEngine, makePorts, toolCallBlock } from './helpers.js';

describe('ModelCallAbortedError carrega o histórico parcial do turno', () => {
  it('run(): o parcial tem o objetivo e o que o modelo já fez antes do ESC', async () => {
    const ac = new AbortController();
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([
      { text: `vou ler.\n${toolCallBlock('read_file', { path: 'README.md' })}` },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: new ToolRegistry<ToolPorts>(NATIVE_TOOLS),
      ports,
      // O ESC chega enquanto a tool roda: a próxima volta vê o signal abortado.
      onProgress: (s) => {
        if (s.kind === 'tool-start' || s.kind === 'tool-end') ac.abort();
      },
    });

    const err = await loop.run('dispara agentes', ac.signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCallAbortedError);
    const partial = (err as ModelCallAbortedError).partialHistory ?? [];
    expect(partial.some((h) => h.role === 'goal' && h.text === 'dispara agentes')).toBe(true);
    expect(partial.some((h) => h.role === 'model' && h.text.includes('vou ler'))).toBe(true);
  });

  it('resume(): idem, com a semente da conversa preservada no parcial', async () => {
    const { ports } = makePorts();
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([]),
      permission: allowAllEngine,
      tools: new ToolRegistry<ToolPorts>(NATIVE_TOOLS),
      ports,
    });
    const seed: HistoryItem[] = [
      { role: 'goal', text: 'turno antigo' },
      { role: 'model', text: 'feito.' },
      { role: 'goal', text: 'turno novo' },
    ];
    const err = await loop.resume(seed, AbortSignal.abort()).catch((e: unknown) => e);
    expect((err as ModelCallAbortedError).partialHistory).toEqual(seed);
  });
});

describe('closeInterruptedHistory', () => {
  it('tool-call nativa sem resultado ganha um resultado "interrompido" LOGO após o grupo', () => {
    const h: HistoryItem[] = [
      { role: 'goal', text: 'lança' },
      {
        role: 'model_tool_calls',
        text: '',
        calls: [
          { id: 'c1', name: 'spawn_agent', input: {} },
          { id: 'c2', name: 'read_file', input: {} },
        ],
      },
      { role: 'tool_result', toolCallId: 'c1', toolName: 'spawn_agent', text: 'ok' },
    ];
    const out = closeInterruptedHistory(h);
    expect(out.map((i) => i.role)).toEqual([
      'goal',
      'model_tool_calls',
      'tool_result',
      'tool_result',
    ]);
    const ultimo = out[3] as Extract<HistoryItem, { role: 'tool_result' }>;
    expect(ultimo.toolCallId).toBe('c2');
    expect(ultimo.toolName).toBe('read_file');
    expect(ultimo.text).toMatch(/interromp/i);
    // Não muta a entrada.
    expect(h).toHaveLength(3);
  });

  it('histórico já pareado (ou só de texto) volta igual', () => {
    const h: HistoryItem[] = [
      { role: 'goal', text: 'x' },
      { role: 'model_tool_calls', text: '', calls: [{ id: 'c1', name: 'glob', input: {} }] },
      { role: 'tool_result', toolCallId: 'c1', toolName: 'glob', text: 'a.ts' },
      { role: 'model', text: 'pronto' },
    ];
    expect(closeInterruptedHistory(h)).toEqual(h);
  });

  it('grupo sem nenhum resultado e seguido de outro item: o resultado entra ANTES do item', () => {
    const h: HistoryItem[] = [
      { role: 'model_tool_calls', text: '', calls: [{ id: 'c9', name: 'run_command', input: {} }] },
      { role: 'observation', toolName: 'monitor', text: 'evento' },
    ];
    expect(closeInterruptedHistory(h).map((i) => i.role)).toEqual([
      'model_tool_calls',
      'tool_result',
      'observation',
    ]);
  });
});
