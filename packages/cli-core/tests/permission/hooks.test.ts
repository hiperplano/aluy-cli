// EST-0945 · CA-6 — hooks de pré-decisão (allow/ask/deny programático).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  runHooks,
  type PreToolUseHook,
  type ToolCall,
} from '../../src/index.js';

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { name, input };
}

describe('CA-6 — hooks interceptam ANTES do efeito', () => {
  it('um hook que NEGA um path bloqueia o toque (antes do efeito)', () => {
    const denyInfra: PreToolUseHook = (c) =>
      typeof c.input['path'] === 'string' && (c.input['path'] as string).startsWith('infra/')
        ? { decision: 'deny', reason: 'infra/ é protegido' }
        : undefined;
    const engine = new PolicyPermissionEngine({ hooks: [denyInfra] });

    const v = engine.decide(call('edit_file', { path: 'infra/main.tf', content: 'x' }));
    expect(v.decision).toBe('deny');
    expect(v.reason).toContain('infra/');
    // path fora do hook segue o fluxo normal (ask por default).
    expect(engine.decide(call('edit_file', { path: 'src/a.ts', content: 'x' })).decision).toBe(
      'ask',
    );
  });

  it('um hook pode FORÇAR ask sobre algo que seria allow (read)', () => {
    const askReads: PreToolUseHook = (c) =>
      c.name === 'read_file' ? { decision: 'ask', reason: 'auditar leituras' } : undefined;
    const engine = new PolicyPermissionEngine({ hooks: [askReads] });
    expect(engine.decide(call('read_file', { path: 'src/a.ts' })).decision).toBe('ask');
  });

  it('um hook NÃO pode RELAXAR uma categoria sempre-ask (allow é ignorado)', () => {
    const allowAll: PreToolUseHook = () => ({ decision: 'allow', reason: 'eu confio' });
    const engine = new PolicyPermissionEngine({ hooks: [allowAll] });
    // hook-allow não vence a categoria destrutiva.
    expect(engine.decide(call('run_command', { command: 'rm -rf x' })).decision).toBe('ask');
    // mas um bash comum, sim, o hook-allow libera.
    expect(engine.decide(call('run_command', { command: 'ls' })).decision).toBe('allow');
  });

  it('hook-deny vence até a categoria (mais restritivo)', () => {
    const denyExec: PreToolUseHook = (c) =>
      c.name === 'run_command' ? { decision: 'deny', reason: 'sem bash hoje' } : undefined;
    const engine = new PolicyPermissionEngine({ hooks: [denyExec] });
    expect(engine.decide(call('run_command', { command: 'rm -rf x' })).decision).toBe('deny');
  });
});

describe('runHooks — agregação (deny > ask > allow > abstém)', () => {
  const c = call('run_command', { command: 'ls' });

  it('deny vence imediatamente', () => {
    const out = runHooks(
      [() => ({ decision: 'allow', reason: 'a' }), () => ({ decision: 'deny', reason: 'd' })],
      c,
    );
    expect(out?.decision).toBe('deny');
  });

  it('ask vence allow', () => {
    const out = runHooks(
      [() => ({ decision: 'allow', reason: 'a' }), () => ({ decision: 'ask', reason: 'q' })],
      c,
    );
    expect(out?.decision).toBe('ask');
  });

  it('todos abstêm ⇒ undefined', () => {
    expect(runHooks([() => undefined, () => undefined], c)).toBeUndefined();
  });
});
