// LINHA DE TRABALHO PRESA — o dono viu `Planejando… (preparando · 2s)` que não saía. A fase
// `thinking` só pode existir enquanto há turno vivo. Estes testes varrem os desfechos de um
// `submit` e provam que NENHUM deixa `thinking`/`retrying`/`streaming` para trás.

import { describe, expect, it } from 'vitest';
import {
  ModelCallAbortedError,
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

function monta(model: ModelCaller, extra: Record<string, unknown> = {}): SessionController {
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports,
    askResolver: approveAll,
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
    ...extra,
  } as ConstructorParameters<typeof SessionController>[0]);
}

const OCUPADAS = ['thinking', 'retrying', 'streaming'];

describe('nenhum desfecho de submit deixa a linha de trabalho presa', () => {
  it('resposta final normal', async () => {
    const c = monta({
      async call(): Promise<ModelCallResult> {
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
      },
    });
    await c.submit('oi');
    expect(OCUPADAS).not.toContain(c.current.phase);
    c.dispose();
  });

  it('modelo lança erro NÃO retryável', async () => {
    const c = monta({
      async call(): Promise<ModelCallResult> {
        throw new Error('boom');
      },
    });
    await c.submit('oi');
    expect(OCUPADAS).not.toContain(c.current.phase);
    c.dispose();
  });

  it('cancelamento (abort) durante a chamada', async () => {
    const c = monta({
      async call(): Promise<ModelCallResult> {
        throw new ModelCallAbortedError();
      },
    });
    await c.submit('oi');
    expect(OCUPADAS).not.toContain(c.current.phase);
    c.dispose();
  });

  it('abrir o turno FALHA (árvore de fluxos/contabilidade): fase resolvida, sem rejeição', async () => {
    const c = monta({
      async call(): Promise<ModelCallResult> {
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
      },
    });
    (c as unknown as { startTurnAccounting: () => void }).startTurnAccounting = () => {
      throw new Error('contabilidade quebrou');
    };
    await expect(c.submit('oi')).resolves.toBeUndefined();
    expect(OCUPADAS).not.toContain(c.current.phase);
    c.dispose();
  });

  it('a rede de segurança limpa uma fase presa sem turno vivo, mas respeita decisões', () => {
    const c = monta({
      async call(): Promise<ModelCallResult> {
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
      },
    });
    const i = c as unknown as {
      patch(p: Record<string, unknown>): void;
      garantirRepousoSemTurno(): void;
    };
    i.patch({ phase: 'thinking', workingLabel: 'preparando', workingSince: 1 });
    i.garantirRepousoSemTurno();
    expect(c.current.phase).toBe('idle');
    expect(c.current.workingLabel).toBeUndefined();
    i.patch({ phase: 'asking' });
    i.garantirRepousoSemTurno();
    expect(c.current.phase).toBe('asking'); // decisão pendente não é tocada
    c.dispose();
  });
});
