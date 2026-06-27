// EST-0983 — `/clear [full|memory]`: o pedido do Tiago. `/clear` puro limpa SÓ a
// sessão (memória INTACTA); `/clear full` limpa a sessão E APAGA a memória; `/clear
// memory` só a memória. Os destrutivos PEDEM confirmação (2 passos, mecânica do /undo)
// e são IRREVERSÍVEIS. Bateria PURA (memória fake / spies — sem modelo, sem fs real).

import { describe, expect, it, vi } from 'vitest';
import {
  AgentMemory,
  type MemoryFact,
  type MemoryScope,
  type MemoryStorePort,
} from '@hiperplano/aluy-cli-core';
import {
  parseClearCommand,
  isDestructiveClear,
  runClearCommand,
  clearArmTransition,
  type ClearDeps,
} from '../../src/slash/clear.js';

class FakeStore implements MemoryStorePort {
  facts: MemoryFact[] = [];
  cleared = 0;
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
    this.cleared++;
    this.facts = scope === undefined ? [] : this.facts.filter((x) => x.scope !== scope);
  }
}

function fact(id: string, scope: MemoryScope): MemoryFact {
  return { id, text: `fato ${id}`, scope, provenance: 'usuario', pinned: false, ts: 1 };
}

function mk(seed: MemoryFact[] = []) {
  const store = new FakeStore();
  store.facts = [...seed];
  const memory = new AgentMemory({ store });
  const clearSession = vi.fn();
  const deps: ClearDeps = { clearSession, memory };
  return { store, memory, clearSession, deps };
}

describe('parseClearCommand — roteamento PURO', () => {
  it('vazio ⇒ session (comportamento histórico)', () => {
    expect(parseClearCommand('')).toEqual({ kind: 'session' });
    expect(parseClearCommand('   ')).toEqual({ kind: 'session' });
  });
  it('full / memory / cancelar (com sinônimos pt-BR)', () => {
    expect(parseClearCommand('full')).toEqual({ kind: 'full' });
    expect(parseClearCommand('tudo')).toEqual({ kind: 'full' });
    expect(parseClearCommand('memory')).toEqual({ kind: 'memory' });
    expect(parseClearCommand('memória')).toEqual({ kind: 'memory' });
    expect(parseClearCommand('cancelar')).toEqual({ kind: 'cancel' });
    expect(parseClearCommand('FULL')).toEqual({ kind: 'full' }); // case-insensitive
  });
  it('desconhecido ⇒ help (não apaga nada — seguro)', () => {
    expect(parseClearCommand('xpto')).toMatchObject({ kind: 'help' });
  });
  it('isDestructiveClear distingue os que apagam memória', () => {
    expect(isDestructiveClear({ kind: 'session' })).toBe(false);
    expect(isDestructiveClear({ kind: 'memory' })).toBe(true);
    expect(isDestructiveClear({ kind: 'full' })).toBe(true);
    expect(isDestructiveClear({ kind: 'cancel' })).toBe(false);
  });
});

describe('runClearCommand — `/clear` puro (só a sessão, memória INTACTA)', () => {
  it('limpa a sessão, NÃO toca a memória, e sinaliza clearScreen', async () => {
    const { store, clearSession, deps } = mk([fact('g1', 'global'), fact('p1', 'projeto')]);
    const out = await runClearCommand({ kind: 'session' }, deps, false);
    expect(clearSession).toHaveBeenCalledOnce();
    expect(store.cleared).toBe(0); // memória intacta — o ponto do Tiago.
    expect(store.facts).toHaveLength(2);
    expect(out).toMatchObject({ armed: false, cleared: true });
  });
});

describe('runClearCommand — `/clear full` (sessão + memória) com confirmação', () => {
  it('1ª invocação PEDE confirmação (conta os fatos) e NÃO apaga nada', async () => {
    const { store, clearSession, deps } = mk([fact('g1', 'global'), fact('p1', 'projeto')]);
    const out = await runClearCommand({ kind: 'full' }, deps, /*armed*/ false);
    expect(out.armed).toBe(true);
    expect(out.cleared).toBe(false);
    expect(clearSession).not.toHaveBeenCalled();
    expect(store.cleared).toBe(0); // nada apagado ainda.
    expect(store.facts).toHaveLength(2);
    const text = out.note.lines.join('\n');
    expect(text).toMatch(/2 fatos/);
    expect(text).toMatch(/IRREVERSÍVEL/);
    expect(text).toMatch(/sessões salvas/i); // diz o que PRESERVA.
  });

  it('2ª invocação CONFIRMADA (armed) limpa a sessão E apaga a memória', async () => {
    const { store, clearSession, deps } = mk([fact('g1', 'global'), fact('p1', 'projeto')]);
    const out = await runClearCommand({ kind: 'full' }, deps, /*armed*/ true);
    expect(clearSession).toHaveBeenCalledOnce();
    expect(store.cleared).toBe(1);
    expect(store.facts).toHaveLength(0); // memória zerada (global + projeto).
    expect(out).toMatchObject({ armed: false, cleared: true });
    expect(out.note.lines.join('\n')).toMatch(/2 fatos.*removidos/);
  });

  it('memória já VAZIA ⇒ "nada a apagar" mas ainda limpa a sessão (sem confirmação)', async () => {
    const { store, clearSession, deps } = mk([]); // memória vazia
    const out = await runClearCommand({ kind: 'full' }, deps, /*armed*/ false);
    expect(clearSession).toHaveBeenCalledOnce(); // a outra metade do "tudo".
    expect(store.cleared).toBe(0);
    expect(out).toMatchObject({ armed: false, cleared: true });
    expect(out.note.lines.join('\n')).toMatch(/já estava vazia/);
  });
});

describe('runClearCommand — `/clear memory` (só a memória, sessão SEGUE)', () => {
  it('confirmado apaga a memória e NÃO limpa a sessão', async () => {
    const { store, clearSession, deps } = mk([fact('g1', 'global')]);
    const out = await runClearCommand({ kind: 'memory' }, deps, /*armed*/ true);
    expect(store.cleared).toBe(1);
    expect(store.facts).toHaveLength(0);
    expect(clearSession).not.toHaveBeenCalled(); // a sessão segue.
    expect(out).toMatchObject({ armed: false, cleared: false });
  });
});

describe('runClearCommand — cancelar/recusar NÃO apaga nada', () => {
  it('`/clear cancelar` com confirmação armada desarma e nada é apagado', async () => {
    const { store, clearSession, deps } = mk([fact('g1', 'global')]);
    const out = await runClearCommand({ kind: 'cancel' }, deps, /*armed*/ true);
    expect(store.cleared).toBe(0);
    expect(store.facts).toHaveLength(1);
    expect(clearSession).not.toHaveBeenCalled();
    expect(out.armed).toBe(false);
    expect(out.note.lines.join('\n')).toMatch(/cancelada/);
  });

  it('RECUSAR = só não repetir: 1× pede confirmação, e sem 2ª invocação a memória fica', async () => {
    const { store, deps } = mk([fact('g1', 'global')]);
    // 1ª invocação: pede confirmação (não apaga). O usuário "recusa" simplesmente não
    // repetindo /clear full — a memória continua intacta.
    const first = await runClearCommand({ kind: 'full' }, deps, false);
    expect(first.armed).toBe(true);
    expect(store.cleared).toBe(0);
    expect(store.facts).toHaveLength(1);
  });
});

// HUNT-SLASH — a confirmação de 2 passos do `/clear` destrutivo é por-VERBO: armar
// `/clear memory` e repetir `/clear full` NÃO confirma o `full` (mais amplo). O caller
// guardava só um booleano `armed` sem checar QUAL verbo armou; `clearArmTransition`
// torna a regra correta e testável.
describe('clearArmTransition — a confirmação vale só p/ o MESMO verbo destrutivo', () => {
  it('armar `memory` e repetir `full` NÃO confirma o full (re-arma o full)', () => {
    // sem este match, o caller passaria armed=true ⇒ runClearCommand executaria o `full`.
    const tr = clearArmTransition('memory', { kind: 'full' });
    expect(tr.armed).toBe(false); // o `full` NÃO está confirmado.
    expect(tr.nextArmed).toBe('full'); // pede a confirmação do novo verbo.
  });

  it('armar `full` e repetir `memory` NÃO confirma o memory (re-arma o memory)', () => {
    const tr = clearArmTransition('full', { kind: 'memory' });
    expect(tr.armed).toBe(false);
    expect(tr.nextArmed).toBe('memory');
  });

  it('repetir o MESMO verbo confirma e desarma', () => {
    expect(clearArmTransition('full', { kind: 'full' })).toEqual({
      armed: true,
      nextArmed: undefined,
    });
    expect(clearArmTransition('memory', { kind: 'memory' })).toEqual({
      armed: true,
      nextArmed: undefined,
    });
  });

  it('1ª invocação de um destrutivo (nada armado) arma o verbo, não confirma', () => {
    expect(clearArmTransition(undefined, { kind: 'full' })).toEqual({
      armed: false,
      nextArmed: 'full',
    });
  });

  it('comando não-destrutivo (session/cancel/help) sempre desarma', () => {
    for (const cmd of [{ kind: 'session' }, { kind: 'cancel' }] as const) {
      expect(clearArmTransition('full', cmd)).toEqual({ armed: false, nextArmed: undefined });
    }
  });

  // PROVA do bypass end-to-end pela MESMA mecânica do caller: armar memory, depois full.
  it('integração: armar memory → repetir full NÃO apaga a memória com a confirmação errada', async () => {
    const { store, clearSession, deps } = mk([fact('g1', 'global'), fact('p1', 'projeto')]);
    let pending: ReturnType<typeof clearArmTransition>['nextArmed'] = undefined;

    // 1) `/clear memory` — pede confirmação do memory.
    let cmd = parseClearCommand('memory');
    let tr = clearArmTransition(pending, cmd);
    pending = tr.nextArmed;
    let out = await runClearCommand(cmd, deps, tr.armed);
    if (!out.armed) pending = undefined;
    expect(pending).toBe('memory');
    expect(store.cleared).toBe(0);

    // 2) `/clear full` — verbo DIFERENTE do armado: NÃO confirma. Só re-pede (full).
    cmd = parseClearCommand('full');
    tr = clearArmTransition(pending, cmd);
    pending = tr.nextArmed;
    out = await runClearCommand(cmd, deps, tr.armed);
    if (!out.armed) pending = undefined;

    expect(store.cleared).toBe(0); // memória INTACTA — não houve confirmação válida do full.
    expect(store.facts).toHaveLength(2);
    expect(clearSession).not.toHaveBeenCalled(); // a sessão tampouco foi zerada pelo full.
    expect(pending).toBe('full'); // agora sim aguarda a confirmação do full.
  });
});
