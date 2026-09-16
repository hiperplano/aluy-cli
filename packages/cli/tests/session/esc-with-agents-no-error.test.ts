// ESC COM AGENTES RODANDO não é erro.
//
// Relato do dono (16/09): "quando eu dou um esc no meio da execução de agentes ele estoura um
// erro". Na tela: o bloco do `spawn_agent` em vermelho ("erro ✘"), cada filho "(error, sem
// sucesso)", "N sub-agente(s) concluíram" e a sugestão "tente outra abordagem — o erro foi…".
// Nada tinha falhado: o ESC para só o pai, e os filhos seguem (com provider falso, terminaram o
// `sleep` depois do ESC). O desfecho de desacople do ESC era `ok:false`/`stop:'error'` sob a
// premissa de que "ninguém lê" — mas a tela lê, e desde que o turno interrompido passou a ficar
// na conversa, o modelo também.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  SPAWN_AGENT_TOOL_NAME,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

const toolCall = (name: string, input: Record<string, unknown>): string =>
  `<<<ALUY_TOOL_CALL\n${JSON.stringify({ name, input })}\nALUY_TOOL_CALL>>>`;

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

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 };

/** Pai delega 2 filhos; filhos penduram até `soltar`. `vistas` = o que o PAI levou ao modelo. */
function scenario(): { model: ModelCaller; release: () => void; seen: string[] } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen: string[] = [];
  let parent: string | null = null;
  let parentCalls = 0;
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const session = key.slice(0, key.lastIndexOf(':'));
      if (parent === null) parent = session;
      if (session === parent) {
        parentCalls += 1;
        seen.push(
          args.messages
            .filter((m) => m.role !== 'system')
            .map((m) => m.content)
            .join('\n'),
        );
        const content =
          parentCalls === 1
            ? toolCall(SPAWN_AGENT_TOOL_NAME, {
                agents: [
                  { label: 'a', goal: 'g-a' },
                  { label: 'b', goal: 'g-b' },
                ],
              })
            : 'ok.';
        return { request_id: 'r', content, finish_reason: 'stop', usage };
      }
      await Promise.race([
        gate,
        new Promise<void>((res) => args.signal?.addEventListener('abort', () => res())),
      ]);
      if (args.signal?.aborted) throw new Error('abortado');
      return { request_id: 'r', content: 'relatório.', finish_reason: 'stop', usage };
    },
  };
  return { model, release, seen };
}

describe('ESC com agentes rodando', () => {
  it('o bloco do spawn_agent NÃO sai como erro e não diz que os filhos falharam/concluíram', async () => {
    const { model, release } = scenario();
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
      subAgents: { enabled: true, maxConcurrency: 2, timeoutMs: 60_000 },
    });

    const turn = c.submit('dispara agentes');
    await waitFor(() => c.flowOverview().filter((n) => n.kind === 'subagent').length === 2);
    c.interrupt(); // ESC
    await turn;

    const block = c.current.blocks.find((b) => b.kind === 'tool' && b.verb === 'spawn_agent');
    expect(block, 'o bloco do spawn_agent não apareceu').toBeDefined();
    expect(block!.kind === 'tool' && block!.status).not.toBe('err');
    const output = block!.kind === 'tool' ? (block!.output ?? '') : '';
    // Bloco de sucesso não guarda a saída (só o de erro a mostra); o texto que o modelo lê é
    // coberto pelo caso seguinte.
    expect(output).not.toMatch(/sem sucesso|concluíram/);

    release();
    c.dispose();
  });

  it('o turno seguinte lê que os filhos SEGUEM — não que falharam', async () => {
    const { model, release, seen } = scenario();
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
      subAgents: { enabled: true, maxConcurrency: 2, timeoutMs: 60_000 },
    });

    const turn = c.submit('dispara agentes');
    await waitFor(() => c.flowOverview().filter((n) => n.kind === 'subagent').length === 2);
    c.interrupt();
    await turn;
    await c.submit('o que vc fez');

    const context = seen.at(-1)!;
    expect(context).toContain('segundo plano');
    expect(context).not.toContain('sem sucesso');
    release();
    c.dispose();
  });
});
