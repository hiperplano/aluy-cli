// EST-1108 — testes dos tools do backlog/TODO: add_todo, list_todos, done_todo.
//
// Provas PORTÁVEIS (sem filesystem real): as tools dependem da porta `TodoStorePort`
// injetável; o fake `FakeTodoStore` simula o store in-memory. Cada tool recebe a porta
// injetada e NUNCA um path.

import { describe, expect, it } from 'vitest';
import {
  addTodoTool,
  doneTodoTool,
  listTodosTool,
  ADD_TODO_TOOL_NAME,
  DONE_TODO_TOOL_NAME,
  LIST_TODOS_TOOL_NAME,
  type TodoItem,
  type TodoStorePort,
} from '../../../src/agent/todo/index.js';
import type { ToolPorts } from '../../../src/agent/tools/types.js';
import { MemoryFs, RecordingShell, MemorySearch } from '../helpers.js';

// ── Fake do store de TODO (in-memory, falível sob demanda) ────────────────────

class FakeTodoStore implements TodoStorePort {
  private items: TodoItem[] = [];
  private nextId = 0;
  failMode: 'none' | 'add' | 'list' | 'done' = 'none';

  async add(text: string): Promise<string> {
    if (this.failMode === 'add') throw new Error('fake add failure');
    const id = `todo-${String(this.nextId++).padStart(3, '0')}`;
    this.items.push({ id, text, createdAt: Date.now(), done: false });
    return id;
  }

  async list(): Promise<readonly TodoItem[]> {
    if (this.failMode === 'list') throw new Error('fake list failure');
    return [...this.items];
  }

  async done(id: string): Promise<boolean> {
    if (this.failMode === 'done') throw new Error('fake done failure');
    const idx = this.items.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this.items[idx] = { ...this.items[idx]!, done: true };
    return true;
  }

  async clearDone(): Promise<number> {
    const before = this.items.length;
    this.items = this.items.filter((t) => !t.done);
    return before - this.items.length;
  }

  /** Acesso de teste ao estado. */
  snapshot(): readonly TodoItem[] {
    return [...this.items];
  }
}

/** Monta ports de teste com o fake de TODO injetado. */
function portsWithTodo(store: FakeTodoStore): ToolPorts {
  return {
    fs: new MemoryFs(),
    shell: new RecordingShell(),
    search: new MemorySearch(),
    todo: store,
  };
}

// ── Nomes estáveis ───────────────────────────────────────────────────────────

describe('EST-1108 · todo tools — nomes estáveis e schema', () => {
  it('nomes exportados batem os nomes declarados na tool', () => {
    expect(addTodoTool.name).toBe(ADD_TODO_TOOL_NAME);
    expect(listTodosTool.name).toBe(LIST_TODOS_TOOL_NAME);
    expect(doneTodoTool.name).toBe(DONE_TODO_TOOL_NAME);
  });

  it('add_todo declara effect: memory (escrita confinada)', () => {
    expect(addTodoTool.effect).toBe('memory');
  });

  it('list_todos declara effect: read (leitura pura)', () => {
    expect(listTodosTool.effect).toBe('read');
  });

  it('done_todo declara effect: memory (escrita confinada)', () => {
    expect(doneTodoTool.effect).toBe('memory');
  });

  it('add_todo schema requer "item" (string)', () => {
    const s = addTodoTool.parameters as Record<string, unknown>;
    expect(s.required).toEqual(['item']);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.item.type).toBe('string');
  });

  it('done_todo schema requer "id" (string)', () => {
    const s = doneTodoTool.parameters as Record<string, unknown>;
    expect(s.required).toEqual(['id']);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.id.type).toBe('string');
  });

  it('list_todos schema é no-arg (properties vazio, type: object)', () => {
    const s = listTodosTool.parameters as Record<string, unknown>;
    expect(s.type).toBe('object');
    const props = s.properties as Record<string, unknown>;
    expect(Object.keys(props)).toHaveLength(0);
  });
});

// ── add_todo ─────────────────────────────────────────────────────────────────

describe('EST-1108 · add_todo — efeito brando', () => {
  it('anota um item e devolve o id', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    const r = await addTodoTool.run({ item: 'comprar pão' }, ports);
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('TODO anotado');
    expect(r.observation).toContain('todo-000');
    expect(r.display).toContain('[TODO]');
    expect(r.display).toContain('comprar pão');
    expect(store.snapshot()).toHaveLength(1);
    expect(store.snapshot()[0]!.text).toBe('comprar pão');
    expect(store.snapshot()[0]!.done).toBe(false);
  });

  it('trima espaços do item', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    await addTodoTool.run({ item: '  espaçado  ' }, ports);
    expect(store.snapshot()[0]!.text).toBe('espaçado');
  });

  it('sem "item" ⇒ ok=false', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    const r = await addTodoTool.run({}, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/requer "item"/i);
    expect(store.snapshot()).toHaveLength(0);
  });

  it('item vazio ⇒ ok=false', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    const r = await addTodoTool.run({ item: '' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/requer "item"/i);
  });

  it('item > 500 chars ⇒ ok=false', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    const r = await addTodoTool.run({ item: 'x'.repeat(501) }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/muito longo/i);
    expect(store.snapshot()).toHaveLength(0);
  });

  it('item de exatamente 500 chars ⇒ aceito', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    const item = 'x'.repeat(500);
    const r = await addTodoTool.run({ item }, ports);
    expect(r.ok).toBe(true);
    expect(store.snapshot()).toHaveLength(1);
  });

  it('sem porta de TODO ⇒ ok=false, não lança', async () => {
    const ports: ToolPorts = {
      fs: new MemoryFs(),
      shell: new RecordingShell(),
      search: new MemorySearch(),
    };
    const r = await addTodoTool.run({ item: 'x' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/indisponível/i);
  });

  it('store lança ⇒ ok=false, não propaga', async () => {
    const store = new FakeTodoStore();
    store.failMode = 'add';
    const ports = portsWithTodo(store);
    const r = await addTodoTool.run({ item: 'x' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/falha ao anotar/i);
  });
});

// ── list_todos ───────────────────────────────────────────────────────────────

describe('EST-1108 · list_todos — leitura', () => {
  it('vazio ⇒ observação "vazio"', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    const r = await listTodosTool.run({}, ports);
    expect(r.ok).toBe(true);
    expect(r.observation).toMatch(/vazio/i);
    expect(r.display).toContain('[TODO] vazio');
  });

  it('lista pendentes e feitos', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    await store.add('item pendente');
    await store.add('outro item');
    const id = (await store.list())[0]!.id;
    await store.done(id);
    const r = await listTodosTool.run({}, ports);
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('item pendente');
    expect(r.observation).toContain('outro item');
    expect(r.observation).toContain('Pendentes');
    expect(r.observation).toContain('Feitos');
    expect(r.observation).toMatch(/1 pendentes.*1 feitos/);
  });

  it('sem porta de TODO ⇒ ok=false', async () => {
    const ports: ToolPorts = {
      fs: new MemoryFs(),
      shell: new RecordingShell(),
      search: new MemorySearch(),
    };
    const r = await listTodosTool.run({}, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/indisponível/i);
  });

  it('store lança ⇒ ok=false', async () => {
    const store = new FakeTodoStore();
    store.failMode = 'list';
    const ports = portsWithTodo(store);
    const r = await listTodosTool.run({}, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/falha ao listar/i);
  });
});

// ── done_todo ────────────────────────────────────────────────────────────────

describe('EST-1108 · done_todo — efeito brando', () => {
  it('marca um item como feito por id', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    const id = await store.add('terminar relatório');
    expect(store.snapshot()[0]!.done).toBe(false);
    const r = await doneTodoTool.run({ id }, ports);
    expect(r.ok).toBe(true);
    expect(r.observation).toMatch(/concluído/);
    expect(r.display).toContain('✓ concluído');
    expect(store.snapshot()[0]!.done).toBe(true);
  });

  it('id não encontrado ⇒ ok=true com aviso (não é erro)', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    const r = await doneTodoTool.run({ id: 'inexistente' }, ports);
    expect(r.ok).toBe(true);
    expect(r.observation).toMatch(/não encontrado/i);
    expect(r.display).toContain('não encontrado');
  });

  it('sem "id" ⇒ ok=false', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    const r = await doneTodoTool.run({}, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/requer "id"/i);
  });

  it('id vazio ⇒ ok=false', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    const r = await doneTodoTool.run({ id: '' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/requer "id"/i);
  });

  it('sem porta de TODO ⇒ ok=false', async () => {
    const ports: ToolPorts = {
      fs: new MemoryFs(),
      shell: new RecordingShell(),
      search: new MemorySearch(),
    };
    const r = await doneTodoTool.run({ id: 'x' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/indisponível/i);
  });

  it('store lança ⇒ ok=false', async () => {
    const store = new FakeTodoStore();
    store.failMode = 'done';
    const ports = portsWithTodo(store);
    const r = await doneTodoTool.run({ id: 'x' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/falha ao concluir/i);
  });
});

// ── Fluxo completo: add → list → done → list ────────────────────────────────

describe('EST-1108 · fluxo completo add → list → done → list', () => {
  it('workflow típico: anota, lista, conclui, confere', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);

    // 1. Add 2 itens
    const r1 = await addTodoTool.run({ item: 'primeiro' }, ports);
    expect(r1.ok).toBe(true);
    const r2 = await addTodoTool.run({ item: 'segundo' }, ports);
    expect(r2.ok).toBe(true);

    // 2. Lista — 2 pendentes, 0 feitos
    const list1 = await listTodosTool.run({}, ports);
    expect(list1.ok).toBe(true);
    expect(list1.observation).toContain('primeiro');
    expect(list1.observation).toContain('segundo');
    expect(list1.observation).toMatch(/2 pendentes.*0 feitos/);

    // 3. Conclui o primeiro (extrai id da observação do add)
    const firstId = store.snapshot()[0]!.id;
    const done = await doneTodoTool.run({ id: firstId }, ports);
    expect(done.ok).toBe(true);

    // 4. Lista de novo — 1 pendente, 1 feito
    const list2 = await listTodosTool.run({}, ports);
    expect(list2.ok).toBe(true);
    expect(list2.observation).toMatch(/1 pendentes.*1 feitos/);
    expect(store.snapshot().filter((t) => t.done)).toHaveLength(1);
  });
});

// ── Fail-safe — store vazio nunca lança ──────────────────────────────────────

describe('EST-1108 · fail-safe — dir ausente/erro ⇒ vazio sem lançar', () => {
  it('list_todos com store vazio devolve "vazio" (ok=true)', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    const r = await listTodosTool.run({}, ports);
    expect(r.ok).toBe(true);
    expect(r.observation).toMatch(/vazio/i);
  });

  it('done_todo em store vazio devolve "não encontrado" (ok=true)', async () => {
    const store = new FakeTodoStore();
    const ports = portsWithTodo(store);
    const r = await doneTodoTool.run({ id: 'qq' }, ports);
    expect(r.ok).toBe(true);
    expect(r.observation).toMatch(/não encontrado/i);
  });
});
