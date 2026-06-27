// EST-ROOMS-3 · ADR-0081 — wiring das salas no SessionController: /rooms new/list/read.
// (Os tools room_post/room_read entram no toolset — testados no factory do cli-core; aqui
// validamos os comandos do HUMANO que criam/listam/observam.)
// EST-1091: adaptado para a porta ASSÍNCRONA (await nos métodos de sala).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';
import { FileRoomStore } from '../../src/session/rooms/file-room-store.js';
import { TuiQuestionResolver } from '../../src/ask/question-resolver.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

function loopModel(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: 'pronto.', finish_reason: 'stop' };
    },
  };
}

function makeController(): SessionController {
  return new SessionController({
    model: loopModel(),
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: approveAll,
    meta,
  });
}

function notes(c: SessionController): { title: string; lines: readonly string[] }[] {
  return c.current.blocks.filter(
    (b): b is { kind: 'note'; title: string; lines: readonly string[] } => b.kind === 'note',
  );
}

describe('EST-ROOMS-3 · SessionController — /rooms (ADR-0081)', () => {
  it('roomNew cria uma sala e mostra o código', async () => {
    const c = makeController();
    await c.roomNew();
    const note = notes(c).find((n) => n.title === '/rooms');
    expect(note).toBeDefined();
    expect(note?.lines.join('\n')).toMatch(/sala criada: \S+/);
  });

  // F65 — backend `memory` é LOCAL-AO-PROCESSO: outra CLI não vê a sala e o
  // `room_read` falha silencioso. O `/rooms new` deve AVISAR (e dizer o remédio).
  it('roomNew sob backend memory AVISA que a sala é local-ao-processo', async () => {
    const c = makeController(); // default = MemoryRoomStore
    await c.roomNew();
    const note = notes(c).find((n) => n.title === '/rooms');
    const text = note?.lines.join('\n') ?? '';
    expect(text).toMatch(/LOCAL a ESTE processo/);
    expect(text).toMatch(/ALUY_ROOM_BACKEND=file/);
  });

  it('roomNew sob backend file (store em disco) NÃO avisa — coordenação cross-CLI funciona', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aluy-rooms-wiring-'));
    try {
      const c = new SessionController({
        model: loopModel(),
        permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
        ports: fakePorts(),
        askResolver: approveAll,
        meta,
        roomStore: new FileRoomStore(16, baseDir),
      });
      await c.roomNew();
      const note = notes(c).find((n) => n.title === '/rooms');
      const text = note?.lines.join('\n') ?? '';
      expect(text).toMatch(/sala criada: \S+/);
      expect(text).not.toMatch(/LOCAL a ESTE processo/);
      expect(text).not.toMatch(/ALUY_ROOM_BACKEND/);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('roomList lista as salas criadas', async () => {
    const c = makeController();
    await c.roomNew();
    await c.roomNew();
    await c.roomList();
    const last = notes(c).at(-1);
    // 2 salas listadas (cada linha tem "· N msg")
    expect(last?.lines.filter((l) => /· \d+ msg/.test(l)).length).toBe(2);
  });

  it('roomList sem salas ⇒ "nenhuma sala"', async () => {
    const c = makeController();
    await c.roomList();
    expect(JSON.stringify(notes(c))).toContain('nenhuma sala');
  });

  it('roomRead de sala inexistente ⇒ "não encontrada"', async () => {
    const c = makeController();
    await c.roomRead('XYZ');
    expect(JSON.stringify(notes(c))).toContain('não encontrada');
  });

  it('roomRead de sala recém-criada (vazia) ⇒ "(vazia)"', async () => {
    const c = makeController();
    await c.roomNew();
    const created = notes(c).find((n) => n.title === '/rooms');
    const code = created?.lines[0]?.match(/sala criada: (\S+)/)?.[1];
    expect(code).toBeDefined();
    await c.roomRead(code!);
    expect(JSON.stringify(notes(c))).toContain('(vazia)');
  });
});

// ADR-0126(B) — `/rooms read` SEM código: PICKER de leitura (reusa o <QuestionDialog>).
describe('SessionController — roomReadPick (picker de leitura)', () => {
  it('0 salas ⇒ nota "nenhuma sala pra ler" (nada a escolher)', async () => {
    const c = makeController();
    await c.roomReadPick();
    expect(JSON.stringify(notes(c))).toContain('nenhuma sala pra ler');
  });

  it('1 sala ⇒ lê DIRETO (sem picker)', async () => {
    const c = makeController();
    await c.roomNew(); // 1 sala (vazia)
    await c.roomReadPick();
    // leu a única sala ⇒ aparece o "(vazia)" do snapshot, sem pergunta.
    expect(JSON.stringify(notes(c))).toContain('(vazia)');
  });

  it('várias salas SEM resolver (headless) ⇒ degrada p/ a LISTA (não pendura)', async () => {
    const c = makeController(); // sem questionResolver
    await c.roomNew();
    await c.roomNew();
    await c.roomReadPick();
    const last = notes(c).at(-1);
    expect(last?.lines.filter((l) => /· \d+ msg/.test(l)).length).toBe(2);
  });

  it('várias salas COM resolver ⇒ pergunta e lê a sala ESCOLHIDA', async () => {
    const rooms = [mkRoom('AA', [mkMsg(2, 'oi de AA')]), mkRoom('BB', [mkMsg(2, 'oi de BB')])];
    const store = {
      async list() {
        return rooms;
      },
      async get(code: string) {
        return rooms.find((r) => r.code === code);
      },
    } as unknown as RoomStore;
    // o controller é dono do observer do resolver (sobrescreve o seu) — simulamos o
    // USUÁRIO escolhendo via `resolveQuestion`, como faz a App ao teclar enter.
    const resolver = new TuiQuestionResolver();
    const c = new SessionController({
      model: loopModel(),
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: approveAll,
      meta,
      roomStore: store,
      questionResolver: resolver,
      clock: () => 0,
    });
    const done = c.roomReadPick(); // publica a pergunta (após o list() assíncrono)
    // espera a pergunta aparecer, então escolhe BB (2ª opção), como o usuário faria.
    for (let i = 0; i < 200 && resolver.pending === null; i += 1) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(resolver.pending).not.toBeNull();
    c.resolveQuestion({ kind: 'choice', index: 1, label: 'BB' });
    await done;
    const txt = JSON.stringify(notes(c));
    expect(txt).toContain('oi de BB'); // leu a sala escolhida (BB)
    expect(txt).not.toContain('oi de AA'); // NÃO leu a outra
  });
});

// ADR-0126(B) — visibilidade reforçada: roomList enriquecido + roomWatch ao vivo.
import type { Room, RoomStore } from '@aluy/cli-core';

/** Store FAKE com relógio/sleep determinísticos: o tempo avança SÓ no sleep injetado. */
function makeWatchController(roomStore: RoomStore, clock: () => number) {
  return new SessionController({
    model: loopModel(),
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: approveAll,
    meta,
    roomStore,
    clock,
    // tempo avança 10s a cada poll ⇒ idle (30s) corta após ~4 polls; sem espera real.
    retry: { sleep: async () => {} },
  });
}

function mkRoom(code: string, msgs: Room['messages']): Room {
  return { code, createdAt: 0, ttlMs: 3_600_000, revoked: false, nextSeq: 1, messages: msgs };
}
function mkMsg(seq: number, body: string): Room['messages'][number] {
  return { msg_id: `m${seq}`, seq, from: 'dev', to: 'rev', kind: 'inform', body, ts: 0 };
}

describe('ADR-0126(B) — /rooms list enriquecido + /rooms watch ao vivo', () => {
  it('roomList mostra atividade + participantes + dica de watch', async () => {
    const room = mkRoom('AA', [mkMsg(2, 'oi')]);
    const store = {
      async list() {
        return [room];
      },
      async get() {
        return room;
      },
    } as unknown as RoomStore;
    const c = makeWatchController(store, () => 0);
    await c.roomList();
    const txt = JSON.stringify(notes(c));
    expect(txt).toContain('AA · 1 msg');
    expect(txt).toContain('dev'); // participante
    expect(txt).toContain('watch'); // dica de descoberta
  });

  it('roomWatch mostra mensagem NOVA chegando e AUTO-ENCERRA (não pendura)', async () => {
    // 1ª leitura: 1 msg (seq 2). Da 2ª em diante: ganhou a seq 3 (a "nova" ao vivo).
    let calls = 0;
    const base = [mkMsg(2, 'estado inicial')];
    const grown = [...base, mkMsg(3, 'NOVIDADE ao vivo')];
    const store = {
      async get() {
        calls += 1;
        return mkRoom('BB', calls === 1 ? base : grown);
      },
      async list() {
        return [];
      },
    } as unknown as RoomStore;
    // relógio avança 10s a cada chamada ⇒ idle(30s) corta o loop em poucos polls.
    let t = 0;
    const clock = () => (t += 10_000) - 10_000; // devolve o valor ANTES de incrementar
    const c = makeWatchController(store, clock);
    await c.roomWatch('BB'); // não pendura (tem teto/idle)
    const txt = JSON.stringify(notes(c));
    expect(txt).toContain('estado inicial'); // cauda inicial mostrada
    expect(txt).toContain('NOVIDADE ao vivo'); // a nova apareceu ao vivo
    expect(txt).toContain('watch encerrado'); // auto-encerrou
  });

  it('roomWatch de sala inexistente ⇒ "não encontrada", sem loop', async () => {
    const store = {
      async get() {
        return undefined;
      },
      async list() {
        return [];
      },
    } as unknown as RoomStore;
    const c = makeWatchController(store, () => 0);
    await c.roomWatch('ZZ');
    expect(JSON.stringify(notes(c))).toContain('não encontrada');
  });
});
