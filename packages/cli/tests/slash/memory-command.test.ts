// EST-0983 · ADR-0064 · CLI-SEC-15 (GS-M6) — o comando `/memory`.
//
// Prova: o roteamento PURO (list/esquecer/editar/fixar/desfixar/help); e o runner —
// LISTA em qualquer modo (leitura), mas MUTAÇÕES (esquecer/editar/fixar) NEGADAS em
// Plan (efeito; ADR-0055). FIXAR é retenção — não promove a system (a invariante B é
// do recall; aqui provamos que o COMANDO não muda canal, só marca pinned).

import { describe, expect, it } from 'vitest';
import { AgentMemory, type MemoryFact, type MemoryStorePort } from '@aluy/cli-core';
import { parseMemoryCommand, isMemoryMutation, runMemoryCommand } from '../../src/slash/memory.js';

class FakeStore implements MemoryStorePort {
  facts: MemoryFact[] = [];
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
  async clearAll(scope?: MemoryFact['scope']) {
    this.facts = scope === undefined ? [] : this.facts.filter((x) => x.scope !== scope);
  }
}

function mkMemory(seed: MemoryFact[] = []) {
  const store = new FakeStore();
  store.facts = seed;
  let t = 1000;
  return { store, memory: new AgentMemory({ store, now: () => t++ }) };
}

function fact(over: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: over.id ?? 'abc1234',
    text: over.text ?? 'usa pnpm',
    scope: over.scope ?? 'global',
    provenance: over.provenance ?? 'usuario',
    pinned: over.pinned ?? false,
    ts: over.ts ?? 1,
  };
}

describe('parseMemoryCommand — roteamento PURO', () => {
  it('vazio ⇒ list; sinônimos de cada verbo', () => {
    expect(parseMemoryCommand('')).toEqual({ kind: 'list' });
    expect(parseMemoryCommand('listar')).toEqual({ kind: 'list' });
    expect(parseMemoryCommand('esquecer abc1234')).toEqual({ kind: 'forget', id: 'abc1234' });
    expect(parseMemoryCommand('forget abc1234')).toEqual({ kind: 'forget', id: 'abc1234' });
    expect(parseMemoryCommand('editar abc1234 novo texto')).toEqual({
      kind: 'edit',
      id: 'abc1234',
      text: 'novo texto',
    });
    expect(parseMemoryCommand('fixar abc1234')).toEqual({
      kind: 'pin',
      id: 'abc1234',
      pinned: true,
    });
    expect(parseMemoryCommand('desfixar abc1234')).toEqual({
      kind: 'pin',
      id: 'abc1234',
      pinned: false,
    });
  });

  it('falta argumento ⇒ help (com motivo); verbo desconhecido ⇒ help', () => {
    expect(parseMemoryCommand('esquecer').kind).toBe('help');
    expect(parseMemoryCommand('editar abc1234').kind).toBe('help'); // sem texto
    expect(parseMemoryCommand('voar').kind).toBe('help');
  });

  it('isMemoryMutation classifica corretamente', () => {
    expect(isMemoryMutation({ kind: 'list' })).toBe(false);
    expect(isMemoryMutation({ kind: 'help', reason: '' })).toBe(false);
    expect(isMemoryMutation({ kind: 'forget', id: 'x' })).toBe(true);
    expect(isMemoryMutation({ kind: 'edit', id: 'x', text: 'y' })).toBe(true);
    expect(isMemoryMutation({ kind: 'pin', id: 'x', pinned: true })).toBe(true);
  });
});

describe('runMemoryCommand — Plan-deny nas mutações; lista em qualquer modo', () => {
  it('LISTA mostra id/proveniência/pin (permitido até em Plan — é leitura)', async () => {
    const { memory } = mkMemory([fact({ id: 'abc1234', text: 'usa pnpm', pinned: true })]);
    const note = await runMemoryCommand({ kind: 'list' }, memory, /*isPlan*/ true);
    expect(note.lines.some((l) => l.includes('abc1234'))).toBe(true);
    expect(note.lines.some((l) => l.includes('usa pnpm'))).toBe(true);
    expect(note.lines.some((l) => l.includes('fixado'))).toBe(true);
  });

  it('memória vazia ⇒ nota honesta', async () => {
    const { memory } = mkMemory();
    const note = await runMemoryCommand({ kind: 'list' }, memory, false);
    expect(note.lines[0]).toContain('vazia');
  });

  it('Plan NEGA esquecer/editar/fixar (efeito); a memória NÃO muda', async () => {
    const { store, memory } = mkMemory([fact({ id: 'abc1234' })]);
    for (const cmd of [
      { kind: 'forget', id: 'abc1234' } as const,
      { kind: 'edit', id: 'abc1234', text: 'x' } as const,
      { kind: 'pin', id: 'abc1234', pinned: true } as const,
    ]) {
      const note = await runMemoryCommand(cmd, memory, /*isPlan*/ true);
      expect(note.lines.some((l) => l.includes('Plan'))).toBe(true);
    }
    // nada foi alterado
    expect(store.facts).toHaveLength(1);
    expect(store.facts[0]!.pinned).toBe(false);
    expect(store.facts[0]!.text).toBe('usa pnpm');
  });

  it('fora de Plan: esquecer/editar/fixar surtem efeito', async () => {
    const { store, memory } = mkMemory([
      fact({ id: 'abc1234' }),
      fact({ id: 'def5678', text: 'b' }),
    ]);
    await runMemoryCommand({ kind: 'edit', id: 'abc1234', text: 'corrigido' }, memory, false);
    expect(store.facts.find((f) => f.id === 'abc1234')!.text).toBe('corrigido');

    const pinNote = await runMemoryCommand(
      { kind: 'pin', id: 'abc1234', pinned: true },
      memory,
      false,
    );
    expect(store.facts.find((f) => f.id === 'abc1234')!.pinned).toBe(true);
    // GS-M6 — fixar é retenção, não promoção: a nota deixa explícito
    expect(pinNote.lines.some((l) => l.includes('continua DADO'))).toBe(true);

    await runMemoryCommand({ kind: 'forget', id: 'def5678' }, memory, false);
    expect(store.facts.some((f) => f.id === 'def5678')).toBe(false);
  });

  it('id inexistente ⇒ nota de "não encontrado" (sem lançar)', async () => {
    const { memory } = mkMemory();
    const note = await runMemoryCommand({ kind: 'forget', id: 'zzz' }, memory, false);
    expect(note.lines[0]).toContain('não encontrado');
  });
});
