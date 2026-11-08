import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine, secretVault } from '../../src/index.js';

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

describe('ADR 0006 — "aprovar sempre nesta tarefa" passa por decide()', () => {
  const run = (command: string) => ({ name: 'run_command', input: { command } });
  const edit = { name: 'edit_file', input: { path: 'calc.py', old_string: 'a', new_string: 'b' } };

  it('desligado por padrão: run_command e edit_file pedem ask', () => {
    const e = new PolicyPermissionEngine({});
    expect(e.decide(run('python3 -c "print(1)"')).decision).toBe('ask');
    expect(e.decide(edit).decision).toBe('ask');
  });

  it('ligado: libera o ask por DEFAULT (edit e comandos diferentes), com motivo auditável', () => {
    const e = new PolicyPermissionEngine({});
    e.setTaskAllowAll(true);
    const v = e.decide(run('python3 -c "print(2)"'));
    expect(v.decision).toBe('allow');
    expect(v.reason).toContain('nesta tarefa');
    expect(e.decide(run('python3 -c "print(3)"')).decision).toBe('allow');
    expect(e.decide(edit).decision).toBe('allow');
  });

  it('NÃO vale para sempre-ask: rede, escalada, destrutivo e secret-use seguem em ask', () => {
    const e = new PolicyPermissionEngine({});
    e.setTaskAllowAll(true);
    for (const c of ['curl https://example.com/x', 'sudo ls', 'rm -rf build']) {
      const v = e.decide(run(c));
      expect(v.decision, c).not.toBe('allow');
      expect(v.category ?? '', c).toMatch(/^always-ask:/);
    }
    secretVault.set('API_KEY', 'valor-canario-123456');
    try {
      const v = e.decide(run('echo $API_KEY'));
      expect(v.decision).toBe('ask');
      expect(v.category).toBe('always-ask:secret-use');
    } finally {
      secretVault.clear();
    }
  });

  it('não vaza: outra engine (outra tarefa) e os filhos não herdam; deny e plan seguem', () => {
    const a = new PolicyPermissionEngine({});
    a.setTaskAllowAll(true);
    const b = new PolicyPermissionEngine({});
    expect(b.decide(run('ls -la')).decision).toBe('ask');
    expect(a.forSubAgent().decide(run('ls -la')).decision).not.toBe('allow');
    const plan = new PolicyPermissionEngine({ mode: 'plan' });
    plan.setTaskAllowAll(true);
    expect(plan.decide(run('ls')).decision).toBe('deny');
    const denyRule = new PolicyPermissionEngine({
      policy: { rules: [{ tool: 'run_command', match: 'ls*', decision: 'deny' }] },
    });
    denyRule.setTaskAllowAll(true);
    expect(denyRule.decide(run('ls -la')).decision).toBe('deny');
  });
});
