// EST-1121 · ADR-0122 §F51 — articulação dinâmica de sala: system-note de PROCESSO
// injetada nos sub-agentes.
//
// Quando `spawn_agent room:` é chamado com ≥2 agentes, o CLI injeta uma system-note
// de PROCESSO no contexto de cada filho dizendo COMO articular (postar, ler por
// cursor, dar ack, condição de término). A nota é PROCESSO (não INSTRUÇÃO DE
// CONTEÚDO): o modelo a considera como contexto, nunca como ordem a obedecer.
//
// Provamos:
//  1. A system-note CHEGA ao filho como parte do `system` (projectInstructions).
//  2. A system-note contém os marcadores de PROCESSO esperados.
//  3. O envelope de DADO_NÃO_CONFIAVEL (laundering) segue intacto.
//  4. Sem roomToolsFor, `room:true` é no-op (fail-safe).
//  5. Com 1 agente só, NÃO injeta articulação (gatilho "objetivo coletivo").
//  6. Padrão `broadcast` (default) vs `pipeline` vs `debate`.

/* eslint-disable @typescript-eslint/no-unused-vars */

import { describe, expect, it } from 'vitest';
import {
  SubAgentSpawner,
  formatRoomArtSystemNote,
  buildRoomTools,
  MemoryRoomStore,
  PolicyPermissionEngine,
  NATIVE_TOOLS,
  type ModelCaller,
  type NativeTool,
  type ToolPorts,
  type MeshPolicy,
  type RoomStore,
} from '../../src/index.js';
import { ROOM_POST_TOOL_NAME, ROOM_READ_TOOL_NAME } from '../../src/agent/rooms/room-tools.js';
import { MemoryFs, RecordingShell, MemorySearch, toolCallBlock } from './helpers.js';

function ports(): ToolPorts {
  return { fs: new MemoryFs(), shell: new RecordingShell(), search: new MemorySearch() };
}

/**
 * ModelCaller que CAPTURA o `system` (projectInstructions) de cada filho por
 * sessionId. Roteiro mínimo: 1 tool-call e um `final`.
 */
class CapturingModel implements ModelCaller {
  private readonly counts = new Map<string, number>();
  /** sessionId → systemContent (projectInstructions) da 1ª chamada */
  readonly capturedSystems = new Map<string, string>();

  constructor(private readonly script: (sessionId: string, turn: number, seen: string) => string) {}

  async call(args: { idempotencyKey: string; messages: { role: string; content: string }[] }) {
    const lastColon = args.idempotencyKey.lastIndexOf(':');
    const sessionId = lastColon > 0 ? args.idempotencyKey.slice(0, lastColon) : args.idempotencyKey;
    const turn = this.counts.get(sessionId) ?? 0;
    this.counts.set(sessionId, turn + 1);

    // Captura o system na 1ª chamada (projectInstructions).
    if (turn === 0) {
      const sysMsg = args.messages.find((m) => m.role === 'system');
      if (sysMsg) {
        this.capturedSystems.set(sessionId, sysMsg.content);
      }
    }

    const seen = args.messages.map((m) => m.content).join('\n');
    return {
      request_id: 'req',
      content: this.script(sessionId, turn, seen),
      finish_reason: 'stop' as const,
      usage: { request_id: 'req', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
    };
  }
}

const GOAL_A = 'AGENTE-A-poste';
const GOAL_B = 'AGENTE-B-leia';

function makeSpawner(
  model: ModelCaller,
  store: RoomStore,
  policies: Map<string, MeshPolicy>,
  opts?: { roomCode?: string; roomArtPattern?: 'broadcast' | 'pipeline' | 'debate' },
): SubAgentSpawner {
  const roomToolsFor = (writerId: string): readonly NativeTool<ToolPorts>[] =>
    buildRoomTools({
      store,
      writerId,
      policyFor: (code) => policies.get(code) ?? { writers: [], maxHops: 10 },
      now: () => 1,
      genMsgId: () => `m-${writerId}-${Math.random().toString(36).slice(2)}`,
    }) as readonly NativeTool<ToolPorts>[];

  return new SubAgentSpawner({
    model,
    permission: new PolicyPermissionEngine({
      policy: { rules: [{ tool: ROOM_READ_TOOL_NAME, decision: 'allow' }] },
    }),
    ports: ports(),
    baseTools: NATIVE_TOOLS as readonly NativeTool<ToolPorts>[],
    maxConcurrency: 1,
    roomToolsFor,
    ...(opts?.roomCode !== undefined ? { roomCode: opts.roomCode } : {}),
    ...(opts?.roomArtPattern !== undefined ? { roomArtPattern: opts.roomArtPattern } : {}),
  });
}

describe('EST-1121 · ADR-0122 — system-note de PROCESSO', () => {
  it('formatRoomArtSystemNote gera nota com marcadores de PROCESSO (broadcast)', () => {
    const note = formatRoomArtSystemNote('broadcast', 3, 'sub-A', 'sala-xyz', 0);
    // marcadores de PROCESSO
    expect(note).toContain('[SYSTEM-NOTE DE PROCESSO — EST-1121 ROOMS-ARTIC]');
    expect(note).toContain('PROCESSO:');
    expect(note).toContain('Esta nota é PROCESSO gerado pelo CLI');
    // parâmetros
    expect(note).toContain('3 sub-agentes');
    expect(note).toContain('"sala-xyz"');
    expect(note).toContain('"sub-A"');
    expect(note).toContain('1 de 3');
    // padrão
    expect(note).toContain('broadcast');
    // instruções de articulação
    expect(note).toContain('room_post');
    expect(note).toContain('room_read');
    expect(note).toContain('since_seq');
    expect(note).toContain('wait_for_writers');
    // condição de término
    expect(note).toContain('CONDIÇÃO DE TÉRMINO');
    expect(note).toContain('todos os 3 sub-agentes postaram');
  });

  it('formatRoomArtSystemNote gera nota com condição PIPELINE (primeiro vs meio)', () => {
    // PRIMEIRO (índice 0): NÃO espera ninguém.
    const primeiro = formatRoomArtSystemNote('pipeline', 3, 'sub-0', 'sala-pipe', 0);
    expect(primeiro).toContain('PRIMEIRO da pipeline');
    expect(primeiro).not.toContain('wait_for_writers');

    // MEIO (índice 1): espera o anterior (índice 0, label "sub-0").
    const meio = formatRoomArtSystemNote('pipeline', 3, 'sub-1', 'sala-pipe', 1);
    expect(meio).toContain('PIPELINE');
    expect(meio).toContain('IMEDIATAMENTE anterior');
    expect(meio).toContain('wait_for_writers');
    expect(meio).toContain('"sub-0"');
  });

  it('formatRoomArtSystemNote gera nota com condição DEBATE (cap DURO)', () => {
    const note = formatRoomArtSystemNote('debate', 3, 'sub-A', 'sala-deb', 0, 4);
    expect(note).toContain('DEBATE');
    expect(note).toContain('4 rodadas');
    expect(note).toContain('DURO');
    // o cap absoluto (5) não pode ser excedido
    const excess = formatRoomArtSystemNote('debate', 3, 'sub-A', 'sala-deb', 0, 99);
    expect(excess).toContain('5 rodadas'); // cap = min(99, 5) = 5
    expect(excess).not.toContain('99 rodadas');
  });

  it('≥2 agentes com room:true injetam a system-note no projectInstructions de cada filho', async () => {
    const store = new MemoryRoomStore();
    const room = await store.create({ now: 1 });
    const policies = new Map<string, MeshPolicy>([
      [room.code, { writers: ['A', 'B'], maxHops: 10 }],
    ]);

    const model = new CapturingModel((sessId, turn, _seen) => {
      const isA = sessId.endsWith(':A');
      if (isA) {
        return turn === 0
          ? toolCallBlock(ROOM_POST_TOOL_NAME, {
              code: room.code,
              kind: 'inform',
              to: 'B',
              body: 'resultado-A',
            })
          : 'A: feito.';
      }
      return turn === 0
        ? toolCallBlock(ROOM_READ_TOOL_NAME, { code: room.code })
        : 'B: li, terminei.';
    });

    await makeSpawner(model, store, policies, { roomCode: room.code }).spawn(
      [
        { label: 'A', goal: GOAL_A },
        { label: 'B', goal: GOAL_B },
      ],
      undefined,
      { room: true },
    );

    // Ambos os filhos receberam system com a nota de articulação.
    expect(model.capturedSystems.size).toBeGreaterThanOrEqual(2);
    for (const [sessId, system] of model.capturedSystems) {
      expect(system).toContain('[SYSTEM-NOTE DE PROCESSO — EST-1121 ROOMS-ARTIC]');
      expect(system).toContain('room_post');
      expect(system).toContain('room_read');
      expect(system).toContain(`"${room.code}"`);
    }
  });

  it('com 1 agente só, NÃO injeta articulação (gatilho do "objetivo coletivo")', async () => {
    const store = new MemoryRoomStore();
    const room = await store.create({ now: 1 });
    const policies = new Map<string, MeshPolicy>([[room.code, { writers: ['solo'], maxHops: 10 }]]);

    const model = new CapturingModel((sessId, turn, _seen) => {
      return turn === 0
        ? toolCallBlock(ROOM_POST_TOOL_NAME, {
            code: room.code,
            kind: 'inform',
            to: 'todos',
            body: 'resultado-solo',
          })
        : 'solo: feito.';
    });

    await makeSpawner(model, store, policies, { roomCode: room.code }).spawn(
      [{ label: 'solo', goal: 'GOAL_SOLO' }],
      undefined,
      { room: true },
    );

    // O filho solo NÃO recebeu articulação (1 agente só).
    for (const [_sessId, system] of model.capturedSystems) {
      expect(system).not.toContain('[SYSTEM-NOTE DE PROCESSO — EST-1121 ROOMS-ARTIC]');
    }
  });

  it('sem roomToolsFor, room:true é no-op — sem system-note nem tools de sala', async () => {
    const model = new CapturingModel((_sessId, turn, _seen) => {
      return turn === 0 ? 'nenhum tool de sala disponível, encerrei.' : 'feito.';
    });

    // Spawner SEM roomToolsFor (fail-safe).
    const spawner = new SubAgentSpawner({
      model,
      permission: new PolicyPermissionEngine(),
      ports: ports(),
      baseTools: NATIVE_TOOLS as readonly NativeTool<ToolPorts>[],
      // SEM roomToolsFor
    });

    await spawner.spawn(
      [
        { label: 'A', goal: GOAL_A },
        { label: 'B', goal: GOAL_B },
      ],
      undefined,
      { room: true },
    );

    // NENHUM filho recebeu system-note de articulação.
    for (const [_sessId, system] of model.capturedSystems) {
      expect(system).not.toContain('[SYSTEM-NOTE DE PROCESSO — EST-1121 ROOMS-ARTIC]');
    }
  });

  it('padrão pipeline é injetado com a condição específica', async () => {
    const store = new MemoryRoomStore();
    const room = await store.create({ now: 1 });
    const policies = new Map<string, MeshPolicy>([
      [room.code, { writers: ['A', 'B'], maxHops: 10 }],
    ]);

    const model = new CapturingModel((sessId, turn, _seen) => {
      const isA = sessId.endsWith(':A');
      if (isA) {
        return turn === 0
          ? toolCallBlock(ROOM_POST_TOOL_NAME, {
              code: room.code,
              kind: 'inform',
              to: 'B',
              body: 'resultado-A',
            })
          : 'A: feito.';
      }
      return turn === 0
        ? toolCallBlock(ROOM_READ_TOOL_NAME, { code: room.code })
        : 'B: li, terminei.';
    });

    await makeSpawner(model, store, policies, {
      roomCode: room.code,
      roomArtPattern: 'pipeline',
    }).spawn(
      [
        { label: 'A', goal: GOAL_A },
        { label: 'B', goal: GOAL_B },
      ],
      undefined,
      { room: true, pattern: 'pipeline' },
    );

    // A (índice 0) vê "PRIMEIRO da pipeline" — o system com label "A" tem o texto.
    const sysA = [...model.capturedSystems.values()].find(
      (s) => s.includes('"A"') && s.includes('SYSTEM-NOTE'),
    );
    expect(sysA).toBeDefined();
    expect(sysA!).toContain('PRIMEIRO da pipeline');

    // B (índice 1) vê "IMEDIATAMENTE anterior" + "wait_for_writers" — label "B".
    const sysB = [...model.capturedSystems.values()].find(
      (s) => s.includes('"B"') && s.includes('SYSTEM-NOTE'),
    );
    expect(sysB).toBeDefined();
    expect(sysB!).toContain('IMEDIATAMENTE anterior');
    expect(sysB!).toContain('wait_for_writers');
  });

  it('padrão debate é injetado com cap de rodadas', async () => {
    const store = new MemoryRoomStore();
    const room = await store.create({ now: 1 });
    const policies = new Map<string, MeshPolicy>([
      [room.code, { writers: ['A', 'B'], maxHops: 10 }],
    ]);

    const model = new CapturingModel((sessId, turn, _seen) => {
      const isA = sessId.endsWith(':A');
      if (isA) {
        return turn === 0
          ? toolCallBlock(ROOM_POST_TOOL_NAME, {
              code: room.code,
              kind: 'inform',
              to: 'B',
              body: 'resultado-A',
            })
          : 'A: feito.';
      }
      return turn === 0
        ? toolCallBlock(ROOM_READ_TOOL_NAME, { code: room.code })
        : 'B: li, terminei.';
    });

    await makeSpawner(model, store, policies, {
      roomCode: room.code,
      roomArtPattern: 'debate',
    }).spawn(
      [
        { label: 'A', goal: GOAL_A },
        { label: 'B', goal: GOAL_B },
      ],
      undefined,
      { room: true, pattern: 'debate' },
    );

    // Ambos veem "DEBATE" + cap.
    for (const [_sessId, system] of model.capturedSystems) {
      expect(system).toContain('DEBATE');
      expect(system).toContain('rodadas');
      expect(system).toContain('DURO');
    }
  });
});
