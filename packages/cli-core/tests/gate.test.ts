import { describe, expect, it } from 'vitest';
import { CORE_VERSION, decide, denyAllEngine, type ToolCall } from '../src/index.js';

describe('@hiperplano/aluy-cli-core — versão', () => {
  it('expõe a versão do engine', () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('CLI-SEC-H1 — ponto de interceptação único (seed)', () => {
  const call: ToolCall = { name: 'run_command', input: { cmd: 'rm -rf /' } };

  it('default é deny-by-default até a EST-0945 plugar a política real', () => {
    const verdict = decide(denyAllEngine, call);
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('EST-0945');
  });

  it('todo tool-call passa pelo mesmo ponto `decide()` (engine injetável)', () => {
    const allowEngine = {
      decide: (c: ToolCall) => ({ decision: 'allow' as const, reason: `ok:${c.name}` }),
    };
    expect(decide(allowEngine, call).decision).toBe('allow');
    expect(decide(allowEngine, call).reason).toBe('ok:run_command');
  });
});
