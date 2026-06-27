// EST-0983 (`/clear full` / `/clear memory`) — `AgentMemory.clearAll`: a mecânica
// PORTÁVEL do "apagar a memória". Conta ANTES de apagar (p/ a confirmação), apaga por
// escopo ou ambos, é idempotente em memória vazia e delega a porta estreita (sem path).
// É AÇÃO DO USUÁRIO via slash — NUNCA uma tool (validado nos testes de permissão).

import { describe, expect, it } from 'vitest';
import {
  AgentMemory,
  rememberTool,
  recallTool,
  type MemoryFact,
  type MemoryScope,
  type MemoryStorePort,
} from '../../src/index.js';

class FakeStore implements MemoryStorePort {
  facts: MemoryFact[] = [];
  clearAllCalls: Array<MemoryScope | undefined> = [];
  async readAll() {
    return this.facts;
  }
  async append(f: MemoryFact) {
    this.facts.push(f);
  }
  async remove(id: string) {
    this.facts = this.facts.filter((x) => x.id !== id);
  }
  async update(f: MemoryFact) {
    this.facts = this.facts.map((x) => (x.id === f.id ? f : x));
  }
  async clearAll(scope?: MemoryScope) {
    this.clearAllCalls.push(scope);
    this.facts = scope === undefined ? [] : this.facts.filter((x) => x.scope !== scope);
  }
}

function fact(id: string, scope: MemoryScope): MemoryFact {
  return { id, text: `fato ${id}`, scope, provenance: 'usuario', pinned: false, ts: 1 };
}

describe('AgentMemory.clearAll — `/clear full|memory`', () => {
  it('apaga TODOS os fatos (global + projeto) e devolve a CONTAGEM apagada', async () => {
    const store = new FakeStore();
    store.facts = [fact('g1', 'global'), fact('p1', 'projeto'), fact('g2', 'global')];
    const memory = new AgentMemory({ store });

    const n = await memory.clearAll();
    expect(n).toBe(3);
    expect(store.facts).toHaveLength(0);
    expect(store.clearAllCalls).toEqual([undefined]); // ambos os escopos.
  });

  it('com escopo conta+apaga SÓ aquele escopo', async () => {
    const store = new FakeStore();
    store.facts = [fact('g1', 'global'), fact('p1', 'projeto'), fact('p2', 'projeto')];
    const memory = new AgentMemory({ store });

    const n = await memory.clearAll('projeto');
    expect(n).toBe(2);
    expect(store.facts.map((f) => f.id)).toEqual(['g1']);
  });

  it('memória vazia ⇒ devolve 0 e NÃO chama o store (nada a apagar à toa)', async () => {
    const store = new FakeStore();
    const memory = new AgentMemory({ store });

    const n = await memory.clearAll();
    expect(n).toBe(0);
    expect(store.clearAllCalls).toEqual([]); // não tocou o filesystem.
  });

  it('escopo vazio (sem fatos NAQUELE escopo) ⇒ devolve 0 e não chama o store', async () => {
    const store = new FakeStore();
    store.facts = [fact('g1', 'global')];
    const memory = new AgentMemory({ store });

    const n = await memory.clearAll('projeto');
    expect(n).toBe(0);
    expect(store.clearAllCalls).toEqual([]);
    expect(store.facts).toHaveLength(1); // global intacto.
  });
});

describe('clearAll NÃO é uma TOOL — o agente não o alcança (ação do USUÁRIO via /clear)', () => {
  it('as ÚNICAS tools de memória são remember (escrita) e recall (leitura) — nenhuma apaga', () => {
    // O toolset de memória (controller liga só estas duas quando há porta). Não existe
    // uma tool de "clear/apagar memória": apagar é AÇÃO DO USUÁRIO via `/clear full`,
    // fora do toolset do modelo (a path-deny de `~/.aluy/memory/` segue valendo).
    const memoryToolNames = [rememberTool.name, recallTool.name];
    expect(memoryToolNames).toEqual(['remember', 'recall']);
    expect(memoryToolNames).not.toContain('clear');
    expect(memoryToolNames.some((n) => /clear|apag|delete|wipe/i.test(n))).toBe(false);
    // remember ESCREVE (porta estreita), recall LÊ — nenhuma das duas remove em massa.
    expect(rememberTool.effect).toBe('memory');
    expect(recallTool.effect).toBe('read');
  });
});
