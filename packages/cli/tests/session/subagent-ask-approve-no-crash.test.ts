// Crash inexplicado (UX review): o processo MORREU logo depois de aprovar (`a`) o bash de um
// sub-agente na caixa de permissão. Este teste reproduz o circuito (2 filhos, um precisa de
// bash, o dono aprova pela caixa real do TuiAskResolver) e afirma que NENHUM
// unhandledRejection/uncaughtException escapa e que os dois filhos terminam.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  SPAWN_AGENT_TOOL_NAME,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const call = (name: string, input: Record<string, unknown>): string =>
  `<<<ALUY_TOOL_CALL\n${JSON.stringify({ name, input })}\nALUY_TOOL_CALL>>>`;

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
      await new Promise((r) => setTimeout(r, 20));
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  },
  search: {
    async search() {
      return { matches: [], truncated: {} };
    },
  },
} as unknown as ToolPorts;

const stray: unknown[] = [];
const onRej = (e: unknown): void => {
  stray.push(e);
};

describe('aprovar o bash de um sub-agente na caixa', () => {
  beforeEach(() => {
    stray.length = 0;
    process.on('unhandledRejection', onRej);
    process.on('uncaughtException', onRej);
  });
  afterEach(() => {
    process.off('unhandledRejection', onRej);
    process.off('uncaughtException', onRej);
  });

  it('2 filhos, um pede run_command, o dono aprova: nada escapa e ambos concluem', async () => {
    let parentTurn = 0;
    const childTurns = new Map<string, number>();
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const text = args.messages.map((m) => m.content).join('\n');
        const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 };
        const label = text.includes('goal-bash')
          ? 'bash'
          : text.includes('goal-leitor')
            ? 'leitor'
            : '';
        if (label === '') {
          const content =
            parentTurn === 0
              ? call(SPAWN_AGENT_TOOL_NAME, {
                  agents: [
                    { label: 'bash', goal: 'goal-bash' },
                    { label: 'leitor', goal: 'goal-leitor' },
                  ],
                })
              : 'tudo certo.';
          parentTurn += 1;
          return { request_id: 'r', content, finish_reason: 'stop', usage };
        }
        const n = childTurns.get(label) ?? 0;
        childTurns.set(label, n + 1);
        const content =
          label === 'bash' && n === 0
            ? call('run_command', { command: 'echo oi' })
            : `relatorio-${label}.`;
        return { request_id: 'r', content, finish_reason: 'stop', usage };
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true, maxConcurrency: 4, timeoutMs: 60_000 },
      watchdogEnv: { ALUY_STUCK_OFF: '1' },
    } as never);

    const done = controller.submit('delegue');
    const end = Date.now() + 8000;
    let approved = false;
    while (Date.now() < end && !approved) {
      if (controller.current.pendingAsk) {
        controller.resolveAsk({ kind: 'approve-once' });
        approved = true;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(approved).toBe(true);
    await done;
    await new Promise((r) => setTimeout(r, 400));
    expect(stray).toEqual([]);
    const txt = JSON.stringify(controller.current.blocks);
    expect(txt).not.toContain('interrompido');
    controller.dispose();
  });
});
