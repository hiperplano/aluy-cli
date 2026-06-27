// EST-1110 · ADR-0114 · CA-7 (gate AG-0008) — `perguntar` sob a catraca (CLI-SEC-H1):
// é allow SILENCIOSO (READ_TOOLS) em normal E PERMITIDA no modo Plan (PLAN_READ_ALLOWLIST).
// NÃO tem efeito externo (só coleta um dado local de UI) — por isso não cai em `ask`/`deny`.

import { describe, expect, it } from 'vitest';
import {
  PLAN_READ_ALLOWLIST,
  PolicyPermissionEngine,
  QUESTION_TOOL_NAME,
  type ToolCall,
} from '../../src/index.js';

function call(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { name, input };
}

describe('EST-1110 · `perguntar` sob a catraca (read-only, sem efeito)', () => {
  it('CA-7: normal ⇒ allow SILENCIOSO (não ask)', () => {
    const e = new PolicyPermissionEngine({ mode: 'normal' });
    const v = e.decide(call(QUESTION_TOOL_NAME, { question: 'x', options: ['a'] }));
    expect(v.decision).toBe('allow');
  });

  it('CA-7: Plan ⇒ allow (esclarecer é o caso de uso do planejamento)', () => {
    const e = new PolicyPermissionEngine({ mode: 'plan' });
    const v = e.decide(call(QUESTION_TOOL_NAME, { question: 'x', options: ['a'] }));
    expect(v.decision).toBe('allow');
  });

  it('está na PLAN_READ_ALLOWLIST (lista fechada, por-nome)', () => {
    expect(PLAN_READ_ALLOWLIST.has(QUESTION_TOOL_NAME)).toBe(true);
  });

  it('unsafe ⇒ allow (bypass total não regride; segue read-only)', () => {
    const e = new PolicyPermissionEngine({ mode: 'unsafe' });
    const v = e.decide(call(QUESTION_TOOL_NAME, { question: 'x' }));
    expect(v.decision).toBe('allow');
  });
});
