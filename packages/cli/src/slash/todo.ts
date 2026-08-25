// EST-1108 — comando `/todo` (backlog/TODO persistente).
//
// Espelha o `/memory` (EST-0983) mas com estrutura mais simples:
//   /todo             → LISTA (pendentes + feitos) com id + texto + ✓/○
//   /todo done <id>   → marca um item como concluído. EFEITO ⇒ NEGADO em Plan.
//   /todo clear       → limpa os itens já feitos. EFEITO ⇒ NEGADO em Plan.
//
// O roteamento (parse) é PURO/testável; o runner consome a `TodoStorePort` e
// checa o MODO (Plan nega mutações). Comandos EM INGLÊS (done/clear).

import { tableLines, type TodoItem, type TodoStorePort } from '@hiperplano/aluy-cli-core';
import type { SlashNote } from './handlers.js';

/** O subcomando parseado de `/todo <args>`. */
export type TodoCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'done'; readonly id: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'help'; readonly reason: string };

/** `true` se o subcomando MUTA o backlog (efeito ⇒ negado em Plan). */
export function isTodoMutation(cmd: TodoCommand): boolean {
  return cmd.kind === 'done' || cmd.kind === 'clear';
}

/**
 * Roteia `/todo <args>`. PURO/determinístico. Args vazio ⇒ LISTA.
 * Subcomando desconhecido ⇒ `help`.
 */
export function parseTodoCommand(args: string): TodoCommand {
  const trimmed = args.trim();
  if (trimmed === '') return { kind: 'list' };
  const spaceIdx = trimmed.search(/\s/);
  const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  if (verb === 'list' || verb === 'ls') return { kind: 'list' };

  if (verb === 'done') {
    if (rest === '') return { kind: 'help', reason: 'done requer um <id> (veja /todo).' };
    return { kind: 'done', id: rest.split(/\s+/)[0]! };
  }

  if (verb === 'clear') return { kind: 'clear' };

  if (verb === 'help') return { kind: 'help', reason: '' };

  return { kind: 'help', reason: `subcomando desconhecido: "${verb}".` };
}

/**
 * As linhas de UM grupo (pendentes OU feitos) alinhadas — item (marca+id) · tarefa.
 * Sem cabeçalho: cada grupo já tem o título "── Pendentes ──"/"── Feitos ──" acima,
 * repetir "id/tarefa" seria redundante. O id nunca é truncado (é o que `/todo done
 * <id>` pede de volta); a tarefa é a última coluna — livre p/ ficar longa.
 */
function itemsTable(items: readonly TodoItem[]): string[] {
  return tableLines(items.map((t) => [`${t.done ? '✓' : '○'} ${t.id}`, t.text]));
}

const HELP_LINES: readonly string[] = [
  'uso:',
  '  /todo                  lista os itens (pendentes + feitos)',
  '  /todo done <id>        marca um item como concluído',
  '  /todo clear            remove os itens já feitos',
  '',
  'o agente anota pedidos com a tool add_todo; você gerencia com /todo.',
];

/**
 * Executa `/todo` contra a `TodoStorePort`. `isPlan` = a sessão está em
 * modo Plan? Em Plan, as MUTAÇÕES (done/clear) são NEGADAS (ADR-0055).
 */
export async function runTodoCommand(
  cmd: TodoCommand,
  store: TodoStorePort,
  isPlan: boolean,
): Promise<SlashNote> {
  if (cmd.kind === 'help') {
    const lines = cmd.reason ? [cmd.reason, '', ...HELP_LINES] : [...HELP_LINES];
    return { title: 'todo', lines };
  }
  if (cmd.kind === 'list') {
    const items = await store.list();
    if (items.length === 0) {
      return {
        title: 'todo',
        lines: ['backlog vazio — nenhum item anotado ainda.', '', ...HELP_LINES],
      };
    }
    const pending = items.filter((t) => !t.done);
    const done = items.filter((t) => t.done);
    const lines = [
      `backlog (${items.length} itens: ${pending.length} pendentes, ${done.length} feitos):`,
      ...(pending.length > 0
        ? ['', '── Pendentes ──', ...itemsTable(pending)]
        : ['', '(nenhum pendente)']),
      ...(done.length > 0 ? ['', '── Feitos ──', ...itemsTable(done)] : []),
      '',
      'marque feito com /todo done <id> · limpe feitos com /todo clear',
    ];
    return { title: `todo (${pending.length} pendentes)`, lines };
  }

  // Mutações: NEGADAS em Plan (efeito; ADR-0055).
  if (isPlan) {
    return {
      title: 'todo',
      lines: [
        '⊘ modo Plan (read-only): done/clear o backlog é EFEITO — negado.',
        'saia do Plan (Tab/▸ normal) p/ marcar itens como feitos.',
      ],
    };
  }

  if (cmd.kind === 'done') {
    const ok = await store.done(cmd.id);
    return {
      title: 'todo',
      lines: [
        ok
          ? `item ${cmd.id} marcado como concluído. ✓`
          : `id não encontrado: ${cmd.id}. Use /todo para ver os ids.`,
      ],
    };
  }
  // cmd.kind === 'clear'
  const count = await store.clearDone();
  return {
    title: 'todo',
    lines: [
      count > 0 ? `${count} item(ns) concluído(s) removido(s).` : 'nenhum item feito para limpar.',
    ],
  };
}
