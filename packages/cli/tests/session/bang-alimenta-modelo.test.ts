// ADR 0003 (emenda) — a saída do `!comando` ENTRA na conversa do modelo (observação,
// CLI-SEC-4); `!!` fica só na tela; vale mid-turn (fila de dado do loop) e no resume.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ChatMessage,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { routeInput } from '../../src/slash/commands.js';
import { blocksToHistory } from '../../src/io/index.js';

const ZIMBRO = 'PALAVRA-ZIMBRO-42';
const OPEN = '<<<ALUY_TOOL_CALL';
const CLOSE = 'ALUY_TOOL_CALL>>>';

function ports(stdout: (cmd: string) => string): ToolPorts {
  return {
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
        return { stdout: stdout(command), stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return { matches: [], truncated: {} };
      },
    },
  } as unknown as ToolPorts;
}

function build(model: ModelCaller): SessionController {
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine({
      policy: { rules: [{ tool: 'run_command', decision: 'allow' }] },
    }),
    ports: ports((c) => (c.startsWith('echo ') ? `${c.slice(5)}\n` : 'ok')),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    watchdogEnv: { ALUY_STUCK_OFF: '1' },
    flush: { intervalMs: 0 },
  });
}

function recorder(answer = 'ok.'): { model: ModelCaller; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  return {
    seen,
    model: {
      async call(args: { messages: readonly ChatMessage[] }): Promise<ModelCallResult> {
        seen.push([...args.messages]);
        return { request_id: 'r', content: answer, finish_reason: 'stop' };
      },
    },
  };
}
const flat = (m: ChatMessage[]): string => JSON.stringify(m);

describe('`!` alimenta o modelo', () => {
  it('o próximo turno enxerga o comando e a saída do `!` (PARADO)', async () => {
    const { model, seen } = recorder();
    const c = build(model);
    await c.runBang(`echo ${ZIMBRO}`);
    expect(seen).toHaveLength(0); // `!` NÃO acorda o modelo sozinho
    await c.submit('qual palavra saiu?');
    expect(flat(seen[0]!)).toContain(ZIMBRO);
    expect(flat(seen[0]!)).toContain('echo PALAVRA-ZIMBRO-42');
    expect(flat(seen[0]!)).toContain('DADO_NAO_CONFIAVEL');
  });

  it('`!!` roda, mostra e NÃO entrega ao modelo (bloco marcado só-local)', async () => {
    const { model, seen } = recorder();
    const c = build(model);
    await c.runBang(`echo ${ZIMBRO}`, undefined, { localOnly: true });
    const bang = c.current.blocks.find((b) => b.kind === 'bang');
    expect(bang?.kind === 'bang' && bang.localOnly).toBe(true);
    expect(bang?.kind === 'bang' && bang.output).toContain(ZIMBRO); // na tela
    await c.submit('qual palavra saiu?');
    expect(flat(seen[0]!)).not.toContain(ZIMBRO);
  });

  it('MID-TURN: o `!` rodado com o turno vivo é drenado pelo loop no passo seguinte', async () => {
    const seen: ChatMessage[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const model: ModelCaller = {
      async call(args: { messages: readonly ChatMessage[] }): Promise<ModelCallResult> {
        seen.push([...args.messages]);
        n += 1;
        if (n === 1) {
          await gate;
          return {
            request_id: 'r',
            content: `${OPEN}\n${JSON.stringify({ name: 'run_command', input: { command: 'echo passo' } })}\n${CLOSE}`,
            finish_reason: 'stop',
          };
        }
        return { request_id: 'r', content: 'fim.', finish_reason: 'stop' };
      },
    };
    const c = build(model);
    const turno = c.submit('faça algo');
    const fim = Date.now() + 2000;
    while (seen.length === 0 && Date.now() < fim) await new Promise((r) => setTimeout(r, 5));
    expect(c.turnoVivo).toBe(true);
    await c.runBang(`echo ${ZIMBRO}`);
    release();
    await turno;
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(flat(seen[0]!)).not.toContain(ZIMBRO);
    expect(flat(seen[seen.length - 1]!)).toContain(ZIMBRO);
  });

  it('RESUME: o bloco bang volta como observação; o `!!` (localOnly) fica de fora', () => {
    const hist = blocksToHistory([
      { kind: 'bang', command: 'echo visto', status: 'ok', output: 'visto' },
      { kind: 'bang', command: 'echo oculto', status: 'ok', output: 'oculto', localOnly: true },
    ]);
    const txt = JSON.stringify(hist);
    expect(txt).toContain('visto');
    expect(txt).not.toContain('oculto');
  });
});

describe('roteamento `!` / `!!`', () => {
  it('`!!cmd` ⇒ bang localOnly; `!cmd` ⇒ bang comum; `!!` vazio ⇒ goal vazio', () => {
    expect(routeInput('!!ls -la')).toEqual({ kind: 'bang', command: 'ls -la', localOnly: true });
    expect(routeInput('!ls')).toEqual({ kind: 'bang', command: 'ls' });
    expect(routeInput('!!')).toEqual({ kind: 'goal', text: '' });
  });
});
