// SEGURANÇA (F15 · ADR 0003) — o `!comando` do USUÁRIO é ação explícita e roda sem caixa de
// permissão, mas isso NUNCA pode vazar para o `run_command` iniciado pelo MODELO: este segue
// 100% pela catraca (`ask` ⇒ caixa, nada roda sem o dono aprovar). Também: `deny` (Plan)
// segue bloqueando o `!comando`. Um teste aqui precisa FALHAR se o atalho do bang virar
// bypass do modelo (ex.: o controller passar a tratar tudo como `userExplicit`).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const OPEN = '<<<ALUY_TOOL_CALL';
const CLOSE = 'ALUY_TOOL_CALL>>>';
const runCmd = (command: string): string =>
  `${OPEN}\n${JSON.stringify({ name: 'run_command', input: { command } })}\n${CLOSE}`;

function build(mode: 'normal' | 'plan', respostas: readonly string[]) {
  const ran: string[] = [];
  const ports = {
    fs: {
      async readFile() {
        return '';
      },
      async writeFile() {},
      async exists() {
        return false;
      },
    },
    shell: {
      async exec(command: string) {
        ran.push(command);
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return { matches: [], truncated: {} };
      },
    },
  } as unknown as ToolPorts;
  let i = 0;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      const content = respostas[i] ?? 'pronto.';
      i += 1;
      return { request_id: 'r', content, finish_reason: 'stop' };
    },
  };
  const resolver = new TuiAskResolver();
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode }),
    ports,
    askResolver: resolver,
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    watchdogEnv: { ALUY_STUCK_OFF: '1' },
    flush: { intervalMs: 0 },
  });
  return { controller, ran };
}

async function esperarAsk(c: SessionController): Promise<void> {
  const fim = Date.now() + 2000;
  while (c.current.phase !== 'asking') {
    if (Date.now() > fim) throw new Error('a caixa de permissão não abriu');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('SEGURANÇA · atalho do `!comando` não vaza para o run_command do modelo', () => {
  it('o MESMO comando perigoso: pelo `!` roda direto; pelo modelo ABRE a caixa e só roda se aprovado', async () => {
    const { controller, ran } = build('normal', [runCmd('rm -rf alvo-do-modelo'), 'fim.']);

    // 1) do usuário: direto, sem caixa.
    await controller.runBang('rm -rf alvo-do-usuario');
    expect(controller.current.pendingAsk).toBeUndefined();
    expect(ran).toEqual(['rm -rf alvo-do-usuario']);

    // 2) do modelo, na MESMA sessão logo depois: a catraca pergunta e NADA roda ainda.
    const turno = controller.submit('limpe');
    await esperarAsk(controller);
    expect(controller.current.pendingAsk?.request.effect.exact).toBe('$ rm -rf alvo-do-modelo');
    expect(controller.current.pendingAsk?.request.alwaysAsk).toBe(true);
    expect(ran).toEqual(['rm -rf alvo-do-usuario']); // o do modelo NÃO executou

    // 3) o dono nega ⇒ o comando do modelo nunca executa.
    controller.resolveAsk({ kind: 'deny', reason: 'não' });
    await turno;
    expect(ran).toEqual(['rm -rf alvo-do-usuario']);
  });

  it('o modelo roda o comando somente DEPOIS de o dono aprovar na caixa', async () => {
    const { controller, ran } = build('normal', [runCmd('echo aprovado'), 'fim.']);
    const turno = controller.submit('rode');
    await esperarAsk(controller);
    expect(ran).toEqual([]);
    controller.resolveAsk({ kind: 'approve-once' });
    await turno;
    expect(ran).toEqual(['echo aprovado']);
  });

  it('`deny` segue bloqueando o `!comando` (Plan): atalho de ação explícita só dispensa o ASK', async () => {
    const { controller, ran } = build('plan', []);
    await controller.runBang('rm -rf build');
    expect(ran).toEqual([]);
    const bang = controller.current.blocks.find((b) => b.kind === 'bang');
    expect(bang?.kind === 'bang' && bang.status).toBe('blocked');
  });
});
