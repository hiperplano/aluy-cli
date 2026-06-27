// F81 · ADR-0081 — msg_id ÚNICO ENTRE PROCESSOS (multicli).
//
// Bug: o controller gerava `m-<clock>-<roomMsgSeq>`. `roomMsgSeq` é per-processo
// (reinicia em 0 em cada CLI) e `clock()` é ms-granular ⇒ dois CLIs postando a
// N-ésima msg no MESMO ms geravam o MESMO msg_id. O FileRoomStore dedup-a por
// msg_id ⇒ a 2ª msg (DISTINTA) era silenciosamente DROPADA — perda em multicli.
// Fix: nonce aleatório por-processo no msg_id. Aqui provamos com um clock CONGELADO
// (mesmo ms p/ os dois "processos") que os ids saem DISTINTOS mesmo assim.

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

function loopModel(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: 'pronto.', finish_reason: 'stop' };
    },
  };
}

/** Expõe os geradores de id/chave privados p/ provar a unicidade sem I/O real. */
class IdController extends SessionController {
  genRoomMsgId(): string {
    return (this as unknown as { nextRoomMsgId(): string }).nextRoomMsgId();
  }
  genAskKey(): string {
    return (this as unknown as { nextAskIdempotencyKey(): string }).nextAskIdempotencyKey();
  }
}

function makeIdController(frozenMs: number): IdController {
  return new IdController({
    model: loopModel(),
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: approveAll,
    meta,
    clock: () => frozenMs, // relógio CONGELADO — pior caso (mesmo ms).
  });
}

describe('F81 — msg_id de sala é único entre processos (multicli)', () => {
  it('dois CLIs (mesmo clock congelado, mesmo contador inicial) ⇒ msg_ids DISTINTOS', () => {
    const now = 1_781_893_464_696;
    const cliA = makeIdController(now);
    const cliB = makeIdController(now);
    // 1ª msg de cada CLI: mesmo clock, mesmo contador(1). Sem o nonce colidiriam.
    const idA = cliA.genRoomMsgId();
    const idB = cliB.genRoomMsgId();
    expect(idA).not.toBe(idB);
  });

  it('dentro do MESMO processo, ids consecutivos diferem (contador monotônico)', () => {
    const c = makeIdController(42);
    const ids = [c.genRoomMsgId(), c.genRoomMsgId(), c.genRoomMsgId()];
    expect(new Set(ids).size).toBe(3); // todos distintos.
  });

  it('N CLIs concorrentes, 1ª msg cada (mesmo ms) ⇒ N ids ÚNICOS (sem perda no dedup)', () => {
    const now = 9_000_000;
    const ids = Array.from({ length: 25 }, () => makeIdController(now).genRoomMsgId());
    expect(new Set(ids).size).toBe(25); // nenhuma colisão ⇒ o dedup não dropa nada.
  });

  it('o formato preserva o prefixo `m-` + clock + contador (debugável) e ganha o nonce', () => {
    const c = makeIdController(123);
    expect(c.genRoomMsgId()).toMatch(/^m-123-1-[0-9a-f]{8}$/);
  });
});

describe('F82 — Idempotency-Key da /ask é única entre processos (broker dedup)', () => {
  it('dois CLIs (mesmo clock, mesma N-ésima /ask) ⇒ chaves DISTINTAS (sem dedup cruzado)', () => {
    const now = 1_781_893_464_696;
    const a = makeIdController(now).genAskKey();
    const b = makeIdController(now).genAskKey();
    expect(a).not.toBe(b); // sem isso, o broker devolveria a resposta de A ao B.
  });

  it('dentro do MESMO processo, /asks consecutivas têm chave distinta (contador)', () => {
    const c = makeIdController(7);
    const ks = [c.genAskKey(), c.genAskKey(), c.genAskKey()];
    expect(new Set(ks).size).toBe(3);
  });

  it('a chave /ask não colide com o msg_id de sala (prefixos distintos)', () => {
    const c = makeIdController(1);
    expect(c.genAskKey().startsWith('ask-')).toBe(true);
    expect(c.genRoomMsgId().startsWith('m-')).toBe(true);
  });

  it('formato `ask-<clock>-<n>-<nonce8>`', () => {
    expect(makeIdController(123).genAskKey()).toMatch(/^ask-123-1-[0-9a-f]{8}$/);
  });
});
