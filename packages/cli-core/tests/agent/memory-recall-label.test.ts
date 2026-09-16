// MEMÓRIA DE OUTRA SESSÃO NÃO PODE PARECER DESTA.
//
// Em 16/09, perguntado "o que vc fez", o modelo respondeu "Você pediu 'olá em uma palavra' →
// respondi 'Olá!'" — memória de testes antigos. O recall chegava como "Memórias de contexto
// recuperadas" sem dizer de ONDE vinham, com linhas "Objetivo:/Resultado:" que imitam a
// conversa, e com a mesma memória repetida ocupando todas as vagas.
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import type { MemoryEngine, MemorySearchHit } from '../../src/agent/maestro/memory-engine.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import type { HistoryItem } from '../../src/agent/context.js';
import { ScriptedModelCaller, allowAllEngine, makePorts } from './helpers.js';

function memoryWith(hits: MemorySearchHit[]): MemoryEngine {
  return {
    async search() {
      return { hits };
    },
    async add() {
      return { ids: [] };
    },
    async scope() {
      return {};
    },
  };
}

async function recallText(hits: MemorySearchHit[], sessionId = 'sess-atual'): Promise<string> {
  const { ports } = makePorts();
  const loop = new AgentLoop({
    model: new ScriptedModelCaller([{ text: 'ok.' }]),
    permission: allowAllEngine,
    tools: new ToolRegistry<ToolPorts>(NATIVE_TOOLS),
    ports,
    sessionId,
    memory: memoryWith(hits),
    memoryScope: 'proj',
  });
  const res = await loop.run('o que vc fez');
  const obs = res.history.find(
    (h: HistoryItem) => h.role === 'observation' && h.toolName === 'memory',
  );
  return obs && 'text' in obs ? obs.text : '';
}

const hit = (id: string, text: string, sessionId?: string): MemorySearchHit => ({
  id,
  text,
  score: 0.9,
  ...(sessionId !== undefined ? { metadata: { sessionId } } : {}),
});

describe('recall de memória rotulado', () => {
  it('diz que são memórias de SESSÕES ANTERIORES, que podem não ser desta conversa', async () => {
    const t = await recallText([hit('1', 'Objetivo: Diga olá.\nResultado: Olá!', 'sess-velha')]);
    expect(t).toMatch(/sess(ões|oes) anteriores/i);
    expect(t).toMatch(/n[ãa]o ser desta conversa/i);
    expect(t).toMatch(/nada abaixo aconteceu nesta sess[ãa]o/i);
  });

  it('cada memória ocupa UMA linha (sem "Resultado:" solto imitando a conversa)', async () => {
    const t = await recallText([hit('1', 'Objetivo: Diga olá.\nResultado: Olá!', 'x')]);
    expect(t).toContain('- Objetivo: Diga olá. | Resultado: Olá!');
  });

  it('clones idênticos entram uma vez só', async () => {
    const t = await recallText([
      hit('1', 'fato A', 'x'),
      hit('2', 'fato A', 'y'),
      hit('3', 'fato B', 'z'),
    ]);
    expect(t.match(/fato A/g)).toHaveLength(1);
    expect(t).toContain('fato B');
  });

  it('memória gravada por ESTA sessão não volta como recall (já está no histórico)', async () => {
    const t = await recallText([
      hit('1', 'da própria sessão', 'sess-atual'),
      hit('2', 'antiga', 'x'),
    ]);
    expect(t).not.toContain('da própria sessão');
    expect(t).toContain('antiga');
  });
});
