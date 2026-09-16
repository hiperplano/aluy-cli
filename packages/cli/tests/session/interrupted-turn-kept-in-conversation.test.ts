// TURNO INTERROMPIDO FICA NA CONVERSA — depois do ESC, o modelo tem de saber o que houve.
//
// Relato do dono (16/09): "na memória ele não lembra muito do que tava fazendo". Pediu três
// agentes, ESC, "o que vc fez" → "nada ainda". Com um provider falso, a chamada seguinte ao ESC
// levava só `[system, "o que vc fez"]` (na `main` também): `onError` voltava ao composer sem
// guardar nada, e o `lastRunHistory` seguia apontando para o turno ANTERIOR ao interrompido.

import { describe, expect, it } from 'vitest';
import {
  ModelCallAbortedError,
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

function ports(): ToolPorts {
  return {
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
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return { matches: [], truncated: {} };
      },
    },
  };
}

const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 };

/** Cada chamada: o texto de TODAS as mensagens `user`/`assistant` que o modelo recebeu. */
function setup(script: (n: number, c: SessionController) => string): {
  c: SessionController;
  seen: string[];
} {
  const seen: string[] = [];
  let ref: SessionController | null = null;
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      seen.push(
        args.messages
          .filter((m) => m.role !== 'system')
          .map((m) => `[${m.role}] ${m.content}`)
          .join('\n'),
      );
      const content = script(seen.length - 1, ref!);
      return { request_id: 'r', content, finish_reason: 'stop', usage };
    },
  };
  const c = new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: ports(),
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 },
  });
  ref = c;
  return { c, seen };
}

describe('turno interrompido fica na conversa', () => {
  it('o turno seguinte ao ESC vê o pedido interrompido e o aviso de interrupção', async () => {
    const { c, seen } = setup((n, ctl) => {
      if (n === 0) {
        ctl.interrupt(); // ESC durante a chamada do modelo
        throw new ModelCallAbortedError();
      }
      return 'resposta.';
    });

    await c.submit('lança três agentes');
    expect(c.current.phase).toBe('idle');
    await c.submit('o que vc fez');

    const second = seen[1]!;
    expect(second, 'o pedido interrompido sumiu do contexto').toContain('lança três agentes');
    expect(second).toMatch(/interromp/i);
    expect(second).toContain('o que vc fez');
    c.dispose();
  });

  it('a conversa ANTERIOR ao turno interrompido continua lá (não é substituída por menos)', async () => {
    const { c, seen } = setup((n, ctl) => {
      if (n === 1) {
        ctl.interrupt();
        throw new ModelCallAbortedError();
      }
      return n === 0 ? 'primeira resposta.' : 'ok.';
    });

    await c.submit('primeiro pedido');
    await c.submit('segundo pedido');
    await c.submit('terceiro');

    const third = seen[2]!;
    expect(third).toContain('primeiro pedido');
    expect(third).toContain('primeira resposta.');
    expect(third).toContain('segundo pedido');
    c.dispose();
  });
});
