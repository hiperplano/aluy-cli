// EST-0981 · ADR-0062 (APR-0067) · CLI-SEC-14 — `/cycle` em modo NÃO-TTY (linear).
// Fix de fiação: sem `runCycleLinear` + o roteamento não-TTY, `aluy "/cycle rode para
// sempre"` piped virava um OBJETIVO p/ o modelo (a LLM criava um forever-script) em vez
// de RECUSAR por falta de teto — o MESMO bug que o `/memory` teve.
//
// Bateria do gate FORTE (anti-runaway) no caminho LINEAR — as paradas DURAS valem
// idênticas ao TTY (controller.cycle → CycleEngine):
//   • "sem teto ⇒ NÃO inicia": ZERO chamadas de modelo (broker), nota honesta no stdout.
//   • `--max-iter N`: roda N ciclos e PARA no teto (mostra os ciclos + a parada).
//   • NÃO trata linhas que não são `/cycle` (devolve false ⇒ cairia no runLinear/objetivo).
//   • `/cycle` SEM tarefa ⇒ usa + lembrete anti-runaway, ZERO modelo (não cai no agente).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type AskResolver,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';
import { runCycleLinear, type LinearOut } from '../../src/session/linear.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function makeOut(): { out: LinearOut; text: () => string } {
  let buf = '';
  return { out: { write: (c) => (buf += c) }, text: () => buf };
}

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return 'conteúdo';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

// Em não-TTY o AskResolver NEGA por inação (fail-safe). Espelha esse comportamento.
const denyAll: AskResolver = {
  async resolve() {
    return { kind: 'deny' as const };
  },
};

/** Modelo roteirizado pelo TURNO DENTRO DO CICLO (sufixo `:N` da idempotency-key). */
function scriptedModel(turnScript: (turn: number) => string): ModelCaller {
  return {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const turn = Number(key.slice(key.lastIndexOf(':') + 1));
      return {
        request_id: 'r',
        content: turnScript(Number.isFinite(turn) ? turn : 0),
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 40, tokens_out: 60 },
      };
    },
  };
}

describe('EST-0981 — runCycleLinear (não-TTY): roteia /cycle, não cai no agente', () => {
  it('NÃO trata linhas que não são /cycle (devolve false ⇒ vira objetivo)', async () => {
    const { out } = makeOut();
    const controller = new SessionController({
      model: scriptedModel(() => 'pronto.'),
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: denyAll,
      meta,
    });
    expect(await runCycleLinear(controller, 'explique o repo', out)).toBe(false);
    expect(await runCycleLinear(controller, '/cyclex 5m "x"', out)).toBe(false);
    expect(await runCycleLinear(controller, '/model', out)).toBe(false);
  });

  it('GS-L2/RES-L-1 — "sem teto ⇒ NÃO inicia": ZERO broker + nota de recusa no stdout', async () => {
    const { out, text } = makeOut();
    let modelCalls = 0;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        modelCalls++;
        return scriptedModel(() => 'pronto.').call(args);
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: denyAll,
      meta,
    });
    // a repro real do bug: "rode para sempre" SEM teto ⇒ recusa, nunca o forever-script.
    const handled = await runCycleLinear(controller, '/cycle rode para sempre', out);
    expect(handled).toBe(true); // TRATOU — não caiu no runLinear/objetivo
    expect(modelCalls).toBe(0); // NENHUM ciclo rodou (zero broker)
    expect(text()).toMatch(/sem teto|NÃO inicia/i); // nota de recusa visível
    // NÃO menciona script algum (não interpretou como objetivo).
    expect(text()).not.toMatch(/\.sh\b|forever|script/i);
  });

  it('GS-L2 — `--max-iter 2 "responda OK"`: roda 2 ciclos e PARA no teto (mostra ambos)', async () => {
    const { out, text } = makeOut();
    let modelCalls = 0;
    // cada ciclo: turn0 = lê um arquivo (≥1 tool-call ⇒ progresso), turn1 = responde.
    const model = scriptedModel((turn) => {
      modelCalls++;
      return turn === 0 ? toolCall('read_file', { path: 'x.log' }) : `OK (${Math.random()}).`;
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: denyAll,
      meta,
    });
    const handled = await runCycleLinear(controller, '/cycle --max-iter 2 responda OK', out);
    expect(handled).toBe(true);
    expect(modelCalls).toBeGreaterThan(0); // rodou de fato
    // a nota de parada do /cycle sai no stdout linear, rotulada `[/cycle]`.
    expect(text()).toContain('[/cycle]');
    expect(text()).toMatch(/2 ciclo/); // exatamente 2 ciclos
    expect(text()).toMatch(/iterações|fechado/i); // parou no teto
    // o eco do comando saiu (transparência do que rodou).
    expect(text()).toContain('/cycle --max-iter 2 responda OK');
  });

  it('GS-L3 — `--unsafe` NÃO relaxa o teto: ainda para em --max-iter', async () => {
    const { out, text } = makeOut();
    const model = scriptedModel((turn) =>
      turn === 0 ? toolCall('run_command', { command: 'echo oi' }) : `feito (${Math.random()}).`,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }), // --unsafe
      ports: fakePorts(),
      askResolver: denyAll,
      meta,
    });
    expect(await runCycleLinear(controller, '/cycle --max-iter 2 "rode sem parar"', out)).toBe(
      true,
    );
    expect(text()).toMatch(/2 ciclo/);
    expect(text()).toMatch(/iterações|fechado/i);
  });

  it('`/cycle` SEM tarefa ⇒ usa + lembrete anti-runaway, ZERO broker (não cai no agente)', async () => {
    const { out, text } = makeOut();
    let modelCalls = 0;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        modelCalls++;
        return scriptedModel(() => 'x').call(args);
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: denyAll,
      meta,
    });
    const handled = await runCycleLinear(controller, '/cycle', out);
    expect(handled).toBe(true);
    expect(modelCalls).toBe(0);
    expect(text()).toMatch(/uso:/i);
    expect(text()).toMatch(/anti-runaway|NÃO inicia/i);
  });
});
