// HUNT-SUBAGENT (classe EST-1011 — recurso sem teto) — o Map `roomPolicies` do
// controller crescia SEM LIMITE numa sessão longa de fan-outs com `room:true`.
//
// O `roomStore` evicta salas mortas (TTL/revogadas) no `create()`, mas o
// `roomPolicies` (Map do controller, paralelo ao store) NUNCA era podado: cada lote
// `room:true` deixava uma entrada órfã pra SEMPRE. Em sessão longa = vazamento de
// memória monotônico.
//
// O fix: `openBatchRoom` chama `pruneDeadRoomPolicies()` antes de criar a sala nova,
// removendo as policies cujo código já não existe no store (a sala expirou e foi
// evictada). O Map fica cercado pelo MESMO teto/TTL do store.
//
// Prova determinística: relógio INJETADO; 1º lote cria a sala A; avança o relógio
// além do TTL (1h) ⇒ A expira; 2º lote cria B e PODA A. Sem o fix, o Map teria 2
// entradas (A órfã + B); com o fix, só B.

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
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

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

/**
 * Pai delega 1 filho com `room:true` no 1º turno de cada submit, depois finaliza.
 * O filho responde imediatamente (sem pendurar) — o foco é o ciclo de vida da sala.
 */
function roomScenarioModel(): ModelCaller {
  let parent: string | null = null;
  const seen = new Map<string, number>();
  return {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const sessionId = key.slice(0, key.lastIndexOf(':'));
      if (parent === null) parent = sessionId;
      const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 };
      if (sessionId === parent) {
        const turn = seen.get(sessionId) ?? 0;
        seen.set(sessionId, turn + 1);
        // 1ª chamada de CADA submit do pai delega; a seguinte finaliza.
        const isFirstOfSubmit = turn % 2 === 0;
        if (isFirstOfSubmit) {
          return {
            request_id: 'r',
            content: toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [{ label: 'k', goal: 'tarefa-na-sala' }],
              room: true,
            }),
            finish_reason: 'stop',
            usage,
          };
        }
        return { request_id: 'r', content: 'pronto.', finish_reason: 'stop', usage };
      }
      // Filho responde de imediato.
      return { request_id: 'r', content: 'feito na sala.', finish_reason: 'stop', usage };
    },
  };
}

/** Subclasse SÓ-de-teste p/ inspecionar o Map privado sem accessor de produção. */
class InspectableController extends SessionController {
  roomPoliciesSize(): number {
    return (this as unknown as { roomPolicies: Map<string, unknown> }).roomPolicies.size;
  }
}

describe('HUNT-SUBAGENT (EST-1011) — roomPolicies não vaza (poda salas mortas)', () => {
  it('salas expiradas (TTL) deixam de acumular policies órfãs entre lotes room:true', async () => {
    let now = 1_000_000;
    const controller = new InspectableController({
      model: roomScenarioModel(),
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: approveAll,
      meta,
      clock: () => now,
      subAgents: { enabled: true, maxConcurrency: 1, timeoutMs: 60_000 },
    });

    // 1º lote room:true ⇒ cria a sala A e sua policy.
    await controller.submit('rode na sala A');
    await waitFor(() => controller.roomPoliciesSize() >= 1);
    expect(controller.roomPoliciesSize()).toBe(1);

    // Avança o relógio ALÉM do TTL (1h default) ⇒ a sala A expira.
    now += 3_600_001;

    // 2º lote room:true ⇒ cria B e DEVE podar a A órfã (expirada/evictada do store).
    await controller.submit('rode na sala B');
    await waitFor(() => controller.roomPoliciesSize() >= 1);

    // Com o fix: só a policy de B sobra (A foi podada). Sem o fix: 2 (A órfã + B).
    expect(controller.roomPoliciesSize()).toBe(1);
  });
});
