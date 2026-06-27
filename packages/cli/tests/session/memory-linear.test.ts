// EST-0983 — `/memory` em modo NÃO-TTY (linear): roteia pela MESMA mecânica do TTY
// (parseMemoryCommand/runMemoryCommand sobre a AgentMemory interna), NUNCA cai no
// agente. Mutações NEGADAS em Plan; lista é leitura (permitida). Fix de fiação: sem
// `runMemoryLinear` o `aluy "/memory"` piped virava OBJETIVO p/ o modelo.

import { describe, expect, it, vi } from 'vitest';
import {
  AgentMemory,
  type MemoryFact,
  type MemoryScope,
  type MemoryStorePort,
} from '@aluy/cli-core';
import { runMemoryLinear, runClearLinear, type LinearOut } from '../../src/session/linear.js';

function makeOut(): { out: LinearOut; text: () => string } {
  let buf = '';
  return { out: { write: (c) => (buf += c) }, text: () => buf };
}

/** Store em memória (porta ESTREITA por escopo) — sem tocar disco. */
function memStore(seed: readonly MemoryFact[] = []): MemoryStorePort {
  let facts = [...seed];
  return {
    async readAll() {
      return [...facts];
    },
    async append(f) {
      facts.push(f);
    },
    async remove(id) {
      facts = facts.filter((f) => f.id !== id);
    },
    async update(f) {
      facts = facts.map((x) => (x.id === f.id ? f : x));
    },
    async clearAll(scope) {
      facts = scope === undefined ? [] : facts.filter((f) => f.scope !== scope);
    },
  };
}

function fact(id: string, text: string, scope: MemoryScope): MemoryFact {
  return { id, text, scope, provenance: 'usuario', pinned: false, ts: 1 };
}

describe('runMemoryLinear — /memory sem TTY (roteado, não cai no agente)', () => {
  it('NÃO trata linhas que não são /memory (devolve false → vira objetivo)', async () => {
    const { out } = makeOut();
    const memory = new AgentMemory({ store: memStore() });
    expect(await runMemoryLinear('explique o repo', out, { memory, isPlan: false })).toBe(false);
    expect(await runMemoryLinear('/model', out, { memory, isPlan: false })).toBe(false);
    // `/memoryx` (prefixo sem fronteira) NÃO é /memory — não trata.
    expect(await runMemoryLinear('/memoryx', out, { memory, isPlan: false })).toBe(false);
  });

  it('`/memory` LISTA os fatos (não cai no agente, não diz "vazia")', async () => {
    const { out, text } = makeOut();
    const memory = new AgentMemory({
      store: memStore([fact('aaa1111', 'projeto Vega usa pnpm', 'projeto')]),
    });
    const handled = await runMemoryLinear('/memory', out, { memory, isPlan: false });
    expect(handled).toBe(true);
    expect(text()).toContain('Vega');
    expect(text()).toContain('aaa1111');
    expect(text()).not.toContain('memória vazia');
  });

  it('`/memory` sem fatos diz "vazia" (mas TRATA — não cai no agente)', async () => {
    const { out, text } = makeOut();
    const memory = new AgentMemory({ store: memStore() });
    expect(await runMemoryLinear('/memory', out, { memory, isPlan: false })).toBe(true);
    expect(text()).toContain('memória vazia');
  });

  it('`/memory esquecer <id>` em modo NORMAL remove o fato', async () => {
    const { out, text } = makeOut();
    const store = memStore([fact('bbb2222', 'fato a podar', 'global')]);
    const memory = new AgentMemory({ store });
    await runMemoryLinear('/memory esquecer bbb2222', out, { memory, isPlan: false });
    expect(text()).toContain('esquecido');
    expect((await store.readAll()).length).toBe(0);
  });

  it('Plan NEGA mutações (esquecer/editar/fixar) — efeito; lista segue permitida', async () => {
    const store = memStore([fact('ccc3333', 'fato', 'global')]);
    const memory = new AgentMemory({ store });
    const m = makeOut();
    await runMemoryLinear('/memory esquecer ccc3333', m.out, { memory, isPlan: true });
    expect(m.text()).toContain('modo Plan');
    // o fato NÃO foi removido (efeito negado).
    expect((await store.readAll()).length).toBe(1);
    // a LISTA (leitura) é permitida mesmo em Plan.
    const l = makeOut();
    expect(await runMemoryLinear('/memory', l.out, { memory, isPlan: true })).toBe(true);
    expect(l.text()).toContain('ccc3333');
  });
});

describe('runClearLinear — /clear sem TTY (roteado; destrutivos FAIL-CLOSED no pipe)', () => {
  it('NÃO trata linhas que não são /clear (devolve false → vira objetivo)', async () => {
    const { out } = makeOut();
    const memory = new AgentMemory({ store: memStore() });
    const r = await runClearLinear('rode os testes', out, { memory, clearSession: vi.fn() });
    expect(r).toBe(false);
  });

  it('`/clear` puro limpa a sessão (clearSession), sem tocar a memória', async () => {
    const { out, text } = makeOut();
    const store = memStore([fact('g1', 'fato', 'global')]);
    const memory = new AgentMemory({ store });
    const clearSession = vi.fn();
    expect(await runClearLinear('/clear', out, { memory, clearSession })).toBe(true);
    expect(clearSession).toHaveBeenCalledOnce();
    expect((await store.readAll()).length).toBe(1); // memória INTACTA.
    expect(text()).toContain('sessão limpa');
  });

  it('`/clear full` no pipe é FAIL-CLOSED: avisa e NÃO apaga (sem 2ª invocação a confirmar)', async () => {
    const { out, text } = makeOut();
    const store = memStore([fact('g1', 'fato', 'global'), fact('p1', 'outro', 'projeto')]);
    const memory = new AgentMemory({ store });
    const clearSession = vi.fn();
    expect(await runClearLinear('/clear full', out, { memory, clearSession })).toBe(true);
    // nada apagado, sessão não limpa (só o aviso + a dica de rodar num TTY).
    expect((await store.readAll()).length).toBe(2);
    expect(clearSession).not.toHaveBeenCalled();
    expect(text()).toMatch(/IRREVERSÍVEL/);
    expect(text()).toMatch(/não-interativo|TTY/i);
  });
});
