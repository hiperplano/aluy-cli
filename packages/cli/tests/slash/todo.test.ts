// EST-1108 — o comando `/todo`. Espelha o padrão de `tests/slash/memory-command.test.ts`
// (o irmão `/memory`): roteamento PURO (parseTodoCommand — list/done/clear/help/erro),
// e o runner contra uma `TodoStorePort` FAKE — LISTA em qualquer modo (leitura), mas
// MUTAÇÕES (done/clear) NEGADAS em Plan (efeito; ADR-0055, mesma regra do /memory).

import { describe, expect, it } from 'vitest';
import type { TodoItem, TodoStorePort } from '@hiperplano/aluy-cli-core';
import { parseTodoCommand, isTodoMutation, runTodoCommand } from '../../src/slash/todo.js';

class FakeTodoStore implements TodoStorePort {
  items: TodoItem[] = [];
  private nextId = 1;
  async add(text: string): Promise<string> {
    const id = String(this.nextId++);
    this.items.push({ id, text, createdAt: this.nextId, done: false });
    return id;
  }
  async list(): Promise<readonly TodoItem[]> {
    return this.items;
  }
  async done(id: string): Promise<boolean> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return false;
    this.items = this.items.map((i) => (i.id === id ? { ...i, done: true } : i));
    return true;
  }
  async clearDone(): Promise<number> {
    const before = this.items.length;
    this.items = this.items.filter((i) => !i.done);
    return before - this.items.length;
  }
}

function item(over: Partial<TodoItem> & Pick<TodoItem, 'id' | 'text'>): TodoItem {
  return { createdAt: 1, done: false, ...over };
}

function text(lines: readonly string[]): string {
  return lines.join('\n');
}

// ── parseTodoCommand — roteamento PURO ──────────────────────────────────────

describe('parseTodoCommand', () => {
  it('vazio ⇒ list', () => {
    expect(parseTodoCommand('')).toEqual({ kind: 'list' });
    expect(parseTodoCommand('   ')).toEqual({ kind: 'list' });
  });

  it('list/ls (case-insensitive) ⇒ list', () => {
    expect(parseTodoCommand('list')).toEqual({ kind: 'list' });
    expect(parseTodoCommand('LS')).toEqual({ kind: 'list' });
  });

  it('done <id> ⇒ done com o id (só o 1º token do resto)', () => {
    expect(parseTodoCommand('done abc123')).toEqual({ kind: 'done', id: 'abc123' });
    expect(parseTodoCommand('DONE abc123 lixo-extra')).toEqual({ kind: 'done', id: 'abc123' });
  });

  it('done sem id ⇒ help com motivo', () => {
    const cmd = parseTodoCommand('done');
    expect(cmd.kind).toBe('help');
    if (cmd.kind === 'help') expect(cmd.reason).toMatch(/id/);
  });

  it('clear ⇒ clear', () => {
    expect(parseTodoCommand('clear')).toEqual({ kind: 'clear' });
    expect(parseTodoCommand('CLEAR')).toEqual({ kind: 'clear' });
  });

  it('help explícito ⇒ help sem motivo', () => {
    expect(parseTodoCommand('help')).toEqual({ kind: 'help', reason: '' });
  });

  it('subcomando desconhecido ⇒ help com o nome do subcomando no motivo', () => {
    const cmd = parseTodoCommand('frobnicate');
    expect(cmd.kind).toBe('help');
    if (cmd.kind === 'help') expect(cmd.reason).toContain('frobnicate');
  });
});

describe('isTodoMutation', () => {
  it('done/clear ⇒ true (efeito); list/help ⇒ false', () => {
    expect(isTodoMutation({ kind: 'done', id: 'x' })).toBe(true);
    expect(isTodoMutation({ kind: 'clear' })).toBe(true);
    expect(isTodoMutation({ kind: 'list' })).toBe(false);
    expect(isTodoMutation({ kind: 'help', reason: '' })).toBe(false);
  });
});

// ── runTodoCommand ───────────────────────────────────────────────────────────

describe('runTodoCommand — help', () => {
  it('reason presente ⇒ prefixa o motivo antes do uso', async () => {
    const store = new FakeTodoStore();
    const note = await runTodoCommand({ kind: 'help', reason: 'subcomando ruim' }, store, false);
    expect(note.title).toBe('todo');
    expect(text(note.lines)).toMatch(/^subcomando ruim/);
    expect(text(note.lines)).toMatch(/uso:/);
  });

  it('reason vazio ⇒ só o uso, sem linha de motivo', () => {
    return runTodoCommand({ kind: 'help', reason: '' }, new FakeTodoStore(), false).then((note) => {
      expect(note.lines[0]).toMatch(/uso:/);
    });
  });
});

describe('runTodoCommand — list', () => {
  it('backlog vazio ⇒ nota "vazio" + o uso', async () => {
    const store = new FakeTodoStore();
    const note = await runTodoCommand({ kind: 'list' }, store, false);
    expect(text(note.lines)).toMatch(/backlog vazio/);
  });

  it('com itens ⇒ separa Pendentes/Feitos, com contagem no título', async () => {
    const store = new FakeTodoStore();
    store.items = [
      item({ id: '1', text: 'a fazer' }),
      item({ id: '2', text: 'já feito', done: true }),
    ];
    const note = await runTodoCommand({ kind: 'list' }, store, false);
    expect(note.title).toMatch(/todo \(1 pendentes\)/);
    const out = text(note.lines);
    expect(out).toMatch(/── Pendentes ──[\s\S]*○ 1 {2}a fazer/);
    expect(out).toMatch(/── Feitos ──[\s\S]*✓ 2 {2}já feito/);
  });

  it('só pendentes ⇒ omite a seção "Feitos"', async () => {
    const store = new FakeTodoStore();
    store.items = [item({ id: '1', text: 'a fazer' })];
    const note = await runTodoCommand({ kind: 'list' }, store, false);
    expect(text(note.lines)).not.toContain('── Feitos ──');
  });

  it('só feitos ⇒ mostra "(nenhum pendente)"', async () => {
    const store = new FakeTodoStore();
    store.items = [item({ id: '1', text: 'feito', done: true })];
    const note = await runTodoCommand({ kind: 'list' }, store, false);
    expect(text(note.lines)).toContain('(nenhum pendente)');
  });

  it('LISTA funciona mesmo em modo Plan (read-only, não é mutação)', async () => {
    const store = new FakeTodoStore();
    store.items = [item({ id: '1', text: 'x' })];
    const note = await runTodoCommand({ kind: 'list' }, store, true);
    expect(text(note.lines)).toContain('x');
  });
});

describe('runTodoCommand — mutações NEGADAS em Plan (ADR-0055)', () => {
  it('done em Plan ⇒ negado, a store NÃO é tocada', async () => {
    const store = new FakeTodoStore();
    store.items = [item({ id: '1', text: 'x' })];
    const note = await runTodoCommand({ kind: 'done', id: '1' }, store, true);
    expect(text(note.lines)).toMatch(/modo Plan/);
    expect(store.items[0]!.done).toBe(false);
  });

  it('clear em Plan ⇒ negado, a store NÃO é tocada', async () => {
    const store = new FakeTodoStore();
    store.items = [item({ id: '1', text: 'x', done: true })];
    const note = await runTodoCommand({ kind: 'clear' }, store, true);
    expect(text(note.lines)).toMatch(/modo Plan/);
    expect(store.items).toHaveLength(1);
  });
});

describe('runTodoCommand — done (fora de Plan)', () => {
  it('id existente ⇒ marca concluído, confirma com ✓', async () => {
    const store = new FakeTodoStore();
    store.items = [item({ id: '1', text: 'x' })];
    const note = await runTodoCommand({ kind: 'done', id: '1' }, store, false);
    expect(text(note.lines)).toMatch(/item 1 marcado como concluído. ✓/);
    expect(store.items[0]!.done).toBe(true);
  });

  it('id inexistente ⇒ "id não encontrado"', async () => {
    const store = new FakeTodoStore();
    const note = await runTodoCommand({ kind: 'done', id: 'nao-existe' }, store, false);
    expect(text(note.lines)).toMatch(/id não encontrado: nao-existe/);
  });
});

describe('runTodoCommand — clear (fora de Plan)', () => {
  it('remove só os itens feitos, conta quantos', async () => {
    const store = new FakeTodoStore();
    store.items = [
      item({ id: '1', text: 'pendente' }),
      item({ id: '2', text: 'feito', done: true }),
      item({ id: '3', text: 'feito2', done: true }),
    ];
    const note = await runTodoCommand({ kind: 'clear' }, store, false);
    expect(text(note.lines)).toMatch(/2 item\(ns\) concluído\(s\) removido\(s\)/);
    expect(store.items).toEqual([item({ id: '1', text: 'pendente' })]);
  });

  it('nada feito ⇒ "nenhum item feito para limpar"', async () => {
    const store = new FakeTodoStore();
    store.items = [item({ id: '1', text: 'pendente' })];
    const note = await runTodoCommand({ kind: 'clear' }, store, false);
    expect(text(note.lines)).toMatch(/nenhum item feito para limpar/);
  });
});
