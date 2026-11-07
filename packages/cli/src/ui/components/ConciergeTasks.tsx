// ADR 0006 — <ConciergeTasks>: a lista COMPACTA de tarefas ao vivo + a CAIXA DE ENTRADA de
// aprovações. Fica ACIMA do composer, fora da região viva animada (sem jitter). BOUNDED:
// no máximo `MAX_TASK_ROWS` tarefas e `MAX_APPROVAL_ROWS` aprovações; a altura entra no
// orçamento da fala via `conciergeTasksLines`.
//
// a11y: o estado SEMPRE vem em palavra ("rodando", "aguardando aprovação"); o glifo é só apoio.

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';
import { truncateToWidth } from '../markdown/table-layout.js';
import { clip, formatElapsed, statusPt, type TaskRecord } from '@hiperplano/aluy-cli-core';

export const MAX_TASK_ROWS = 4;
export const MAX_APPROVAL_ROWS = 2;

export interface ConciergeApprovalRow {
  readonly taskId: string;
  readonly summary: string;
}

export interface ConciergeTasksProps {
  readonly tasks: readonly TaskRecord[];
  readonly approvals: readonly ConciergeApprovalRow[];
  readonly now: number;
  readonly columns: number;
}

/** Altura (linhas) ocupada — para o orçamento anti-flicker. 0 quando nada a mostrar. */
export function conciergeTasksLines(taskCount: number, approvalCount: number): number {
  if (taskCount === 0 && approvalCount === 0) return 0;
  const t = Math.min(taskCount, MAX_TASK_ROWS) + (taskCount > MAX_TASK_ROWS ? 1 : 0);
  const a =
    Math.min(approvalCount, MAX_APPROVAL_ROWS) + (approvalCount > MAX_APPROVAL_ROWS ? 1 : 0);
  return t + a + 1; // +1 do paddingBottom
}

const GLYPH: Readonly<Record<string, string>> = {
  running: '▸',
  blocked: '⏳',
  waiting_approval: '⚠',
  paused_quota: '⏸',
  done: '✔',
  failed: '✘',
  stopped: '■',
  interrupted: '↯',
};

export function ConciergeTasks(props: ConciergeTasksProps): React.ReactElement | null {
  const { tasks, approvals, now, columns } = props;
  if (tasks.length === 0 && approvals.length === 0) return null;
  const width = Math.max(30, columns - 4);
  const shown = tasks.slice(-MAX_TASK_ROWS);
  const hiddenTasks = tasks.length - shown.length;
  const shownAp = approvals.slice(0, MAX_APPROVAL_ROWS);
  const hiddenAp = approvals.length - shownAp.length;
  return (
    <Box flexDirection="column" paddingBottom={1}>
      {shown.map((t) => {
        const ended = t.endedAt !== undefined;
        const meta = `${statusPt(t.status)} · ${t.steps} passo${t.steps === 1 ? '' : 's'} · ${formatElapsed((t.endedAt ?? now) - t.startedAt)}`;
        const line = `${GLYPH[t.status] ?? '·'} ${t.id} ${meta}  ${clip(t.goal, 60)}`;
        return (
          <Box key={t.id}>
            <Role name={ended ? 'fgDim' : t.status === 'failed' ? 'danger' : 'depth'}>
              {truncateToWidth(line, width)}
            </Role>
          </Box>
        );
      })}
      {hiddenTasks > 0 && (
        <Box>
          <Role name="fgDim">{`  …+${hiddenTasks} tarefa${hiddenTasks > 1 ? 's' : ''} (/task)`}</Role>
        </Box>
      )}
      {shownAp.map((a) => (
        <Box key={`${a.taskId}-${a.summary}`}>
          <Role name="accent">
            {truncateToWidth(
              `⚠ ${a.taskId} pede aprovação: ${a.summary}  ·  /a aprova · /n nega`,
              width,
            )}
          </Role>
        </Box>
      ))}
      {hiddenAp > 0 && (
        <Box>
          <Role name="accent">{`  …+${hiddenAp} aprovaç${hiddenAp > 1 ? 'ões' : 'ão'} na caixa`}</Role>
        </Box>
      )}
    </Box>
  );
}
