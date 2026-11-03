// ENCAIXE FLUIDO — a mensagem do dono ("btw") entra nos PONTOS SEGUROS do loop, não só no
// topo da iteração: ANTES de cada tool de um batch nativo e logo APÓS o batch.
//
// Regra de formato (OpenAI-compat): `role:"tool"` segue DIRETO o `assistant` com
// `tool_calls`; um `user` só pode vir após TODOS os `tool_result` daquele turno. Por isso,
// ao chegar uma mensagem no meio de um batch, as tools AINDA NÃO INICIADAS são PULADAS
// (cada uma ganha um `tool_result` "não executada"), e só então o `user_inject` entra.
//
// PROVAS (caller roteirizado, sem rede):
//  1. msg chegada DURANTE a 1ª tool de um batch de 3 ⇒ a 2ª e a 3ª NÃO executam (efeito
//     ausente), ambas pareadas com `tool_result` "pulada", e o `user` vem DEPOIS delas;
//  2. msg chegada DURANTE a ÚLTIMA tool ⇒ nada é pulado e o `user` entra após o batch,
//     já na chamada seguinte do modelo (sem esperar nada além da tool em voo);
//  3. msg já pendente quando o modelo devolve o batch ⇒ NENHUMA tool roda (todas puladas);
//  4. a catraca só é consultada p/ o que de fato executa (nunca p/ as puladas);
//  5. sem mensagem ⇒ baseline (todas as tools rodam, nada é pulado).

import { describe, expect, it } from 'vitest';
import { AgentLoop, type InjectedInputPort, type ProgressSignal } from '../../src/agent/loop.js';
import { injectedInputItem } from '../../src/agent/input-injection.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { HistoryItem } from '../../src/agent/context.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import type { ChatMessage } from '../../src/model/types.js';
import type { PermissionEngine, ToolCall } from '../../src/permission/gate.js';
import { MemoryFs, ScriptedModelCaller, allowAllEngine, makePorts } from './helpers.js';

function registry(): ToolRegistry<ToolPorts> {
  return new ToolRegistry(NATIVE_TOOLS);
}

const txt = (m: ChatMessage): string => (typeof m.content === 'string' ? m.content : '');

/** Fila viva controlável: `push` simula o dono digitando; a porta drena e esvazia. */
function liveQueue(): { port: InjectedInputPort; push: (t: string) => void } {
  let pending: HistoryItem[] = [];
  return {
    port: () => {
      const out = pending;
      pending = [];
      return out;
    },
    push: (t) => {
      const item = injectedInputItem(t);
      if (item) pending.push(item);
    },
  };
}

const BATCH = [
  { id: 'c1', name: 'read_file', input: { path: 'a.md' } },
  { id: 'c2', name: 'read_file', input: { path: 'b.md' } },
  { id: 'c3', name: 'read_file', input: { path: 'c.md' } },
] as const;

function files(): MemoryFs {
  return new MemoryFs(
    new Map([
      ['a.md', 'A'],
      ['b.md', 'B'],
      ['c.md', 'C'],
    ]),
  );
}

/** Ports cujo `readFile` chama `onRead(n)` (n = nº da leitura, 1-based) antes de ler. */
function portsWithRead(onRead: (n: number) => void): { ports: ToolPorts; reads: () => number } {
  const base = makePorts({ fs: files() }).ports;
  let reads = 0;
  const ports: ToolPorts = {
    ...base,
    fs: {
      readFile: async (p: string) => {
        reads += 1;
        onRead(reads);
        return base.fs.readFile(p);
      },
      writeFile: base.fs.writeFile.bind(base.fs),
      exists: base.fs.exists.bind(base.fs),
    } as ToolPorts['fs'],
  };
  return { ports, reads: () => reads };
}

describe('encaixe fluido — drenagem nos pontos seguros do batch de tools', () => {
  it('msg durante a 1ª tool: as não iniciadas são PULADAS (pareadas) e o user vem DEPOIS', async () => {
    const q = liveQueue();
    const { ports, reads } = portsWithRead((n) => {
      if (n === 1) q.push('pare, foque em X');
    });
    const model = new ScriptedModelCaller([{ toolCalls: BATCH }, { text: 'ok, foco em X.' }]);
    const signals: ProgressSignal[] = [];
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 's-batch',
      pollInjected: q.port,
      onProgress: (s) => signals.push(s),
    });
    const res = await loop.run('tarefa');
    expect(res.stop.kind).toBe('final');
    expect(reads()).toBe(1);
    // a 2ª chamada do modelo vê: assistant(tool_calls) → tool×3 → user
    const msgs = model.calls[1]!.messages;
    const iAssistant = msgs.findIndex((m) => m.role === 'assistant' && m.tool_calls);
    expect(iAssistant).toBeGreaterThanOrEqual(0);
    const tools = msgs.slice(iAssistant + 1, iAssistant + 4);
    expect(tools.map((m) => m.role)).toEqual(['tool', 'tool', 'tool']);
    expect(tools.map((m) => m.tool_call_id)).toEqual(['c1', 'c2', 'c3']);
    expect(txt(tools[0]!)).not.toContain('PULADA');
    expect(txt(tools[1]!)).toContain('PULADA');
    expect(txt(tools[2]!)).toContain('PULADA');
    const after = msgs[iAssistant + 4]!;
    expect(after.role).toBe('user');
    expect(txt(after)).toContain('foque em X');
    expect(signals.filter((s) => s.kind === 'inject')).toEqual([{ kind: 'inject', count: 1 }]);
  });

  it('msg durante a ÚLTIMA tool: nada é pulado e o user entra já após o batch', async () => {
    const q = liveQueue();
    const { ports, reads } = portsWithRead((n) => {
      if (n === 3) q.push('além disso, resuma');
    });
    const model = new ScriptedModelCaller([{ toolCalls: BATCH }, { text: 'feito.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      pollInjected: q.port,
    });
    await loop.run('tarefa');
    expect(reads()).toBe(3);
    const msgs = model.calls[1]!.messages;
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(3);
    expect(toolMsgs.some((m) => txt(m).includes('PULADA'))).toBe(false);
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe('user');
    expect(txt(last)).toContain('resuma');
  });

  it('msg já pendente quando o modelo devolve o batch: NENHUMA tool roda', async () => {
    const q = liveQueue();
    const { ports, reads } = portsWithRead(() => {});
    const inner = new ScriptedModelCaller([{ toolCalls: BATCH }, { text: 'ok.' }]);
    // O dono digita DURANTE a geração do modelo (1ª chamada).
    const model = {
      async call(args: Parameters<ScriptedModelCaller['call']>[0]) {
        const r = await inner.call(args);
        if (inner.calls.length === 1) q.push('não apague nada!');
        return r;
      },
    };
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      pollInjected: q.port,
    });
    await loop.run('tarefa');
    expect(reads()).toBe(0);
    const msgs = inner.calls[1]!.messages;
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(3);
    expect(toolMsgs.every((m) => txt(m).includes('PULADA'))).toBe(true);
    expect(txt(msgs[msgs.length - 1]!)).toContain('não apague nada');
  });

  it('a catraca só é consultada p/ o que executa (as puladas não passam por decide)', async () => {
    const q = liveQueue();
    const decided: string[] = [];
    const engine: PermissionEngine = {
      decide(call: ToolCall) {
        decided.push(`${call.name}:${String((call.input as { path?: string }).path)}`);
        return allowAllEngine.decide(call);
      },
    } as PermissionEngine;
    const { ports } = portsWithRead(() => q.push('mude de ideia'));
    const model = new ScriptedModelCaller([{ toolCalls: BATCH }, { text: 'ok' }]);
    const loop = new AgentLoop({
      model,
      permission: engine,
      tools: registry(),
      ports,
      pollInjected: q.port,
    });
    await loop.run('tarefa');
    expect(decided).toEqual(['read_file:a.md']);
  });

  it('sem mensagem pendente: baseline (todas rodam, nada pulado)', async () => {
    const q = liveQueue();
    const model = new ScriptedModelCaller([{ toolCalls: BATCH }, { text: 'ok' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports: makePorts({ fs: files() }).ports,
      pollInjected: q.port,
    });
    await loop.run('tarefa');
    const msgs = model.calls[1]!.messages;
    expect(msgs.filter((m) => m.role === 'tool')).toHaveLength(3);
    expect(msgs.some((m) => txt(m).includes('PULADA'))).toBe(false);
  });
});
