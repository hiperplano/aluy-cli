// Cobertura de leva de coverage-sweep: `NodeTodoStore` tinha `add`/sessão testados
// (BUG-0029, ver todo-store.test.ts), mas `done`/`clearDone` e os fail-safes de
// `readAll` (arquivo ausente/vazio/corrompido/formato inesperado) nunca tinham
// teste dedicado. Arquivo SEPARADO — não edita o teste alheio de BUG-0029.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeTodoStore } from '../../src/io/todo-store.js';

function tmpBase(): { base: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'aluy-todo-crud-'));
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe('NodeTodoStore — done/clearDone', () => {
  it('done(id) existente ⇒ marca done:true e devolve true', async () => {
    const { base, cleanup } = tmpBase();
    try {
      const s = new NodeTodoStore({ baseDir: base });
      const id = await s.add('lavar o carro');
      expect(await s.done(id)).toBe(true);
      const items = await s.list();
      expect(items.find((t) => t.id === id)?.done).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('done(id) inexistente ⇒ devolve false, NÃO altera nada', async () => {
    const { base, cleanup } = tmpBase();
    try {
      const s = new NodeTodoStore({ baseDir: base });
      await s.add('tarefa real');
      expect(await s.done('id-que-nao-existe')).toBe(false);
      expect((await s.list()).every((t) => !t.done)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('clearDone() remove só os done, devolve a contagem removida', async () => {
    const { base, cleanup } = tmpBase();
    try {
      const s = new NodeTodoStore({ baseDir: base });
      const a = await s.add('feita');
      await s.add('pendente');
      await s.done(a);
      expect(await s.clearDone()).toBe(1);
      const items = await s.list();
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toBe('pendente');
    } finally {
      cleanup();
    }
  });

  it('clearDone() sem nenhum item done ⇒ devolve 0, lista intacta', async () => {
    const { base, cleanup } = tmpBase();
    try {
      const s = new NodeTodoStore({ baseDir: base });
      await s.add('só pendente');
      expect(await s.clearDone()).toBe(0);
      expect(await s.list()).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

describe('NodeTodoStore — readAll fail-safe (nunca lança na leitura)', () => {
  it('arquivo AUSENTE ⇒ list() devolve [] (não lança)', async () => {
    const { base, cleanup } = tmpBase();
    try {
      const s = new NodeTodoStore({ baseDir: base });
      expect(await s.list()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('arquivo VAZIO (só whitespace) ⇒ list() devolve []', async () => {
    const { base, cleanup } = tmpBase();
    try {
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, 'todos.json'), '   \n', 'utf8');
      const s = new NodeTodoStore({ baseDir: base });
      expect(await s.list()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('JSON CORROMPIDO (sintaxe inválida) ⇒ list() devolve [], não lança', async () => {
    const { base, cleanup } = tmpBase();
    try {
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, 'todos.json'), '{not valid json', 'utf8');
      const s = new NodeTodoStore({ baseDir: base });
      expect(await s.list()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('JSON válido mas NÃO é array (ex.: objeto) ⇒ list() devolve []', async () => {
    const { base, cleanup } = tmpBase();
    try {
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, 'todos.json'), JSON.stringify({ foo: 'bar' }), 'utf8');
      const s = new NodeTodoStore({ baseDir: base });
      expect(await s.list()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('array com itens MAL-FORMADOS (campo faltando/tipo errado) ⇒ filtra, mantém só os válidos', async () => {
    const { base, cleanup } = tmpBase();
    try {
      mkdirSync(base, { recursive: true });
      const raw = [
        { id: 'ok1', text: 'válido', createdAt: 1, done: false },
        { id: 'sem-createdAt', text: 'quebrado' /* createdAt ausente */, done: false },
        { id: 123, text: 'id não é string', createdAt: 2, done: false },
        'string solta no array',
        null,
      ];
      writeFileSync(join(base, 'todos.json'), JSON.stringify(raw), 'utf8');
      const s = new NodeTodoStore({ baseDir: base });
      const items = await s.list();
      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe('ok1');
    } finally {
      cleanup();
    }
  });

  it('leitura que LANÇA (ex.: path aponta pra um DIRETÓRIO, não arquivo) ⇒ list() devolve [], não propaga', async () => {
    const { base, cleanup } = tmpBase();
    try {
      // um diretório no lugar do arquivo faz `readFileSync` lançar EISDIR — o
      // catch de `readAll` tem que engolir isso e devolver [] (fail-safe).
      mkdirSync(join(base, 'todos.json'), { recursive: true });
      const s = new NodeTodoStore({ baseDir: base });
      expect(await s.list()).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
