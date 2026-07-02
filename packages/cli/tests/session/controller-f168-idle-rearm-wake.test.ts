// F168 — o "te aviso quando terminar" que NUNCA chegava. Um evento de conclusão
// (fan-out/monitor/conector) que aterrissa com o pai FORA de idle/done era
// descartado pelo guard do `maybeWakeForMonitor` — e NINGUÉM re-tentava quando a
// fase enfim assentava: o resultado ficava preso na fila até o usuário cutucar.
// Fix: `setPhase(idle|done)` re-arma o wake (queueMicrotask) — o turno de
// incorporação nasce sozinho. FRUGAL: ModelCaller mock, sem rede.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return 'x';
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

const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};
const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('F168 — assentar em idle/done RE-ARMA o wake do monitor (aviso chega sozinho)', () => {
  it('evento que chega DURANTE o turno (sem nova iteração) é incorporado num turno-wake automático', async () => {
    // Gate: segura a 1ª chamada do modelo p/ injetarmos o evento COM O TURNO VIVO
    // (fase busy ⇒ o guard do wake descarta a tentativa do enqueue). O modelo
    // responde SEM tool-call ⇒ o loop NÃO faz outra iteração (o drain mid-turn não
    // roda de novo) ⇒ só o re-arme do setPhase pode salvar o evento.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[][] = [];
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        calls.push(args.messages.map((m) => `${m.role}:${m.content}`));
        if (calls.length === 1) await gate;
        return {
          request_id: `r${calls.length}`,
          content: 'ok.',
          finish_reason: 'stop',
          usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
        };
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'normal' }),
      ports: fakePorts(),
      askResolver: approveAll,
      meta,
    });

    const turn = controller.submit('oi');
    await waitFor(() => calls.length === 1); // turno VIVO (modelo pendurado no gate)

    // O "terminei!" de um trabalho de background chega AGORA (pai fora de idle).
    controller.ingestExternalData('background', 'RESULTADO-POUSOU-F168');

    release(); // o modelo responde e o turno ASSENTA em done…
    await turn;

    // …e o re-arme do setPhase dispara o turno-wake SOZINHO: o modelo é chamado de
    // novo com o evento como observação (sem o usuário cutucar).
    await waitFor(() => calls.length >= 2);
    const wakeTurn = calls[calls.length - 1]!.join('\n');
    expect(wakeTurn).toContain('RESULTADO-POUSOU-F168');
    // E a UI ganhou a nota do monitor (o aviso VISÍVEL).
    const notes = controller.current.blocks.filter((b) => b.kind === 'note');
    expect(JSON.stringify(notes)).toContain('disparou');
  });

  it('fila vazia: assentar em idle/done NÃO dispara turno espúrio', async () => {
    const calls: number[] = [];
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        calls.push(1);
        return {
          request_id: 'r',
          content: 'ok.',
          finish_reason: 'stop',
          usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
        };
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'normal' }),
      ports: fakePorts(),
      askResolver: approveAll,
      meta,
    });
    await controller.submit('oi');
    await new Promise((r) => setTimeout(r, 50)); // dá tempo a qualquer wake espúrio
    expect(calls.length).toBe(1); // só o turno do usuário — nada nasceu do nada.
  });
});
