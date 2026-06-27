// HUNT-SUBAGENT (E-A2) — submit/reset NÃO pode zerar o SharedBudget agregado
// enquanto há sub-agentes DESACOPLADOS vivos.
//
// Cenário do furo: o pai delega 2 filhos; o usuário dá esc (EST-0982 — para SÓ o
// pai, os filhos SEGUEM vivos, DESACOPLADOS, compartilhando o MESMO `parentBudget`).
// Se o usuário (ou o auto-flow) submeter um turno NOVO AGORA, `runResolvedTurn`
// começa com `this.budget.reset()` — que ZERA os contadores agregados que os filhos
// desacoplados já gastaram. Resultado: pai-novo + filhos-vivos passam a somar contra
// um teto ZERADO ⇒ a soma estoura o teto da sessão (E-A2 furado, runaway órfão).
//
// O fix: `submit` RECUSA (igual ao gate de /cycle) enquanto `detachedTrees.size > 0`
// — o objetivo NÃO é enviado nem enfileirado em silêncio; o usuário espera os
// desacoplados (viram dado do próximo turno) ou usa PARAR-TUDO (F8).
//
// Por que o verde não pegava: o teste irmão (controller-esc-subagents) só submete o
// PRÓXIMO turno DEPOIS que os filhos TERMINARAM (waitFor done) — nunca COM filhos
// desacoplados ainda vivos.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  SPAWN_AGENT_TOOL_NAME,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
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

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
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

/** Conta quantas vezes o PAI (1ª sessão vista) chamou o modelo. */
function buildScenario(): {
  model: ModelCaller;
  release: (label: 'a' | 'b') => void;
  parentCalls: () => number;
} {
  const gates = new Map<string, { p: Promise<void>; release: () => void }>();
  for (const label of ['a', 'b']) {
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    gates.set(label, { p, release });
  }
  let parent: string | null = null;
  let parentCalls = 0;
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const sessionId = key.slice(0, key.lastIndexOf(':'));
      if (parent === null) parent = sessionId;
      const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 };
      if (sessionId === parent) {
        parentCalls += 1;
        // 1ª chamada do pai ⇒ delega 2 filhos; depois nunca mais (não deve haver
        // um 2º turno do pai enquanto os filhos estão desacoplados).
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
        return { request_id: 'r', content: 'entendi.', finish_reason: 'stop', usage };
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
  return { model, release: (l) => gates.get(l)!.release(), parentCalls: () => parentCalls };
}

describe('HUNT-SUBAGENT (E-A2) — submit é RECUSADO enquanto sub-agentes desacoplados vivem', () => {
  it('esc ⇒ filhos desacoplados vivos ⇒ submit novo é recusado (objetivo NÃO vai ao modelo; budget não é zerado)', async () => {
    const { model, release, parentCalls } = buildScenario();
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: approveAll,
      meta,
      subAgents: { enabled: true, maxConcurrency: 2, timeoutMs: 60_000 },
    });

    const done = controller.submit('delegue a e b');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );

    // esc — para SÓ o turno do pai; os filhos seguem vivos (DESACOPLADOS).
    controller.interrupt();
    await done;
    expect(controller.current.phase).toBe('idle');

    const callsAfterEsc = parentCalls();

    // AGORA — com os 2 filhos AINDA pendurados (desacoplados) — submete um turno NOVO.
    await controller.submit('e aí, outra tarefa');

    // RECUSA: o objetivo NÃO foi ao modelo (parentCalls inalterado ⇒ nenhum `budget.reset()`
    // disparou sob os filhos vivos) e uma NOTA honesta foi empurrada.
    expect(parentCalls()).toBe(callsAfterEsc);
    expect(notesText(controller)).toMatch(/desacoplados/i);
    // O bloco "você" do 2º objetivo NÃO foi empurrado (recusa ANTES do pushBlock do goal).
    const youBlocks = controller.current.blocks.filter(
      (b) => b.kind === 'you' && (b as { text?: string }).text === 'e aí, outra tarefa',
    );
    expect(youBlocks).toHaveLength(0);

    // Os filhos terminam (libera os gates) ⇒ vira dado pendente do próximo turno.
    release('a');
    release('b');
    await waitFor(() => notesText(controller).includes('sub-agentes concluíram'));

    // Agora SIM um submit novo é aceito (nenhum desacoplado vivo).
    await controller.submit('e aí?');
    expect(parentCalls()).toBeGreaterThan(callsAfterEsc);
  });
});
