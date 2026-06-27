// EST-1108 — tools do backlog/TODO: add_todo, list_todos, done_todo.
// Espelham as tools de memória (remember-tool.ts, recall-tool.ts) mas com estrutura
// mais simples: um flat list de itens com flag `done`.
//
// A tool `add_todo` é EFEITO DE ESCRITA CONFINADA (espelha `remember`, categoria
// `memory`/`todo-write`): não recebe path, só escreve via porta estreita.
// `list_todos` e `done_todo` são LEITURA/EFEITO LEVE (como `recall`): consultam/marcam
// itens do próprio backlog. NENHUMA recebe path do modelo.
//
// A tool NÃO consulta o gate (o LOOP faz — ponto único, CLI-SEC-H1).

import type { NativeTool, ToolPorts, ToolResult } from '../tools/types.js';
import {
  ADD_TODO_TOOL_NAME,
  DONE_TODO_TOOL_NAME,
  LIST_TODOS_TOOL_NAME,
  type TodoItem,
} from './contract.js';

function str(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ── Schemas (EST-0996 — nativo + tool-docs de texto) ─────────────────────────

const ADD_TODO_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    item: {
      type: 'string',
      description: 'OBRIGATÓRIO. O texto do item a anotar no backlog (curto e acionável).',
    },
  },
  required: ['item'],
});

const LIST_TODOS_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
});

const DONE_TODO_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'OBRIGATÓRIO. O id do item a marcar como concluído (do list_todos).',
    },
  },
  required: ['id'],
});

/** Teto de caracteres de um item de TODO (anti-item-gigante). */
const MAX_ITEM_CHARS = 500;

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtItem(t: TodoItem): string {
  const marker = t.done ? '✓' : '○';
  return `${marker} ${t.id}  ${t.text}`;
}

// ── Tools ────────────────────────────────────────────────────────────────────

export const addTodoTool: NativeTool<ToolPorts> = {
  name: ADD_TODO_TOOL_NAME,
  effect: 'memory', // mesmo carve-out de escrita confinada do remember
  parameters: ADD_TODO_SCHEMA,
  description:
    'Anota um item PENDENTE no backlog/TODO para fazer DEPOIS. Use quando o usuário pedir algo ' +
    'que você fará depois (especialmente no MEIO de outra tarefa), ou mencionar uma tarefa ' +
    'futura que não cabe agora. Input: { "item": string }. NUNCA recebe um path — ' +
    'escreve só no backlog local (~/.aluy/todos.json). Consulte com list_todos.',
  async run(input, ports): Promise<ToolResult> {
    const todo = ports.todo;
    if (!todo) {
      return {
        ok: false,
        observation: 'backlog/TODO indisponível neste contexto (sem porta de TODO).',
      };
    }
    const item = str(input, 'item');
    if (!item) return { ok: false, observation: 'add_todo requer "item" (string não-vazia).' };
    if (item.length > MAX_ITEM_CHARS) {
      return {
        ok: false,
        observation: `item muito longo (>${MAX_ITEM_CHARS} caracteres).`,
      };
    }
    try {
      const id = await todo.add(item.trim());
      return {
        ok: true,
        observation: `TODO anotado (id: ${id}). Use list_todos para ver o backlog, done_todo para marcar feito.`,
        display: `[TODO] ${id}: ${item.trim()}`,
      };
    } catch (e) {
      return {
        ok: false,
        observation: `falha ao anotar TODO: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  },
};

export const listTodosTool: NativeTool<ToolPorts> = {
  name: LIST_TODOS_TOOL_NAME,
  effect: 'read',
  parameters: LIST_TODOS_SCHEMA,
  description:
    'Lista o backlog/TODO persistente (itens pendentes e concluídos). Use para ver o que está ' +
    'anotado, especialmente ao terminar uma tarefa — veja se há itens pendentes para fazer. ' +
    'Input: {} (sem argumentos). NUNCA recebe um path. Leitura local pura.',
  async run(_input, ports): Promise<ToolResult> {
    const todo = ports.todo;
    if (!todo) {
      return {
        ok: false,
        observation: 'backlog/TODO indisponível neste contexto (sem porta de TODO).',
      };
    }
    try {
      const items = await todo.list();
      if (items.length === 0) {
        return {
          ok: true,
          observation: 'backlog/TODO vazio — nenhum item anotado ainda.',
          display: '[TODO] vazio',
        };
      }
      const pending = items.filter((t) => !t.done);
      const done = items.filter((t) => t.done);
      const lines = [
        `Backlog/TODO (${items.length} itens: ${pending.length} pendentes, ${done.length} feitos):`,
        ...(pending.length > 0
          ? ['', '── Pendentes ──', ...pending.map(fmtItem)]
          : ['', '(nenhum pendente)']),
        ...(done.length > 0 ? ['', '── Feitos ──', ...done.map(fmtItem)] : []),
        '',
        'Use done_todo { id } para marcar um item como feito.',
      ];
      return {
        ok: true,
        observation: lines.join('\n'),
        display: `[TODO] ${pending.length} pendentes, ${done.length} feitos`,
      };
    } catch (e) {
      return {
        ok: false,
        observation: `falha ao listar TODOs: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  },
};

export const doneTodoTool: NativeTool<ToolPorts> = {
  name: DONE_TODO_TOOL_NAME,
  effect: 'memory', // mesmo carve-out: escrita confinada (marca done)
  parameters: DONE_TODO_SCHEMA,
  description:
    'Marca um item do backlog/TODO como CONCLUÍDO. Use ao terminar uma tarefa que estava anotada. ' +
    'Input: { "id": string } — o id do item (do list_todos). NUNCA recebe um path.',
  async run(input, ports): Promise<ToolResult> {
    const todo = ports.todo;
    if (!todo) {
      return {
        ok: false,
        observation: 'backlog/TODO indisponível neste contexto (sem porta de TODO).',
      };
    }
    const id = str(input, 'id');
    if (!id) return { ok: false, observation: 'done_todo requer "id" (string, do list_todos).' };
    try {
      const ok = await todo.done(id);
      return {
        ok: true,
        observation: ok
          ? `TODO ${id} marcado como concluído. ✓`
          : `id não encontrado no backlog: ${id}. Use list_todos para ver os ids.`,
        display: ok ? `[TODO] ${id} ✓ concluído` : `[TODO] ${id} não encontrado`,
      };
    } catch (e) {
      return {
        ok: false,
        observation: `falha ao concluir TODO: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  },
};
