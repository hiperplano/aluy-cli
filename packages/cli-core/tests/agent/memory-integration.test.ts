// F-MEM (ADR-0123 §4) — prova que a MEMÓRIA (Mem0) é CONSUMIDA no loop:
// RECALL injeta as memórias como DADO ENVELOPADO antes do goal; STORE grava
// objetivo+resposta no fim. Tudo rodando o AgentLoop real, não a função pura.

import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import type {
  MemoryEngine,
  MemoryAddInput,
  MemoryAddResult,
  MemorySearchResult,
  MemoryScopeResult,
} from '../../src/agent/maestro/memory-engine.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { ScriptedModelCaller, allowAllEngine, makePorts } from './helpers.js';

function registry(): ToolRegistry<ToolPorts> {
  return new ToolRegistry(NATIVE_TOOLS);
}

/** Mock de MemoryEngine: search devolve 1 hit; add registra as chamadas. */
function mockMemory() {
  const addCalls: MemoryAddInput[] = [];
  const searchCalls: string[] = [];
  const engine: MemoryEngine = {
    async search(input): Promise<MemorySearchResult> {
      searchCalls.push(input.query);
      return {
        hits: [{ id: 'm1', text: 'o projeto usa deepseek-v4-pro via TokenRouter', score: 0.9 }],
      };
    },
    async add(input): Promise<MemoryAddResult> {
      addCalls.push(input);
      return { ids: ['id-1'] };
    },
    async scope(): Promise<MemoryScopeResult> {
      return {};
    },
  };
  return { engine, addCalls, searchCalls };
}

describe('F-MEM INTEGRAÇÃO — memória consumida no loop real (recall + store)', () => {
  it('RECALL: a memória recuperada entra no histórico como observation DADO (não system)', async () => {
    const { ports } = makePorts();
    const { engine, searchCalls } = mockMemory();
    const model = new ScriptedModelCaller([{ text: 'Pronto, usei o contexto.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-mem-recall',
      memory: engine,
      memoryScope: 'proj-test',
    });

    const res = await loop.run('qual modelo o projeto usa?');

    // search foi chamado com o objetivo + escopo.
    expect(searchCalls).toContain('qual modelo o projeto usa?');
    // a memória recuperada está no histórico como observation (DADO envelopado), NÃO system.
    const memObs = res.history.filter(
      (h) => h.role === 'observation' && 'toolName' in h && h.toolName === 'memory',
    );
    expect(memObs).toHaveLength(1);
    expect(('text' in memObs[0]! && memObs[0].text) || '').toContain('deepseek-v4-pro');
    // NÃO vazou como system/instrução.
    const asSystem = res.history.filter((h) => h.role === 'goal' && /deepseek/.test(h.text));
    expect(asSystem).toHaveLength(0);
  });

  it('STORE: ao concluir, grava objetivo+resposta no escopo', async () => {
    const { ports } = makePorts();
    const { engine, addCalls } = mockMemory();
    const model = new ScriptedModelCaller([{ text: 'A resposta é deepseek-v4-pro.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-mem-store',
      memory: engine,
      memoryScope: 'proj-test',
    });

    await loop.run('qual modelo usar?');

    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]!.scope).toBe('proj-test');
    const stored = addCalls[0]!.content[0]!;
    expect(stored.kind).toBe('text');
    expect(stored.text).toContain('qual modelo usar?');
    expect(stored.text).toContain('deepseek-v4-pro');
  });

  it('F108 — STORE REDIGE segredo no objetivo E na resposta antes de persistir (mem0 at-rest + recall)', async () => {
    const { ports } = makePorts();
    const { engine, addCalls } = mockMemory();
    const secret = 'sk-ant-api03-' + ['aaaa', 'bbbb'].join('_') + 'cccc';
    // O modelo ECOA um segredo (ex.: que viu via read_file, que vai não-redigido ao modelo).
    const model = new ScriptedModelCaller([{ text: `a chave é ${secret}, pronto` }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-mem-secret',
      memory: engine,
      memoryScope: 'proj-secret',
    });

    // O usuário também colou um segredo no objetivo.
    await loop.run(`use o token sk-proj-${['xxxx', 'yyyyyyyyyyyyyyyy'].join('_')} agora`);

    expect(addCalls).toHaveLength(1);
    const text = addCalls[0]!.content[0]!.text;
    // NEM o segredo da resposta NEM o do objetivo persistem no mem0 (não vazam no recall).
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/sk-proj-xxxx_yyyy/);
    expect(text).toContain('‹redigido›');
  });

  it('DUAL-READ: recall lê de TODOS os memoryRecallScopes; store grava só no memoryScope', async () => {
    const { ports } = makePorts();
    const searchScopes: string[][] = [];
    const addScopes: string[] = [];
    const engine: MemoryEngine = {
      async search(input): Promise<MemorySearchResult> {
        searchScopes.push([...input.scopes]);
        return { hits: [] };
      },
      async add(input): Promise<MemoryAddResult> {
        addScopes.push(input.scope);
        return { ids: ['x'] };
      },
      async scope(): Promise<MemoryScopeResult> {
        return {};
      },
    };
    const model = new ScriptedModelCaller([{ text: 'feito.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-mem-dual',
      memory: engine,
      memoryScope: 'proj_new_abc123', // alvo de STORE (injetivo).
      memoryRecallScopes: ['proj_new_abc123', 'proj_legacy'], // RECALL: novo + legado.
    });

    await loop.run('algo');

    // RECALL leu dos DOIS escopos (migração sem reset).
    expect(searchScopes).toHaveLength(1);
    expect(searchScopes[0]).toEqual(['proj_new_abc123', 'proj_legacy']);
    // STORE gravou SÓ no escopo novo (não re-suja o legado).
    expect(addScopes).toEqual(['proj_new_abc123']);
  });

  it('SEM memoryRecallScopes ⇒ recall cai no [memoryScope] (retrocompat)', async () => {
    const { ports } = makePorts();
    const searchScopes: string[][] = [];
    const engine: MemoryEngine = {
      async search(input): Promise<MemorySearchResult> {
        searchScopes.push([...input.scopes]);
        return { hits: [] };
      },
      async add(): Promise<MemoryAddResult> {
        return { ids: [] };
      },
      async scope(): Promise<MemoryScopeResult> {
        return {};
      },
    };
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([{ text: 'ok.' }]),
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-mem-single',
      memory: engine,
      memoryScope: 'proj_solo',
    });
    await loop.run('x');
    expect(searchScopes[0]).toEqual(['proj_solo']);
  });

  it('F91 — PISO de relevância: hits FRACOS (score < 0.6) NÃO são injetados (filtra ruído)', async () => {
    const { ports } = makePorts();
    const engine: MemoryEngine = {
      async search(): Promise<MemorySearchResult> {
        // mistura: 1 forte (relevante) + 2 fracos (ruído ~0.5, ex.: objetivo de teste).
        return {
          hits: [
            { id: 'a', text: 'FATO RELEVANTE do projeto', score: 0.82 },
            { id: 'b', text: 'Objetivo: yolo-was-here.txt / feito', score: 0.51 },
            { id: 'c', text: 'Objetivo: continua custom / feito', score: 0.49 },
          ],
        };
      },
      async add(): Promise<MemoryAddResult> {
        return { ids: [] };
      },
      async scope(): Promise<MemoryScopeResult> {
        return {};
      },
    };
    const model = new ScriptedModelCaller([{ text: 'ok.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-mem-score',
      memory: engine,
      memoryScope: 'proj_score',
    });
    const res = await loop.run('algo');
    const memObs = res.history.filter(
      (h) => h.role === 'observation' && 'toolName' in h && h.toolName === 'memory',
    );
    expect(memObs).toHaveLength(1);
    const text = ('text' in memObs[0]! && memObs[0].text) || '';
    expect(text).toContain('FATO RELEVANTE'); // o forte entra.
    expect(text).not.toContain('yolo-was-here'); // o ruído NÃO entra.
    expect(text).not.toContain('continua custom');
  });

  it('F91 — se SÓ há hits fracos (todos < piso) ⇒ recall vazio (nada injetado, sem ruído)', async () => {
    const { ports } = makePorts();
    const engine: MemoryEngine = {
      async search(): Promise<MemorySearchResult> {
        return { hits: [{ id: 'x', text: 'ruído irrelevante', score: 0.5 }] };
      },
      async add(): Promise<MemoryAddResult> {
        return { ids: [] };
      },
      async scope(): Promise<MemoryScopeResult> {
        return {};
      },
    };
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([{ text: 'ok.' }]),
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-mem-allweak',
      memory: engine,
      memoryScope: 'proj_weak',
    });
    const res = await loop.run('algo');
    const memObs = res.history.filter(
      (h) => h.role === 'observation' && 'toolName' in h && h.toolName === 'memory',
    );
    expect(memObs).toHaveLength(0); // tudo fraco ⇒ sem recall (melhor vazio que ruído).
  });

  it('SEM memory ⇒ baseline (sem recall/store, nada injetado)', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'ok.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-mem-off',
    });
    const res = await loop.run('faça algo');
    const memObs = res.history.filter(
      (h) => h.role === 'observation' && 'toolName' in h && h.toolName === 'memory',
    );
    expect(memObs).toHaveLength(0);
  });
});
