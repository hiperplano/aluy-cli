// Auditoria — ADR aluy-cli 0002: precedência da delegação "allow por padrão". Complementa agent-messaging.test.ts / agent-toolscope.test.ts.

import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine } from '../../src/permission/engine.js';
import type { ToolCall } from '../../src/permission/gate.js';

const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({ name, input });

describe('delegação: allow por padrão, mas o dono pode voltar a perguntar', () => {
  it('default: spawn_agent / agent_send / agents_status / ask_parent / report_status são allow', () => {
    const e = new PolicyPermissionEngine();
    for (const n of ['spawn_agent', 'agent_send', 'agents_status', 'ask_parent', 'report_status']) {
      expect(e.decide(call(n, {})).decision, n).toBe('allow');
    }
  });

  it('agents_stop continua pedindo confirmação (parar o trabalho do dono não é automático)', () => {
    expect(new PolicyPermissionEngine().decide(call('agents_stop', { label: 'a' })).decision).toBe(
      'ask',
    );
  });

  it('config `defaults.spawn_agent = ask` volta a perguntar', () => {
    const e = new PolicyPermissionEngine({
      policy: { rules: [], defaults: { spawn_agent: 'ask' } },
    });
    expect(e.decide(call('spawn_agent', { agents: [] })).decision).toBe('ask');
  });

  it('o "sempre permitir" lembrado vence o default configurado `ask`', () => {
    const e = new PolicyPermissionEngine({
      policy: { rules: [], defaults: { agent_send: 'ask' } },
    });
    expect(e.decide(call('agent_send', { to: 'a', message: 'x' })).decision).toBe('ask');
    expect(e.rememberAllow('agent_send')).toBe(true);
    expect(e.decide(call('agent_send', { to: 'a', message: 'x' })).decision).toBe('allow');
  });

  it('uma regra explícita vence o lembrado e o default', () => {
    const e = new PolicyPermissionEngine({
      policy: { rules: [{ tool: 'spawn_agent', decision: 'deny' }], defaults: {} },
    });
    e.rememberAllow('spawn_agent');
    expect(e.decide(call('spawn_agent', { agents: [] })).decision).toBe('deny');
  });

  it('Plan nega delegação mesmo sendo allow por padrão fora dele', () => {
    const plan = new PolicyPermissionEngine({ mode: 'plan' });
    expect(plan.decide(call('spawn_agent', { agents: [] })).decision).toBe('deny');
  });
});
