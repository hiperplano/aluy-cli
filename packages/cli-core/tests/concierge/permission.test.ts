import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine } from '../../src/index.js';

const call = (name: string) => ({ name, input: { goal: 'x', task_id: 't1', message: 'm' } });

describe('Concierge — as tools task_* passam pelo ponto único (decide)', () => {
  it('permitidas em normal e em plan (plano de controle)', () => {
    for (const mode of ['normal', 'plan'] as const) {
      const e = new PolicyPermissionEngine({ mode });
      for (const t of ['task_start', 'task_send', 'task_stop', 'task_status'])
        expect(e.decide(call(t)).decision).toBe('allow');
    }
  });
  it('negadas para sub-agentes (profundidade) e quando a política pede ask', () => {
    const child = new PolicyPermissionEngine({ denySpawnAgent: true });
    expect(child.decide(call('task_start')).decision).toBe('deny');
    const ask = new PolicyPermissionEngine({
      policy: { rules: [], defaults: { task_start: 'ask' } },
    });
    expect(ask.decide(call('task_start')).decision).toBe('ask');
  });
  it('não afrouxa nada: run_command continua pedindo confirmação', () => {
    const e = new PolicyPermissionEngine({});
    expect(e.decide({ name: 'run_command', input: { command: 'ls' } }).decision).not.toBe('allow');
  });
});
