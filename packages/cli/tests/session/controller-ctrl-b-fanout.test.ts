// F-BG — o Ctrl+B também SOLTA um fan-out de sub-agentes vivo.
//
// Pedido do dono (21/09/2026): "quando ele dispara agentes, esses agentes ficam em estado
// processando e travam o turno — o correto não seria eles ficarem sendo monitorados e
// deixar o turno livre?". O pai fica pendurado no `await port.spawn` até o ÚLTIMO filho
// terminar. A máquina de desacoplar JÁ existia (a do ESC e a da injeção, FANOUT-17); o que
// faltava era a tecla: o Ctrl+B passa a soltar O QUE ESTIVER PRENDENDO o turno — a tool de
// shell ou o fan-out.
//
// O que estes testes guardam, além do "soltou":
//   · os filhos SEGUEM VIVOS (soltar não é matar — quem mata é o ESC×2/F8/agents_stop);
//   · o pai LÊ que foi o dono quem soltou, e é instruído a NÃO esperar nem re-disparar —
//     sem isso ele dispara o mesmo lote de novo, ou fica "aguardando" filhos já soltos;
//   · E-A2: o budget agregado NÃO reseta enquanto há desacoplados vivos (sem runaway).
//
// Harness = o MESMO do `controller-fanout-inject.test.ts` (ModelCaller mock, sem rede).

import { describe, expect, it, vi } from 'vitest';
import {
  PolicyPermissionEngine,
  SPAWN_AGENT_TOOL_NAME,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import type { NoteBlock } from '../../src/session/model.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

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

function notesText(controller: SessionController): string {
  return controller.current.blocks
    .filter((b): b is NoteBlock => b.kind === 'note')
    .map((n) => `${n.title}: ${n.lines.join(' ')}`)
    .join('\n');
}

/**
 * Harness: o PAI delega 2 filhos (`a`, `b`) no 1º turno e PENDURA no `await
 * port.spawn` enquanto os filhos esperam os gates. `captured` registra TODAS as
 * mensagens que o pai viu (p/ provar o seed-vivo / o resultado real). O pai, em
 * qualquer turno após o 1º, só ecoa "ok" (não delega de novo).
 */
function buildScenario(): {
  model: ModelCaller;
  release: (label: 'a' | 'b') => void;
  captured: { role: string; content: string }[];
  parentCalls: () => number;
} {
  const gates = new Map<string, { p: Promise<void>; release: () => void }>();
  for (const label of ['a', 'b']) {
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    gates.set(label, { p, release });
  }
  const captured: { role: string; content: string }[] = [];
  let parent: string | null = null;
  let parentCalls = 0;
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const sessionId = key.slice(0, key.lastIndexOf(':'));
      if (parent === null) parent = sessionId;
      for (const m of args.messages) captured.push({ role: m.role, content: m.content });
      const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 };
      if (sessionId === parent) {
        parentCalls += 1;
        if (parentCalls === 1) {
          return {
            request_id: 'r',
            content: toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [
                { label: 'a', goal: 'g-a' },
                { label: 'b', goal: 'g-b' },
              ],
            }),
            finish_reason: 'stop',
            usage,
          };
        }
        return { request_id: 'r', content: 'ok.', finish_reason: 'stop', usage };
      }
      // FILHO: pendura no gate próprio OU no abort.
      const text = args.messages.map((m) => m.content).join('\n');
      const label = text.includes('g-a') ? 'a' : 'b';
      await Promise.race([
        gates.get(label)!.p,
        new Promise<void>((res) => {
          if (args.signal?.aborted) return res();
          args.signal?.addEventListener('abort', () => res(), { once: true });
        }),
      ]);
      if (args.signal?.aborted) throw new Error('chamada cancelada (abort)');
      return { request_id: 'r', content: `relatório-${label}.`, finish_reason: 'stop', usage };
    },
  };
  return {
    model,
    release: (l) => gates.get(l)!.release(),
    captured,
    parentCalls: () => parentCalls,
  };
}

function buildController(
  model: ModelCaller,
  env?: Record<string, string | undefined>,
): SessionController {
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: approveAll,
    meta,
    subAgents: {
      enabled: true,
      maxConcurrency: 2,
      timeoutMs: 60_000,
      ...(env ? { env } : {}),
    },
  });
}

describe('F-BG — Ctrl+B com fan-out VIVO', () => {
  it('solta: o turno conclui SEM esperar os filhos, que seguem vivos e cercados', async () => {
    const { model, release, captured } = buildScenario();
    const controller = buildController(model);

    const done = controller.submit('delegue a e b');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );
    const resetSpy = vi.spyOn(
      (controller as unknown as { budget: { reset: () => void } }).budget,
      'reset',
    );
    captured.length = 0;

    // O Ctrl+B da TUI chama exatamente isto.
    expect(controller.soltarParaSegundoPlano()).toBe(true);

    // O turno do PAI conclui — e nenhum gate foi liberado: ele NÃO esperou os filhos.
    await done;
    expect(['idle', 'done']).toContain(controller.current.phase);
    expect(controller.current.detachedSubagents).toBe(2);

    // Soltar NÃO é matar: os dois seguem vivos na árvore.
    expect(
      controller
        .flowOverview()
        .filter((n) => n.kind === 'subagent' && n.phase !== 'cancelled' && n.phase !== 'failed')
        .length,
    ).toBe(2);

    // O dono VÊ o que aconteceu, com os rótulos.
    const notas = notesText(controller);
    expect(notas).toContain('segundo plano');
    expect(notas).toContain('a, b');

    // O PAI leu o motivo certo e a instrução de não esperar / não re-disparar.
    const visto = captured.map((m) => m.content).join(' | ');
    expect(visto).toContain('SOLTOU o fan-out (Ctrl+B)');
    expect(visto).toContain('NÃO o dispare de novo');
    // …e viu o estado VIVO dos filhos como DADO, nunca como `system` (CLI-SEC-4).
    expect(visto).toContain('estado VIVO dos sub-agentes');
    expect(
      captured.filter((m) => m.role === 'system').some((m) => m.content.includes('estado VIVO')),
    ).toBe(false);

    // E-A2: com desacoplados vivos, o budget agregado NÃO reseta.
    expect(resetSpy).not.toHaveBeenCalled();

    // Os filhos terminam em segundo plano ⇒ o resultado REAL chega como dado.
    release('a');
    release('b');
    await waitFor(() => /termin(ou|aram)/.test(notesText(controller)));
    await waitFor(() => (controller.current.detachedSubagents ?? 0) === 0);
  });

  it('é IDEMPOTENTE: o segundo Ctrl+B não solta nada de novo', async () => {
    const { model, release } = buildScenario();
    const controller = buildController(model);
    const done = controller.submit('delegue a e b');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );

    expect(controller.soltarParaSegundoPlano()).toBe(true);
    expect(controller.soltarParaSegundoPlano()).toBe(false);
    await done;
    // Contou os filhos UMA vez (o `detachSpawn` em dobro inflaria o aviso persistente).
    expect(controller.current.detachedSubagents).toBe(2);

    release('a');
    release('b');
    await waitFor(() => (controller.current.detachedSubagents ?? 0) === 0);
  });

  it('sem fan-out e sem tool armada ⇒ false (a tecla não é consumida à toa)', () => {
    const { model } = buildScenario();
    expect(buildController(model).soltarParaSegundoPlano()).toBe(false);
  });
});
