// FANOUT-17 (task #17) — fan-out de sub-agentes NÃO-BLOQUEANTE.
//
// HOJE o pai BLOQUEIA no `await port.spawn(...)` dentro de `executeToolCall`; enquanto
// isso, o `pollInjected` (topo da iteração do loop) NÃO roda ⇒ as injeções do dono
// ("btw") ficavam paradas até o fan-out INTEIRO terminar.
//
//   • Fatia 1 (SEM flag — estritamente melhor): durante o fan-out, um PUMP drena os
//     injects vivos p/ `pendingInjected` — a msg do dono para de esperar o fan-out
//     inteiro (entra no PRÓXIMO turno).
//   • Fatia 2 (atrás de `ALUY_FANOUT_DETACH_ON_INJECT`, default OFF): a injeção
//     DESACOPLA o fan-out vivo na hora (reusa `detachSpawn`), o pai responde JÁ com um
//     SEED VIVO dos filhos, e o resultado REAL chega mid-turn quando eles terminam.
//
// INVARIANTE E-A2 (não quebrar): `budget.reset()` é PULADO enquanto há desacoplados
// vivos — qualquer caminho novo mantém `detachedTrees` populado (sem runaway).
//
// FRUGAL: tudo com ModelCaller MOCK — nenhuma chamada de modelo real.

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

describe('FANOUT-17 (Fatia 1, SEM flag) — inject DURANTE fan-out drena sem esperar tudo', () => {
  it('a injeção do dono cai em pendingInjected enquanto o fan-out segue vivo (não espera o fan-out inteiro)', async () => {
    const { model, release } = buildScenario();
    const controller = buildController(model); // flag DEFAULT OFF

    const done = controller.submit('delegue a e b');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );

    // O dono INJETA enquanto os 2 filhos ainda esperam (fan-out vivo, pai bloqueado).
    const accepted = controller.injectInput('root', 'btw: e o status?');
    expect(accepted).toBe(true);

    // FATIA 1: o pump moveu o inject p/ pendingInjected SEM o fan-out ter terminado.
    await waitFor(() => {
      const pend = (controller as unknown as { pendingInjected: unknown[] }).pendingInjected;
      return pend.length > 0;
    });
    // Os filhos AINDA estão vivos (não esperamos eles p/ a msg drenar).
    expect(
      controller
        .flowOverview()
        .filter((n) => n.kind === 'subagent' && n.phase !== 'cancelled' && n.phase !== 'failed')
        .length,
    ).toBe(2);

    // Sem a flag, o fan-out NÃO foi desacoplado por inject: o pai segue bloqueado nele.
    // Libera os filhos ⇒ o fan-out termina normalmente e o turno do pai conclui.
    release('a');
    release('b');
    await done;
    expect(['idle', 'done']).toContain(controller.current.phase);
  });
});

describe('FANOUT-17 (Fatia 2, flag ON) — inject DESACOPLA o fan-out e o pai responde JÁ com seed-vivo', () => {
  it('desacopla, responde com estado vivo, resultado real chega depois, e o budget agregado NUNCA reseta', async () => {
    const { model, release, captured, parentCalls } = buildScenario();
    const controller = buildController(model, { ALUY_FANOUT_DETACH_ON_INJECT: '1' });

    const done = controller.submit('delegue a e b');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );

    const callsBefore = parentCalls();
    // Espiona o reset A PARTIR DE AGORA (o reset legítimo do 1º turno já passou).
    const resetSpy = vi.spyOn(
      (controller as unknown as { budget: { reset: () => void } }).budget,
      'reset',
    );

    captured.length = 0;
    // O dono INJETA durante o fan-out vivo ⇒ Fatia 2 DESACOPLA na hora.
    expect(controller.injectInput('root', 'na real, me dá um resumo agora')).toBe(true);

    // O turno do PAI completa (responde em PARALELO — NÃO espera os filhos).
    await done;
    expect(['idle', 'done']).toContain(controller.current.phase);

    // Desacoplou: o estado espelha os 2 filhos vivos em segundo plano (E-A2 — cercados).
    expect(controller.current.detachedSubagents).toBe(2);

    // O pai foi ao modelo DE NOVO (respondeu à injeção) e VIU o SEED VIVO dos filhos +
    // a fala do dono — ambos no canal `user` (DADO/instrução, NUNCA `system`).
    expect(parentCalls()).toBeGreaterThan(callsBefore);
    const userMsgs = captured.filter((m) => m.role === 'user');
    expect(userMsgs.some((m) => m.content.includes('estado VIVO dos sub-agentes'))).toBe(true);
    expect(userMsgs.some((m) => m.content.includes('na real, me dá um resumo agora'))).toBe(true);
    // O seed-vivo NUNCA entra como `system` (CLI-SEC-4).
    expect(
      captured.filter((m) => m.role === 'system').some((m) => m.content.includes('estado VIVO')),
    ).toBe(false);

    // E-A2 PRESERVADO: o `budget.reset()` NÃO foi chamado enquanto havia desacoplados.
    expect(resetSpy).not.toHaveBeenCalled();

    // Os filhos TERMINAM em segundo plano ⇒ o resultado REAL vira dado pendente.
    release('a');
    release('b');
    await waitFor(() => notesText(controller).includes('sub-agentes concluíram'));
    await waitFor(() => (controller.current.detachedSubagents ?? 0) === 0);

    // O resultado real é semeado (pendingSeed) — o próximo turno o vê como observação.
    captured.length = 0;
    await controller.submit('e aí?');
    const seeded = captured
      .filter((m) => m.role === 'user')
      .find((m) => m.content.includes('relatório-a.') && m.content.includes('relatório-b.'));
    expect(seeded).toBeDefined();
    expect(seeded!.content).toContain('sub-agente'); // rótulo de origem (CLI-SEC-9)
  });
});

describe('FANOUT-17 — DEFAULT OFF é bit-a-bit o comportamento atual (zero regressão)', () => {
  it('sem a flag, injetar durante o fan-out NÃO desacopla: o fan-out termina normal e devolve ao pai', async () => {
    const { model, release, captured, parentCalls } = buildScenario();
    const controller = buildController(model); // flag OFF

    const done = controller.submit('delegue a e b');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );

    const callsBefore = parentCalls();
    controller.injectInput('root', 'btw');
    // Sem flag: NÃO desacopla — nenhum filho vira "desacoplado" só por causa do inject.
    expect(controller.current.detachedSubagents).toBeUndefined();
    // O pai NÃO respondeu em paralelo (segue bloqueado no fan-out).
    expect(parentCalls()).toBe(callsBefore);

    // Termina o fan-out normalmente: os desfechos voltam AO PAI como observação do
    // spawn_agent (comportamento atual — NÃO via pendingSeed).
    release('a');
    release('b');
    await done;
    expect(['idle', 'done']).toContain(controller.current.phase);
    // O fan-out resolveu PARA O PAI (mesmo turno): o relatório dos filhos foi visto
    // pelo pai como observação dentro do MESMO turno, não como semente do próximo.
    const sawReports = captured
      .filter((m) => m.role === 'user')
      .some((m) => m.content.includes('relatório-a.') && m.content.includes('relatório-b.'));
    expect(sawReports).toBe(true);
  });
});
