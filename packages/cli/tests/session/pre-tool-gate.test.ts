// EST-0980 · CLI-SEC-3/H1 — fábrica do GATE de pre-tool (`makePreToolGate`). O glue
// entre o `HookRunner.runGate` (core) e a `PreToolGate` que o loop consulta. Prova:
//  - SEM hooks de gate na config ⇒ `undefined` (no-op: o loop nem consulta a porta);
//  - hook de gate que VETA ⇒ `{ blocked: true, observation }` com o motivo (DADO);
//  - matcher: só os hooks de gate que casam o NOME da tool são rodados;
//  - o veredito NUNCA aprova (só blocked:false|true).

import { describe, expect, it } from 'vitest';
import {
  parseHooksConfig,
  type Hook,
  type HookGateVerdict,
  type HooksConfig,
} from '@hiperplano/aluy-cli-core';
import { makePreToolGate } from '../../src/session/pre-tool-gate.js';

/** HookRunner mínimo p/ o teste: só implementa `runGate` (o que a fábrica usa). */
function fakeRunner(answer: (hooks: readonly Hook[]) => HookGateVerdict) {
  const seen: Hook[][] = [];
  return {
    runner: {
      async runGate(hooks: readonly Hook[]): Promise<HookGateVerdict> {
        seen.push([...hooks]);
        return answer(hooks);
      },
      // O resto da interface não é exercido pela fábrica.
    } as unknown as Parameters<typeof makePreToolGate>[0]['runner'],
    seen,
  };
}

const gateCfg = (matcher?: string): HooksConfig =>
  parseHooksConfig({
    hooks: [
      { event: 'pre-tool', command: 'guard.sh', gate: true, ...(matcher ? { matcher } : {}) },
    ],
  });

describe('EST-0980 · makePreToolGate', () => {
  it('SEM hooks de gate ⇒ undefined (no-op)', () => {
    const { runner } = fakeRunner(() => ({ blocked: false }));
    // config só com observe-only (sem gate:true) ⇒ nenhuma porta.
    const cfg = parseHooksConfig({ hooks: [{ event: 'pre-tool', command: 'obs.sh' }] });
    expect(makePreToolGate({ runner, config: cfg })).toBeUndefined();
  });

  it('hook de gate que VETA ⇒ blocked:true com observação do motivo (DADO)', async () => {
    const { runner } = fakeRunner(() => ({
      blocked: true,
      command: 'guard.sh',
      observation: { role: 'observation', toolName: 'run_command (hook:pre-tool)', text: 'recuso' },
    }));
    const gate = makePreToolGate({ runner, config: gateCfg() })!;
    expect(gate).toBeDefined();
    const verdict = await gate({ name: 'edit_file', input: {} });
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.observation).toContain('VETADA');
    expect(verdict.observation).toContain('guard.sh');
    expect(verdict.observation).toContain('recuso'); // a saída do hook entra como DADO.
  });

  it('matcher: só roda os hooks de gate que casam o NOME da tool', async () => {
    const { runner, seen } = fakeRunner(() => ({ blocked: false }));
    const gate = makePreToolGate({ runner, config: gateCfg('edit_file') })!;
    // tool que NÃO casa o matcher ⇒ não roda nenhum hook.
    const v1 = await gate({ name: 'read_file', input: {} });
    expect(v1.blocked).toBe(false);
    expect(seen).toEqual([]); // runGate nem foi chamado p/ read_file.
    // tool que casa ⇒ roda.
    await gate({ name: 'edit_file', input: {} });
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]!.command).toBe('guard.sh');
  });

  it('não veta ⇒ blocked:false (a tool segue o que a catraca disse)', async () => {
    const { runner } = fakeRunner(() => ({ blocked: false }));
    const gate = makePreToolGate({ runner, config: gateCfg() })!;
    expect((await gate({ name: 'edit_file', input: {} })).blocked).toBe(false);
  });
});
