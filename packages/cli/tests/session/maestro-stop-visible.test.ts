// QUANDO O MAESTRO ENCERRA O TURNO, O DONO PRECISA VER.
//
// Visto em 16/09 (instrumentando com provider falso): o turno do "ola" terminou com
// `final` = "Turno encerrado pelo Maestro (regência de fluxo)…" e a tela não mostrou nada — a
// fala "você: ola" ficou sem resposta nenhuma. A resposta de uma parada do supervisor é
// SINTÉTICA (não passa pelo stream), então não existe caixa do aluy para ela.
import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  PollSignalBus,
  createDecision,
  createSignal,
  type MaestroPort,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import type { NoteBlock } from '../../src/session/model.js';

const ports = (): ToolPorts => ({
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
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
  search: {
    async search() {
      return { matches: [], truncated: {} };
    },
  },
});

function controller(maestro: MaestroPort, model: ModelCaller): SessionController {
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: ports(),
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    maestro,
  });
}

const notes = (c: SessionController): NoteBlock[] =>
  c.current.blocks.filter((b): b is NoteBlock => b.kind === 'note');

describe('parada do Maestro visível', () => {
  it('o turno encerrado pelo supervisor deixa uma nota na conversa', async () => {
    let calls = 0;
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        calls += 1;
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
      },
    };
    const maestro: MaestroPort = {
      bus: new PollSignalBus(),
      rege: async () =>
        createDecision(
          'parar',
          [createSignal('human-cancel', 'critical', Date.now(), { reason: 'teste' })],
          'parada de teste',
          Date.now(),
        ),
    };
    const c = controller(maestro, model);
    await c.submit('ola');
    expect(calls).toBe(0);
    const n = notes(c);
    expect(n.length, 'o turno terminou sem nenhum sinal na tela').toBeGreaterThan(0);
    expect(n.map((x) => `${x.title} ${x.lines.join(' ')}`).join('\n')).toMatch(
      /Maestro|supervisor/i,
    );
    c.dispose();
  });

  it('um turno normal NÃO ganha essa nota', async () => {
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        return { request_id: 'r', content: 'resposta', finish_reason: 'stop' };
      },
    };
    const maestro: MaestroPort = {
      bus: new PollSignalBus(),
      rege: async () =>
        createDecision(
          'continuar',
          [createSignal('self-check', 'info', Date.now(), {})],
          'ok',
          Date.now(),
        ),
    };
    const c = controller(maestro, model);
    await c.submit('ola');
    expect(notes(c).some((x) => /Maestro|supervisor/i.test(x.title))).toBe(false);
    c.dispose();
  });
});
