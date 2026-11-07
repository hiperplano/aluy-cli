// ADR 0006 — painel de tarefas do rodapé (linhas puras) e o espaço dele no cockpit.
import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '@hiperplano/aluy-cli-core';
import {
  buildPanelRows,
  panelLines,
  summaryText,
  type PanelInput,
} from '../../src/ui/components/ConciergeTasks.js';
import { cockpitRegionSum, resolveCockpitLayout } from '../../src/session/cockpit-layout.js';

const task = (id: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
  id,
  goal: `objetivo ${id}`,
  status: 'running',
  phase: 'idle',
  kind: 'detached',
  files: [],
  startedAt: 0,
  steps: 0,
  ...over,
});
const base = (tasks: TaskRecord[], over: Partial<PanelInput> = {}): PanelInput => ({
  tasks,
  approvals: [],
  childrenOf: () => [],
  statusline: 'full',
  expanded: false,
  selected: 0,
  now: 12_000,
  ...over,
});
const kinds = (i: PanelInput): string[] => buildPanelRows(i).map((r) => r.kind);

describe('painel de tarefas — linhas', () => {
  it('1–2 tarefas: uma linha por tarefa; com sub-agentes aninhados enquanto rodam', () => {
    const kids = [{ label: 'a', status: 'running' as const }];
    const rows = buildPanelRows(
      base([task('t1'), task('t2', { status: 'done', endedAt: 5 })], {
        childrenOf: (id) => (id === 't1' ? kids : []),
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(['task', 'child', 'task']);
  });

  it('3+ tarefas recolhem em UMA linha `3 tarefas · 2 rodando · ↓ ver`', () => {
    const ts = [task('t1'), task('t2'), task('t3', { status: 'waiting_approval' })];
    const rows = buildPanelRows(base(ts));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'summary',
      text: '3 tarefas · 2 rodando · 1 aguardando aprovação · ↓ ver',
    });
    expect(summaryText([task('t1')], false)).toBe('1 tarefa · 1 rodando');
  });

  it('expandido: lista todas + dica de teclas; seleção marcada', () => {
    const ts = [task('t1'), task('t2'), task('t3')];
    const rows = buildPanelRows(base(ts, { expanded: true, selected: 1 }));
    expect(rows.filter((r) => r.kind === 'task')).toHaveLength(3);
    expect(rows.find((r) => r.kind === 'task' && r.selected)).toMatchObject({ task: { id: 't2' } });
    expect(rows.at(-1)).toMatchObject({ kind: 'text' });
  });

  it('statusline compact/hidden: só a linha-resumo (mesmo com 1 tarefa); aprovações nunca somem', () => {
    const ap = [{ taskId: 't1', summary: 'run_command: $ ls' }];
    expect(kinds(base([task('t1')], { statusline: 'hidden', approvals: ap }))).toEqual([
      'summary',
      'approval',
    ]);
    expect(kinds(base([task('t1')], { statusline: 'compact' }))).toEqual(['summary']);
    expect(kinds(base([], { statusline: 'hidden', approvals: ap }))).toEqual(['approval']);
  });

  it('aprovações: no máximo 2 linhas + contagem do excedente', () => {
    const ap = ['t1', 't2', 't3'].map((taskId) => ({ taskId, summary: 'x' }));
    const rows = buildPanelRows(base([], { approvals: ap }));
    expect(rows.filter((r) => r.kind === 'approval')).toHaveLength(3); // 2 + "…+1"
    expect(rows.at(-1)).toMatchObject({ text: expect.stringContaining('+1') });
  });

  it('altura: 0 sem nada; linhas + 1 de respiro', () => {
    expect(panelLines([])).toBe(0);
    expect(panelLines(buildPanelRows(base([task('t1'), task('t2')])))).toBe(3);
  });
});

describe('cockpit — o painel entra na soma == rows', () => {
  it.each([0, 1, 3, 7])('taskRows=%i: soma das regiões == rows', (n) => {
    const l = resolveCockpitLayout(40, 120, 1, undefined, { taskRows: n });
    if (l.kind !== 'cockpit') throw new Error('deveria caber');
    expect(l.taskRows).toBe(n);
    expect(cockpitRegionSum(l)).toBe(40);
  });
  it('nunca come a área gerida abaixo de 2 linhas e soma segue == rows', () => {
    const l = resolveCockpitLayout(20, 100, 1, undefined, { taskRows: 99 });
    if (l.kind !== 'cockpit') throw new Error('deveria caber');
    expect(l.regions.conversaRows + l.regions.logRows).toBeGreaterThanOrEqual(2);
    expect(cockpitRegionSum(l)).toBe(20);
  });
});
