// EST-1106 · ADR-workflows — TESTES do WorkflowRunner (FATIA 2).
// Verifica: sequência, parada na falha, abort entre atividades,
// e resultado correto (activitiesRun, stopped, lastStop).

import { describe, it, expect } from 'vitest';
import { runWorkflow } from '../src/agent/workflow/workflow-runner.js';
import type { WorkflowActivityRunner } from '../src/agent/workflow/workflow-runner.js';
import type { WorkflowActivity as WfAct } from '../src/agent/workflow/workflow-parse.js';

function makeAct(id: string, goal: string): WfAct {
  return { id, goal };
}

function makeRunner(
  results: boolean[],
): WorkflowActivityRunner & { calls: Array<{ index: number; total: number }> } {
  const calls: Array<{ index: number; total: number }> = [];
  let i = 0;
  return {
    calls,
    async runActivity(args) {
      calls.push({ index: args.index, total: args.total });
      const ok = results[i] ?? true;
      i++;
      return { ok };
    },
  };
}

describe('runWorkflow', () => {
  it('roda as atividades EM ORDEM (runner fake registra a sequência)', async () => {
    const activities = [makeAct('a', 'A'), makeAct('b', 'B'), makeAct('c', 'C')];
    const runner = makeRunner([true, true, true]);
    const ctrl = new AbortController();

    const res = await runWorkflow(activities, runner, ctrl.signal);

    expect(res).toEqual({ activitiesRun: 3, stopped: false });
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[0]!.index).toBe(0);
    expect(runner.calls[1]!.index).toBe(1);
    expect(runner.calls[2]!.index).toBe(2);
  });

  it('PARA na que falha (não roda as seguintes)', async () => {
    const activities = [makeAct('a', 'A'), makeAct('b', 'B'), makeAct('c', 'C')];
    const runner = makeRunner([true, false, true]);
    const ctrl = new AbortController();

    const res = await runWorkflow(activities, runner, ctrl.signal);

    expect(res).toEqual({ activitiesRun: 2, stopped: true, lastStop: 'error' });
    expect(runner.calls).toHaveLength(2);
  });

  it('respeita abort ENTRE atividades', async () => {
    const activities = [makeAct('a', 'A'), makeAct('b', 'B'), makeAct('c', 'C')];
    const runner = makeRunner([true, true, true]);
    const ctrl = new AbortController();

    // Espiona runActivity para abortar após a 1ª.
    const orig = runner.runActivity.bind(runner);
    runner.runActivity = async (args) => {
      const outcome = await orig(args);
      if (args.index === 0) ctrl.abort();
      return outcome;
    };

    const res = await runWorkflow(activities, runner, ctrl.signal);

    expect(res).toEqual({ activitiesRun: 1, stopped: true, lastStop: 'cancelled' });
  });

  it('roda workflow com 1 atividade', async () => {
    const activities = [makeAct('only', 'Only')];
    const runner = makeRunner([true]);
    const res = await runWorkflow(activities, runner, new AbortController().signal);
    expect(res).toEqual({ activitiesRun: 1, stopped: false });
  });

  it('roda workflow com 0 atividades (vazio = sem erro)', async () => {
    const activities: WfAct[] = [];
    const runner = makeRunner([]);
    const res = await runWorkflow(activities, runner, new AbortController().signal);
    expect(res).toEqual({ activitiesRun: 0, stopped: false });
  });

  it('reporta stop motivo da falha do runner', async () => {
    const activities = [makeAct('a', 'A')];
    const runner: WorkflowActivityRunner = {
      async runActivity() {
        return { ok: false, stop: 'limit' };
      },
    };
    const res = await runWorkflow(activities, runner, new AbortController().signal);
    expect(res).toEqual({ activitiesRun: 1, stopped: true, lastStop: 'limit' });
  });
});
