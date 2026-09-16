// ASK DE SUB-AGENTE COM O PAI PARADO não pode deixar a sessão "ocupada" para sempre.
//
// Visto pelo dono em 16/09, no tmux: três sub-agentes em segundo plano (depois do ESC no pai),
// um deles pede aprovação, o dono responde e a sessão fica presa em `streaming` sem turno
// nenhum. O rodapé diz "esc interromper", cada ESC só repete "turno interrompido", a fila da
// TUI ("1 na fila · enviada ao terminar o turno") nunca drena e o Ctrl-C não sai (com fase
// ocupada ele só interrompe). Reproduzido de novo com "PING-9" parado na fila.
//
// A causa está em `onAskChange`: resolvido o ask, a fase ia para `streaming` sempre que não
// havia `!comando` em curso, supondo que quem perguntou foi o turno do pai. Com o pai parado,
// quem pergunta é um filho desacoplado, e não existe turno para "continuar".

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type AskRequest,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

function ports(): ToolPorts {
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
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return { matches: [], truncated: {} };
      },
    },
  };
}

const model: ModelCaller = {
  async call(): Promise<ModelCallResult> {
    return {
      request_id: 'r',
      content: 'ok.',
      finish_reason: 'stop',
      usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
    };
  },
};

/** O pedido que um sub-agente desacoplado faria (`run_command`, efeito exec). */
const childRequest = {
  call: { name: 'run_command', input: { command: 'ls -la' } },
  effect: { kind: 'exec', exact: 'ls -la' },
} as unknown as AskRequest;

function setup(): { controller: SessionController; resolver: TuiAskResolver } {
  const resolver = new TuiAskResolver();
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: ports(),
    askResolver: resolver,
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
  });
  return { controller, resolver };
}

describe('ask de sub-agente com o pai PARADO', () => {
  it('negar o ask devolve a sessão ao repouso (não fica presa em streaming)', async () => {
    const { controller, resolver } = setup();
    await controller.submit('turno do pai');
    expect(controller.current.phase).toBe('done');

    // Um filho em segundo plano pergunta — o pai não tem turno vivo.
    const reply = resolver.resolve(childRequest);
    expect(controller.current.phase).toBe('asking');

    controller.resolveAsk({ kind: 'deny', reason: 'negado pelo dono' } as never);
    await reply;

    expect(controller.current.phase).not.toBe('streaming');
    expect(['idle', 'done']).toContain(controller.current.phase);
    controller.dispose();
  });

  it('aprovar também devolve ao repouso — o turno do filho não é do pai', async () => {
    const { controller, resolver } = setup();
    await controller.submit('turno do pai');

    const reply = resolver.resolve(childRequest);
    controller.resolveAsk({ kind: 'approve-once' } as never);
    await reply;

    expect(['idle', 'done']).toContain(controller.current.phase);
    controller.dispose();
  });
});
