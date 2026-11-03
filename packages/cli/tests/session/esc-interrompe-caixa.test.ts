// F10 — ESC numa caixa de PERMISSÃO ou PERGUNTA interrompe o turno: nenhuma chamada de modelo
// a mais, nada executado, nota curta, e o texto interno (feito p/ o modelo) NÃO vai ao transcript.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCallResult,
  type ModelCaller,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiQuestionResolver } from '../../src/ask/question-resolver.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const call = (name: string, input: Record<string, unknown>): string =>
  `<<<ALUY_TOOL_CALL\n${JSON.stringify({ name, input })}\nALUY_TOOL_CALL>>>`;

function setup(turns: readonly string[]) {
  const question = new TuiQuestionResolver();
  let calls = 0;
  let execs = 0;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      const content = turns[calls] ?? 'pronto.';
      calls += 1;
      return { request_id: 'r', content, finish_reason: 'stop' };
    },
  };
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
        execs += 1;
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return { matches: [], truncated: {} };
      },
    },
    question,
  } as unknown as ToolPorts;
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    questionResolver: question,
    meta: { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 },
    watchdogEnv: { ALUY_STUCK_OFF: '1' },
  });
  return { controller, calls: () => calls, execs: () => execs };
}

const allText = (c: SessionController): string => JSON.stringify(c.current.blocks);

async function waitPhase(c: SessionController, phase: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (c.current.phase !== phase) {
    if (Date.now() > end) throw new Error(`fase ${phase} não veio (${c.current.phase})`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('F10 — ESC na caixa interrompe o turno', () => {
  it('permissão: ESC para o loop, nada roda, sem nova chamada de modelo, com nota', async () => {
    const t = setup([call('run_command', { command: 'echo oi' }), 'continuei explicando']);
    const done = t.controller.submit('rode echo');
    await waitPhase(t.controller, 'asking');
    const antes = t.calls();
    t.controller.interruptFromPrompt();
    await done;
    expect(t.calls()).toBe(antes);
    expect(t.execs()).toBe(0);
    expect(allText(t.controller)).toContain('interrompido (esc) — nada foi executado');
    expect(allText(t.controller)).not.toContain('continuei explicando');
    t.controller.dispose();
  });

  it('pergunta: ESC para o loop e o texto interno não aparece no transcript', async () => {
    const t = setup([
      call('perguntar', {
        kind: 'single',
        question: 'Qual?',
        options: [{ label: 'A' }, { label: 'B' }],
      }),
      'novo turno',
    ]);
    const done = t.controller.submit('pergunte');
    await waitPhase(t.controller, 'questioning');
    const antes = t.calls();
    t.controller.interruptFromPrompt();
    await done;
    expect(t.calls()).toBe(antes);
    const txt = allText(t.controller);
    expect(txt).not.toContain('NÃO é um erro técnico');
    expect(txt).not.toContain('Não foi possível PERGUNTAR');
    expect(txt).not.toContain('novo turno');
    expect(txt).toContain('interrompido (esc)');
    t.controller.dispose();
  });

  it('n (negar) continua sendo deny-and-continue: o modelo segue', async () => {
    const t = setup([call('run_command', { command: 'echo oi' }), 'segui sem rodar']);
    const done = t.controller.submit('rode echo');
    await waitPhase(t.controller, 'asking');
    t.controller.resolveAsk({ kind: 'deny', reason: 'negado pelo usuário' });
    await done;
    expect(t.calls()).toBe(2);
    expect(t.execs()).toBe(0);
    t.controller.dispose();
  });
});
