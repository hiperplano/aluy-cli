// ADR aluy-cli 0001 — `spawn_agent` com `wait:false` (despacha e segue), no CONTROLLER.
//
// O pai pede para NÃO esperar: a chamada retorna na hora com o mesmo desfecho `detached`
// que o Ctrl+B produz, os filhos seguem vivos e cercados (E-A2: o budget agregado não
// reseta enquanto há desacoplados), e o resultado real chega como dado quando concluem.
// Nada novo de máquina — é o quarto motivo do desacople, decidido na origem.
//
// Harness = o MESMO do `controller-fanout-inject.test.ts`, com `wait:false` no tool-call.

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
              wait: false,
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

describe('ADR 0001 · spawn_agent wait:false', () => {
  it('a chamada retorna na hora; o turno do pai conclui SEM esperar os filhos', async () => {
    const { model, release, captured } = buildScenario();
    const controller = buildController(model);
    captured.length = 0;

    const done = controller.submit('delegue a e b sem esperar');
    // Nenhum gate foi liberado: se o turno concluir, foi sem esperar os filhos.
    await done;
    expect(['idle', 'done']).toContain(controller.current.phase);
    expect(controller.current.detachedSubagents).toBe(2);

    // Os filhos seguem VIVOS (despachar não é matar).
    expect(
      controller
        .flowOverview()
        .filter((n) => n.kind === 'subagent' && n.phase !== 'cancelled' && n.phase !== 'failed')
        .length,
    ).toBe(2);

    // O pai leu o motivo certo e a instrução de não esperar / não re-disparar.
    const visto = captured.map((m) => m.content).join(' | ');
    expect(visto).toContain('DESPACHADO em segundo plano (wait:false)');
    expect(visto).toContain('NÃO o dispare de novo');

    // O dono vê o que aconteceu.
    expect(notesText(controller)).toContain('despachados');

    // E-A2 é sobre o PRÓXIMO turno: com desacoplados vivos, o `budget.reset()` do início de
    // turno tem de ser PULADO. Espiona depois do reset legítimo do 1º turno e abre outro.
    const resetSpy = vi.spyOn(
      (controller as unknown as { budget: { reset: () => void } }).budget,
      'reset',
    );
    await controller.submit('e aí?');
    expect(resetSpy).not.toHaveBeenCalled();

    // Os filhos terminam ⇒ o resultado REAL chega como dado.
    release('a');
    release('b');
    await waitFor(() => notesText(controller).includes('sub-agentes concluíram'));
    await waitFor(() => (controller.current.detachedSubagents ?? 0) === 0);
  });
});
