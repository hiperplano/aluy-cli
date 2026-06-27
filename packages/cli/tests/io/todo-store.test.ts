// BUG-0029 — backlog de TODO ESCOPADO por conversa (fim do vazamento cross-sessão).
//
// Antes: `~/.aluy/todos.json` GLOBAL (F71) ⇒ uma sessão NOVA "retomava" tarefas de
// OUTRA conversa (o dono abriu o CadastroClientes, disse "retome", e o agente foi
// comprar pão na padaria — de outra conversa). Com `sessionId`, cada
// conversa tem seu próprio arquivo e NÃO vê o backlog de outra.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeTodoStore } from '../../src/io/todo-store.js';

function tmpBase(): { base: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'aluy-todo-0029-'));
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe('BUG-0029 — backlog escopado por conversa (anti-vazamento)', () => {
  it('sessões DIFERENTES têm backlogs ISOLADOS (uma NÃO vê a outra)', async () => {
    const { base, cleanup } = tmpBase();
    try {
      const a = new NodeTodoStore({ baseDir: base, sessionId: 'conv-A' });
      const b = new NodeTodoStore({ baseDir: base, sessionId: 'conv-B' });
      await a.add('Comprar leite');
      expect((await a.list()).map((t) => t.text)).toEqual(['Comprar leite']);
      // a conversa B (nova) NÃO enxerga o todo da conversa A — fim do vazamento.
      expect(await b.list()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('MESMA sessão persiste (--continue/--resume reusa o id)', async () => {
    const { base, cleanup } = tmpBase();
    try {
      const s1 = new NodeTodoStore({ baseDir: base, sessionId: 'conv-X' });
      const id = await s1.add('tarefa da conversa X');
      // outra INSTÂNCIA com o MESMO sessionId (reabrir a conversa) vê o backlog.
      const s2 = new NodeTodoStore({ baseDir: base, sessionId: 'conv-X' });
      expect((await s2.list()).map((t) => t.id)).toContain(id);
    } finally {
      cleanup();
    }
  });

  it('sem sessionId ⇒ arquivo GLOBAL legado `todos.json` (não-regressão)', async () => {
    const { base, cleanup } = tmpBase();
    try {
      const g = new NodeTodoStore({ baseDir: base });
      await g.add('global');
      expect(g.path).toBe(join(base, 'todos.json'));
      expect(existsSync(join(base, 'todos.json'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('sessionId perigoso é SANITIZADO + contido em ~/.aluy/todos/ (anti path-traversal)', async () => {
    const { base, cleanup } = tmpBase();
    try {
      const s = new NodeTodoStore({ baseDir: base, sessionId: '../../etc/passwd' });
      await s.add('x');
      expect(s.path.startsWith(join(base, 'todos'))).toBe(true);
      expect(s.path).not.toContain('..');
    } finally {
      cleanup();
    }
  });
});
