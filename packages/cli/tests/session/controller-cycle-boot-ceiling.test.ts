// EST-1019 · ADR-0062 §Addendum 1 (APR-0086) · BUG-0023 — TETO do CICLO via OVERRIDE de
// boot no `controller.cycle(input, overrides)` + o desfecho `CycleStartResult` que o
// caminho HEADLESS usa p/ o exit code. INTEGRAÇÃO real (mesmo harness do controller-cycle):
//   • CA-1/CA-4: sem teto (goal puro, sem override) ⇒ started:false/refused:'no-ceiling',
//     ZERO ciclos (anti-runaway intacto). Antes virava NOTA + (no headless) exit 0.
//   • CA-2: override `--cycles N` INICIA e PARA em N ciclos, mesmo com goal puro.
//   • CA-2 (flag VENCE embutido): override de iterações sobrepõe o `--max-iter` embutido.
//   • CA-2 (não-confusão): override undefined (= sem --cycles/--cycle-for) ⇒ recusa.

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

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function fakePorts(): { ports: ToolPorts; ran: string[]; reads: string[] } {
  const ran: string[] = [];
  const reads: string[] = [];
  const fs: FileSystemPort = {
    async readFile(p: string) {
      reads.push(p);
      return 'conteúdo';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  };
  const shell: ShellPort = {
    async exec(c) {
      ran.push(c);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { ports: { fs, shell, search }, ran, reads };
}

const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

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

const approveAll: AskResolver = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

function cycleNote(controller: SessionController): readonly string[] | undefined {
  const blocks = controller.current.blocks;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === 'note' && b.title === '/cycle') return b.lines;
  }
  return undefined;
}

describe('EST-1019 · CA-1/CA-4 — sem teto ⇒ started:false/no-ceiling + ZERO ciclos', () => {
  it('goal puro sem override ⇒ refused:no-ceiling, nenhum ciclo roda', async () => {
    const { ports } = fakePorts();
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
      ports,
      askResolver: approveAll,
      meta,
    });
    // sem override (--cycles/--cycle-for ausentes) e sem teto embutido ⇒ NÃO inicia.
    const res = await controller.cycle('diga oi');
    expect(res.started).toBe(false);
    if (res.started === false) expect(res.refused).toBe('no-ceiling');
    expect(modelCalls).toBe(0);
  });

  it('override undefined (= --max-iterations sem --cycles/--cycle-for) ⇒ no-ceiling', async () => {
    const { ports } = fakePorts();
    const controller = new SessionController({
      model: scriptedModel(() => 'pronto.'),
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    const res = await controller.cycle('diga oi', undefined);
    expect(res.started).toBe(false);
    if (res.started === false) expect(res.refused).toBe('no-ceiling');
  });
});

describe('EST-1019 · CA-2 — override --cycles N INICIA e PARA em N (goal puro)', () => {
  it('--cycles 2 (override) roda 2 ciclos e para fechado, started:true', async () => {
    const { ports } = fakePorts();
    const model = scriptedModel((turn) =>
      turn === 0 ? toolCall('read_file', { path: 'x.log' }) : `relatório (${Math.random()}).`,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    // goal puro (sem teto embutido) + override de 2 iterações ⇒ inicia e para em 2.
    const res = await controller.cycle('diga oi', { maxIterations: 2 });
    expect(res.started).toBe(true);
    const note = cycleNote(controller);
    expect(note?.join(' ')).toMatch(/2 ciclo/);
  });
});

describe('EST-1019 · CA-2 — a FLAG DE BOOT vence o teto EMBUTIDO quando divergem', () => {
  it('embutido --max-iter 5 mas override maxIterations 2 ⇒ para em 2 (boot vence)', async () => {
    const { ports } = fakePorts();
    const model = scriptedModel((turn) =>
      turn === 0 ? toolCall('read_file', { path: 'x' }) : `segue (${Math.random()}).`,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    const res = await controller.cycle('--max-iter 5 "trabalhe"', { maxIterations: 2 });
    expect(res.started).toBe(true);
    const note = cycleNote(controller);
    // a flag de boot (2) venceu o embutido (5).
    expect(note?.join(' ')).toMatch(/2 ciclo/);
    expect(note?.join(' ')).not.toMatch(/5 ciclo/);
  });
});
