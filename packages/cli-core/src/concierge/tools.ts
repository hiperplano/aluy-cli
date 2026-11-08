// ADR 0006 — as 4 ferramentas do Concierge (plano de CONTROLE apenas) e as PORTAS que o
// Concierge usa. Nenhuma toca arquivo/shell/rede.

import type { ChatMessage, ModelCallResult, ToolFunctionSchema } from '../model/types.js';
import type { EngineSnapshot } from './digest.js';
import type { TaskRecord } from './tasks.js';

export const CONCIERGE_TOOL_NAMES = [
  'task_start',
  'task_send',
  'task_stop',
  'task_status',
] as const;
export type ConciergeToolName = (typeof CONCIERGE_TOOL_NAMES)[number];

export const CONCIERGE_TOOLS: readonly ToolFunctionSchema[] = [
  {
    type: 'function',
    function: {
      name: 'task_start',
      description:
        'Inicia uma tarefa de trabalho (ler/editar código, rodar comandos, pesquisar). Passe um objetivo completo e autossuficiente. `files`: caminhos que ela vai alterar (evita conflito com outra tarefa).',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Objetivo completo da tarefa.' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Arquivos/pastas que ela vai alterar.',
          },
        },
        required: ['goal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_send',
      description:
        'Envia uma correção ou informação nova a uma tarefa viva. Entra após o passo atual dela.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' }, message: { type: 'string' } },
        required: ['task_id', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_stop',
      description: 'Para uma tarefa. Só quando o dono pediu para parar/cancelar.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_status',
      description: 'Estado detalhado de uma tarefa (ou de todas, sem task_id).',
      parameters: { type: 'object', properties: { task_id: { type: 'string' } } },
    },
  },
];

/** O motor que EXECUTA as tarefas (o cli o implementa sobre o SessionController). */
export interface ConciergeEngine {
  /** Começa a rodar uma tarefa já registrada (`running`). Falhas viram `failed` no registro. */
  start(task: TaskRecord): void;
  /** Entrega uma mensagem do dono à tarefa. `delivered=false` ⇒ não deu (motivo em `note`). */
  send(task: TaskRecord, message: string): { delivered: boolean; note: string };
  /** Para UMA tarefa (cessar ≠ agir: só aborta). */
  stop(task: TaskRecord): boolean;
  /** Retrato do que o motor sabe além do registro. */
  snapshot(): EngineSnapshot;
}

/** Chamada de modelo do Concierge (o cli injeta um caller com SÓ estas 4 tools). */
export interface ConciergeModel {
  call(args: {
    readonly messages: readonly ChatMessage[];
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
    /** Chamada interna (ex.: corretiva): o texto NÃO deve ser transmitido à tela em stream. */
    readonly quiet?: boolean;
  }): Promise<ModelCallResult>;
}

/** O ponto único de permissão também vale para as tools do Concierge. */
export type ConciergeGate = (call: {
  name: ConciergeToolName;
  input: Readonly<Record<string, unknown>>;
}) => Promise<{ allow: true } | { allow: false; reason: string }>;
