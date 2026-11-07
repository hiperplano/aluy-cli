// ADR 0006 — o PAINEL DE TAREFAS do rodapé (estilo "tarefas em segundo plano" do Claude Code).
// Mora ABAIXO do composer: nada do trabalho das tarefas entra na conversa. PURO nas contas
// (`buildPanelRows`), para o render e o orçamento de altura (inline e cockpit) usarem as mesmas.
//
// Regras:
//  · poucas tarefas ⇒ uma linha por tarefa (`▸ t1 rodando · bash ls -la · 12s`), com os
//    sub-agentes da tarefa aninhados (com brilho enquanto rodam);
//  · muitas (≥ 3) ou statusline `compact` ⇒ UMA linha (`3 tarefas · 2 rodando · ↓ ver`);
//    `↓` expande (↑↓ escolhe · enter abre o detalhe · p para · esc recolhe);
//  · statusline `hidden` ⇒ só a linha-resumo (e as aprovações, que nunca somem);
//  · aprovações pendentes sempre aparecem (caixa de entrada: `/a` aprova · `/n` nega).
//
// a11y: o estado SEMPRE vem em palavra; o glifo é só apoio.

import React from 'react';
import { Box, Text } from 'ink';
import { Role } from '../theme/index.js';
import { truncateToWidth } from '../markdown/table-layout.js';
import { ShimmerText } from './ShimmerText.js';
import { ChildLine, type SubAgentChildView } from './SubAgents.js';
import { clip, formatElapsed, statusPt, type TaskRecord } from '@hiperplano/aluy-cli-core';

export const MAX_APPROVAL_ROWS = 2;
/** A partir de quantas tarefas a lista recolhe numa linha só. */
export const COLLAPSE_AT = 3;
const MAX_CHILD_ROWS = 3;
const MAX_EXPANDED_TASKS = 6;

export interface ApprovalRow {
  readonly taskId: string;
  readonly summary: string;
}

export type PanelRow =
  | { readonly kind: 'summary'; readonly text: string }
  | {
      readonly kind: 'task';
      readonly task: TaskRecord;
      readonly selected: boolean;
      readonly now: number;
    }
  | { readonly kind: 'child'; readonly child: SubAgentChildView }
  | { readonly kind: 'approval'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string };

export interface PanelInput {
  readonly tasks: readonly TaskRecord[];
  readonly approvals: readonly ApprovalRow[];
  readonly childrenOf: (taskId: string) => readonly SubAgentChildView[];
  readonly statusline: 'full' | 'compact' | 'hidden';
  readonly expanded: boolean;
  readonly selected: number;
  readonly now: number;
}

/** `3 tarefas · 2 rodando · ↓ ver`. */
export function summaryText(tasks: readonly TaskRecord[], hint = true): string {
  const running = tasks.filter((t) => t.status === 'running').length;
  const waiting = tasks.filter((t) => t.status === 'waiting_approval').length;
  const parts = [`${tasks.length} tarefa${tasks.length === 1 ? '' : 's'}`];
  if (running > 0) parts.push(`${running} rodando`);
  if (waiting > 0) parts.push(`${waiting} aguardando aprovação`);
  const paused = tasks.filter((t) => t.status === 'paused_quota').length;
  if (paused > 0) parts.push(`${paused} pausada${paused > 1 ? 's' : ''} (cota)`);
  const ended = tasks.filter((t) => t.endedAt !== undefined).length;
  if (ended > 0) parts.push(`${ended} encerrada${ended > 1 ? 's' : ''}`);
  if (hint) parts.push('↓ ver');
  return parts.join(' · ');
}

export function buildPanelRows(i: PanelInput): PanelRow[] {
  const rows: PanelRow[] = [];
  const tasks = i.tasks;
  if (tasks.length > 0) {
    const collapse = !i.expanded && (i.statusline !== 'full' || tasks.length >= COLLAPSE_AT);
    if (collapse) {
      rows.push({ kind: 'summary', text: summaryText(tasks) });
    } else {
      const shown = i.expanded ? tasks.slice(-MAX_EXPANDED_TASKS) : tasks;
      shown.forEach((t, idx) => {
        rows.push({
          kind: 'task',
          task: t,
          selected: i.expanded && idx === i.selected,
          now: i.now,
        });
        if (t.endedAt === undefined) {
          const kids = i.childrenOf(t.id).slice(0, MAX_CHILD_ROWS);
          for (const c of kids) rows.push({ kind: 'child', child: c });
        }
      });
      if (i.expanded) {
        rows.push({
          kind: 'text',
          text: '↑↓ escolhe · enter detalhes · p para a tarefa · esc recolhe',
        });
      }
    }
  }
  i.approvals
    .slice(0, MAX_APPROVAL_ROWS)
    .forEach((a) =>
      rows.push({
        kind: 'approval',
        text: `⚠ ${a.taskId} pede aprovação: ${a.summary}  ·  /a aprova · /n nega`,
      }),
    );
  if (i.approvals.length > MAX_APPROVAL_ROWS) {
    rows.push({
      kind: 'approval',
      text: `  …+${i.approvals.length - MAX_APPROVAL_ROWS} na caixa de aprovações`,
    });
  }
  return rows;
}

/** Altura (linhas) do painel, com 1 de respiro no fim. 0 quando não há o que mostrar. */
export function panelLines(rows: readonly PanelRow[]): number {
  return rows.length === 0 ? 0 : rows.length + 1;
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

function TaskRow(props: {
  readonly task: TaskRecord;
  readonly selected: boolean;
  readonly now: number;
  readonly width: number;
  readonly frame: number;
}): React.ReactElement {
  const t = props.task;
  const ended = t.endedAt !== undefined;
  const what = ended ? clip(t.goal, 40) : (t.current ?? clip(t.goal, 40));
  const head = `${GLYPH[t.status] ?? '·'} ${t.id} ${statusPt(t.status)}`;
  const tail = ` · ${what} · ${formatElapsed((t.endedAt ?? props.now) - t.startedAt)}`;
  const mark = props.selected ? '❯ ' : '  ';
  const fits = (s: string): string => truncateToWidth(s, Math.max(10, props.width - mark.length));
  const role =
    t.status === 'failed' ? 'danger' : t.status === 'waiting_approval' ? 'accent' : 'fgDim';
  return (
    <Box>
      <Role name={props.selected ? 'accent' : 'fgDim'}>{mark}</Role>
      {t.status === 'running' ? (
        <>
          <ShimmerText text={head} frame={props.frame} papelEstatico="accent" />
          <Role name="fgDim">
            {fits(tail).slice(0, Math.max(0, props.width - mark.length - head.length))}
          </Role>
        </>
      ) : (
        <Role name={ended ? 'fgDim' : role}>{fits(head + tail)}</Role>
      )}
    </Box>
  );
}

export interface TaskPanelProps {
  readonly rows: readonly PanelRow[];
  readonly columns: number;
  readonly frame: number;
}

export function TaskPanel(props: TaskPanelProps): React.ReactElement | null {
  if (props.rows.length === 0) return null;
  const width = Math.max(30, props.columns - 4);
  return (
    <Box flexDirection="column" paddingLeft={2} paddingBottom={1}>
      {props.rows.map((r, idx) => {
        switch (r.kind) {
          case 'summary':
            return (
              <Box key={idx}>
                <Role name="depth">{truncateToWidth(r.text, width)}</Role>
              </Box>
            );
          case 'task':
            return (
              <TaskRow
                key={idx}
                task={r.task}
                selected={r.selected}
                now={r.now}
                width={width}
                frame={props.frame}
              />
            );
          case 'child':
            return (
              <Box key={idx} paddingLeft={2}>
                <ChildLine child={r.child} frame={props.frame} />
              </Box>
            );
          case 'approval':
            return (
              <Box key={idx}>
                <Role name="accent">{truncateToWidth(r.text, width)}</Role>
              </Box>
            );
          case 'text':
            return (
              <Box key={idx}>
                <Text dimColor>{truncateToWidth(r.text, width)}</Text>
              </Box>
            );
        }
      })}
    </Box>
  );
}
