// TOKENS GERADOS NO TURNO — o `↓ N tokens` da linha de trabalho conta só a SAÍDA do pai
// (não o prompt reenviado a cada passo): `tokens_out` reportado + estimativa (~4 chars/token)
// do que a chamada em voo streamou, reconciliada quando o uso chega. Também: cada passo recebe
// o seu próprio `workingSince` (identidade do verbo), inclusive ao retomar/continuar.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

const ports = {
  fs: {
    async readFile() {
      return 'x';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  },
  shell: {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
  search: {
    async search() {
      return { matches: [], truncated: {} };
    },
  },
} as unknown as ToolPorts;

const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

function monta(model: (c: SessionController, k: number) => Promise<ModelCallResult>) {
  let n = 0;
  let ctrl: SessionController | null = null;
  const caller: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      return model(ctrl!, n++);
    },
  };
  const controller = new SessionController({
    model: caller,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports,
    askResolver: approveAll,
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  ctrl = controller;
  return controller;
}

const usage = (out: number, tin = 5000) => ({
  request_id: 'r',
  tier: 'aluy-flux',
  tokens_in: tin,
  tokens_out: out,
});

describe('turnOutputTokens', () => {
  it('estima pelo texto streamado e RECONCILIA com o tokens_out reportado (prompt não conta)', async () => {
    const vistos: number[] = [];
    const controller = monta(async (c, k) => {
      if (k === 0) {
        c.sink.onStart();
        c.sink.onDelta('x'.repeat(400)); // ~100 tokens estimados
        vistos.push(c.turnOutputTokens());
        c.sink.onUsage?.(usage(120, 30_000)); // real: 120 (o prompt de 30k NÃO entra)
        vistos.push(c.turnOutputTokens());
        c.sink.onDone();
        return {
          request_id: 'a',
          content: 'x',
          finish_reason: 'tool_calls',
          tool_calls: [{ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }],
        } as ModelCallResult;
      }
      c.sink.onStart();
      c.sink.onDelta('y'.repeat(200)); // +50 estimados no 2º passo
      if (k === 1) vistos.push(c.turnOutputTokens());
      c.sink.onUsage?.(usage(60, 35_000));
      if (k === 1) vistos.push(c.turnOutputTokens());
      c.sink.onDone();
      return { request_id: 'b', content: 'y', finish_reason: 'stop' };
    });
    await controller.submit('leia');
    expect(vistos).toEqual([100, 120, 170, 180]);
    controller.dispose();
  });

  it('provider SEM tokens_out: a estimativa do passo vira definitiva no passo seguinte', async () => {
    const vistos: number[] = [];
    const controller = monta(async (c, k) => {
      c.sink.onStart();
      c.sink.onDelta('x'.repeat(80)); // 20
      if (k === 0) {
        c.sink.onDone();
        return {
          request_id: 'a',
          content: 'x',
          finish_reason: 'tool_calls',
          tool_calls: [{ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }],
        } as ModelCallResult;
      }
      vistos.push(c.turnOutputTokens()); // 20 do passo 1 + 20 do atual
      c.sink.onDone();
      return { request_id: 'b', content: 'y', finish_reason: 'stop' };
    });
    await controller.submit('leia');
    expect(vistos).toEqual([40]);
    controller.dispose();
  });

  it('zera a cada turno', async () => {
    const controller = monta(async (c) => {
      c.sink.onStart();
      c.sink.onDelta('x'.repeat(40));
      c.sink.onUsage?.(usage(10));
      c.sink.onDone();
      return { request_id: 'a', content: 'x', finish_reason: 'stop' };
    });
    await controller.submit('um');
    await controller.submit('dois');
    expect(controller.turnOutputTokens()).toBe(10);
    controller.dispose();
  });
});

describe('verbo por passo: workingSince novo ao retomar', () => {
  it('continueAfterStuck / redirecionar carimbam workingSince', () => {
    let t = 1000;
    const controller = new SessionController({
      model: {
        async call() {
          return { request_id: 'r', content: 'ok', finish_reason: 'stop' } as ModelCallResult;
        },
      },
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
      clock: () => t,
    });
    // força a fase `stuck` com resolver pendente via API interna de teste
    const c = controller as unknown as {
      state: { phase: string };
      stuckResolve: unknown;
      patch(p: Record<string, unknown>): void;
    };
    c.patch({ phase: 'stuck', workingSince: 5 });
    c.stuckResolve = () => {};
    t = 9999;
    controller.continueAfterStuck();
    expect(controller.current.phase).toBe('thinking');
    expect(controller.current.workingSince).toBe(9999);
    controller.dispose();
  });
});
