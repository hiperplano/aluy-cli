// ADR 0006 — painel de tarefas do rodapé (linhas puras) e o espaço dele no cockpit.
import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '@hiperplano/aluy-cli-core';
import {
  buildPanelRows,
  panelLines,
  summaryText,
  MAX_PANEL_TASKS,
  type PanelInput,
} from '../../src/ui/components/ConciergeTasks.js';
import type { SubAgentChildView } from '../../src/ui/components/SubAgents.js';
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
const view = (t: TaskRecord): SubAgentChildView => ({
  label: t.id,
  status: t.endedAt !== undefined ? 'done' : 'running',
  summary: '0 tokens',
});
const base = (tasks: TaskRecord[], over: Partial<PanelInput> = {}): PanelInput => ({
  tasks,
  approvals: [],
  childrenOf: () => [],
  viewOf: view,
  maxRows: 8,
  statusline: 'full',
  expanded: false,
  selected: 0,
  now: 12_000,
  ...over,
});
const kinds = (i: PanelInput): string[] => buildPanelRows(i).map((r) => r.kind);
const kid = (label: string) => ({ label, status: 'running' as const });

describe('painel de tarefas — hierarquia por TAREFA, agentes aninhados', () => {
  it('com espaço: cabeçalho + tarefa + os agentes dela (nível 2), tarefa a tarefa', () => {
    const rows = buildPanelRows(
      base([task('t1'), task('t2')], {
        childrenOf: (id) => (id === 't1' ? [kid('a'), kid('b')] : []),
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(['header', 'task', 'child', 'child', 'task']);
  });

  it('falta espaço: os AGENTES recolhem para `· N agentes` na linha da tarefa (uma linha por tarefa)', () => {
    const ts = [task('t1'), task('t2'), task('t3')];
    const rows = buildPanelRows(
      base(ts, { maxRows: 5, childrenOf: (id) => (id === 't1' ? [kid('a'), kid('b')] : []) }),
    );
    expect(rows.map((r) => r.kind)).toEqual(['header', 'task', 'task', 'task']);
    const t1 = rows[1] as { view: SubAgentChildView };
    expect(t1.view.summary).toContain('2 agentes');
    expect(t1.view.status).toBe('running'); // segue vivo (brilho)
  });

  it('nem as tarefas cabem: mostra as que cabem (prioridade) e `… +N tarefas ocultas · ↓ ver`', () => {
    const rows = buildPanelRows(base([task('t1'), task('t2'), task('t3')], { maxRows: 2 }));
    expect(rows.map((r) => r.kind)).toEqual(['header', 'task', 'summary']);
    expect(rows.at(-1)).toMatchObject({ kind: 'summary', text: '… +2 tarefas ocultas · ↓ ver' });
    expect(summaryText([task('t1')], false)).toBe('1 tarefa · 1 rodando');
    // 3 terminaram, a lista só desenha 2: o resumo ainda conta as 3 (não "2 tarefas · 2 encerradas").
    const fim = (id: string) => task(id, { status: 'done', endedAt: 5 });
    expect(summaryText([fim('t2'), fim('t3')], false, 1)).toBe('3 tarefas · 3 encerradas');
  });

  describe('até MAX_PANEL_TASKS tarefas ao mesmo tempo', () => {
    const muitas = (n: number): TaskRecord[] =>
      Array.from({ length: n }, (_, k) => task(`t${k + 1}`));
    it('8 tarefas (espaço de sobra): 6 linhas de tarefa + `… +2 tarefas ocultas · ↓ ver`', () => {
      const rows = buildPanelRows(base(muitas(8), { maxRows: 14 }));
      expect(rows.filter((r) => r.kind === 'task')).toHaveLength(MAX_PANEL_TASKS);
      expect(MAX_PANEL_TASKS).toBe(6);
      expect(rows.at(-1)).toMatchObject({ kind: 'summary', text: '… +2 tarefas ocultas · ↓ ver' });
    });
    it('exatamente 6: sem a linha de ocultas; 7: `+1 tarefa oculta`', () => {
      expect(buildPanelRows(base(muitas(6), { maxRows: 14 })).map((r) => r.kind)).toEqual([
        'header',
        'task',
        'task',
        'task',
        'task',
        'task',
        'task',
      ]);
      expect(buildPanelRows(base(muitas(7), { maxRows: 14 })).at(-1)).toMatchObject({
        text: '… +1 tarefa oculta · ↓ ver',
      });
    });
    it('statusline compact também mostra até 6 (resumo + tarefas + ocultas)', () => {
      const rows = buildPanelRows(base(muitas(8), { maxRows: 14, statusline: 'compact' }));
      expect(rows.map((r) => r.kind)).toEqual([
        'summary',
        'task',
        'task',
        'task',
        'task',
        'task',
        'task',
        'summary',
      ]);
    });
    it('prioridade: aguardando aprovação, depois rodando, depois na fila, depois encerradas', () => {
      const ts = [
        task('t1', { status: 'done', endedAt: 5 }),
        task('t2', { status: 'blocked', queued: true }),
        task('t3'),
        task('t4', { status: 'waiting_approval' }),
      ];
      const rows = buildPanelRows(base(ts, { maxRows: 14 }));
      const ordem = rows
        .filter((r) => r.kind === 'task')
        .map((r) => (r as { view: SubAgentChildView }).view.label);
      expect(ordem).toEqual(['t4', 't3', 't2', 't1']);
      // com teto de 2 sobram as de maior prioridade
      const so2 = buildPanelRows(base(ts, { maxRows: 4 }));
      expect(
        so2
          .filter((r) => r.kind === 'task')
          .map((r) => (r as { view: SubAgentChildView }).view.label),
      ).toEqual(['t4', 't3']);
    });
    it('terminal baixo: o painel NUNCA passa de maxRows (cabeçalho + tarefas + ocultas), qualquer nº de tarefas', () => {
      for (const statusline of ['full', 'compact'] as const)
        for (let room = 3; room <= 14; room++)
          for (const n of [1, 2, 3, 6, 7, 12]) {
            const rows = buildPanelRows(base(muitas(n), { maxRows: room, statusline }));
            expect(panelLines(rows), `${statusline} room=${room} n=${n}`).toBeLessThanOrEqual(
              Math.max(room, 3),
            );
          }
    });
  });

  it('expandido: tarefas COM os agentes + dica de teclas; seleção marcada', () => {
    const ts = [task('t1'), task('t2'), task('t3')];
    const rows = buildPanelRows(
      base(ts, { expanded: true, selected: 1, maxRows: 2, childrenOf: () => [kid('a')] }),
    );
    expect(rows.filter((r) => r.kind === 'task')).toHaveLength(3);
    expect(rows.filter((r) => r.kind === 'child')).toHaveLength(3);
    expect(rows.find((r) => r.kind === 'task' && r.selected)).toMatchObject({
      view: { label: 't2' },
    });
    expect(rows.at(-1)).toMatchObject({ kind: 'text' });
  });

  it('statusline compact/hidden: só a linha-resumo; aprovações nunca somem', () => {
    const ap = [{ taskId: 't1', summary: 'run_command: $ ls' }];
    expect(kinds(base([task('t1')], { statusline: 'hidden', approvals: ap }))).toEqual([
      'summary',
      'approval', // cabeçalho do pedido (`⚠ t1 pede aprovação`)
      'approval', // o efeito exato
    ]);
    // compact: o resumo + a linha VIVA de quem roda (sinal de vida); hidden: só o resumo.
    expect(kinds(base([task('t1')], { statusline: 'compact' }))).toEqual(['summary', 'task']);
    expect(kinds(base([task('t1')], { statusline: 'hidden' }))).toEqual(['summary']);
    expect(kinds(base([], { statusline: 'hidden', approvals: ap }))).toEqual([
      'approval',
      'approval',
    ]);
  });

  it('aprovações: no máximo 2 pedidos (cabeçalho + efeito) e a contagem do excedente', () => {
    const ap = ['t1', 't2', 't3'].map((taskId) => ({ taskId, summary: 'x' }));
    const rows = buildPanelRows(base([], { approvals: ap }));
    const texts = rows.map((r) => (r.kind === 'approval' ? r.text : ''));
    expect(texts.filter((t) => t.includes('pede aprovação'))).toHaveLength(2);
    expect(texts.at(-1)).toContain('+1');
  });

  it('aprovação mostra o efeito EXATO, quebrado em linhas (até 4) — nunca cortado cedo', () => {
    const cmd = `run_command: $ ${'find . -name "*.md" && '.repeat(8)}echo FIM-DO-COMANDO`;
    const rows = buildPanelRows(
      base([], { approvals: [{ taskId: 't1', summary: cmd }], columns: 100 }),
    );
    const texts = rows.map((r) => (r.kind === 'approval' ? r.text : ''));
    expect(texts[0]).toContain('t1 pede aprovação');
    expect(texts.slice(1).join('')).toContain('FIM-DO-COMANDO'); // cabe: aparece inteiro
    const huge = buildPanelRows(
      base([], { approvals: [{ taskId: 't1', summary: 'a'.repeat(5000) }], columns: 100 }),
    );
    const h = huge.map((r) => (r.kind === 'approval' ? r.text : ''));
    expect(h.length).toBeLessThanOrEqual(1 + 4); // cabeçalho + no máximo 4 linhas do efeito
    expect(h.at(-1)).toMatch(/…$/); // e avisa que passou do limite
  });

  it('altura: 0 sem nada; linhas + 1 de respiro', () => {
    expect(panelLines([])).toBe(0);
    expect(panelLines(buildPanelRows(base([task('t1'), task('t2')])))).toBe(3); // cabeçalho + 2, sem respiro
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

describe('aprovação com DIFF — multi-linha, recortada, com `… +N linhas`', () => {
  const diff = (n: number): string[] => [
    '--- calc.py',
    '+++ calc.py',
    ...Array.from({ length: n }, (_, k) => (k % 2 === 0 ? `- old ${k}` : `+ new ${k}`)),
  ];
  const ap = (n: number) => ({
    taskId: 't1',
    summary: 'edit_file: ...',
    effect: { kind: 'diff', tool: 'edit_file', path: 'calc.py', lines: diff(n) },
  });

  it('cabeçalho com tool + arquivo e uma linha por linha do diff (sem --- / +++)', () => {
    const rows = buildPanelRows(base([], { approvals: [ap(2)] }));
    expect(rows.map((r) => r.kind)).toEqual(['approval', 'diff', 'diff']);
    expect((rows[0] as { text: string }).text).toContain('edit_file calc.py');
    expect((rows[0] as { text: string }).text).toContain('/a! sempre na tarefa');
    expect(rows.slice(1).map((r) => (r as { line: string }).line)).toEqual(['- old 0', '+ new 1']);
  });

  it('diff grande: recorta em 10 e avisa `… +N linhas`; /a show (approvalFull) mostra tudo', () => {
    const cut = buildPanelRows(base([], { approvals: [ap(40)] }));
    expect(cut.filter((r) => r.kind === 'diff')).toHaveLength(10);
    expect((cut.at(-1) as { text: string }).text).toContain('… +30 linhas');
    const full = buildPanelRows(
      base([], { approvals: [ap(40)], approvalFull: true, fullRows: 50 }),
    );
    expect(full.filter((r) => r.kind === 'diff')).toHaveLength(40);
    expect((full.at(-1) as { text: string }).text).toContain('/a show recolhe');
  });
});
