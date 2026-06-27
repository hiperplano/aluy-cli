// EST-1118 · ADR-0081/0121 — padrões de sala (broadcast / pipeline) CROSS-PROCESS.
//
// Os "padrões" (broadcast, pipeline, debate) não são código nomeado — são
// CONVENÇÕES sobre `room_post` + `readRoom(sinceSeq)`: cada leitor tem o SEU
// cursor (`since_seq`) e a leitura é NÃO-DESTRUTIVA. Aqui provamos a mecânica que
// os sustenta entre PROCESSOS OS REAIS (o que `Promise.all` no mesmo processo não
// exercita):
//   • BROADCAST (1→N fan-out): 1 produtor posta; N consumidores em paralelo, cada
//     um com cursor próprio (sinceSeq=0), TODOS veem a mesma diretiva.
//   • PIPELINE (handoff ordenado): A posta → B lê A e posta → C lê e vê AMBOS em
//     ordem de seq.
//
// CLI-SEC-7: só o transporte de arquivo — nenhum provider/credencial.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { FileRoomStore } from '../../src/session/rooms/file-room-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_URL = path.resolve(HERE, '../../dist/session/rooms/file-room-store.js');
const CORE_URL = path.resolve(HERE, '../../../cli-core/dist/index.js');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aluy-room-pat-'));
}

// Worker poliglota: `post` (semeia uma msg), `check` (lê com cursor e valida
// substrings esperadas), `relay` (lê+valida, depois posta a próxima). Exit 0 = ok.
const WORKER_SRC = `
import { FileRoomStore } from ${JSON.stringify(STORE_URL)};
import { readRoom, seedMessage } from ${JSON.stringify(CORE_URL)};
const [, , mode, baseDir, code, ...rest] = process.argv;
const store = new FileRoomStore(16, baseDir);
const room = await store.get(code);
if (!room) { console.error('sala sumiu'); process.exit(2); }

function mkMsg(body, from) {
  return { msg_id: from + '-' + Math.round(room.nextSeq), from, to: 'all', kind: 'inform', body, ts: 1 };
}
async function post(body, from) { await store.set(code, seedMessage(room, mkMsg(body, from))); }
// readRoom(room, now, sinceSeq) → { ok, entries: string[] } (entries já envelopadas como DADO).
function readSince(sinceSeq) { return readRoom(room, Date.now(), Number(sinceSeq)).entries; }

if (mode === 'post') {
  await post(rest[0], rest[1] || 'producer');
  process.exit(0);
} else if (mode === 'check') {
  const [sinceSeq, expectCsv] = rest;
  const bodies = readSince(sinceSeq);
  const expected = expectCsv.split('||');
  const ok = expected.every(e => bodies.some(b => b.includes(e)));
  // ordem: os índices das mensagens esperadas devem ser crescentes
  const idx = expected.map(e => bodies.findIndex(b => b.includes(e)));
  const ordered = idx.every((v, i) => i === 0 || v > idx[i - 1]);
  console.error('check bodies=' + JSON.stringify(bodies));
  process.exit(ok && ordered ? 0 : 3);
} else if (mode === 'relay') {
  const [sinceSeq, expect, postBody, from] = rest;
  const bodies = readSince(sinceSeq);
  if (!bodies.some(b => b.includes(expect))) { console.error('relay nao viu ' + expect); process.exit(4); }
  await post(postBody, from);
  process.exit(0);
} else { console.error('modo?'); process.exit(9); }
`;

function run(workerPath: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [workerPath, ...args], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    c.on('error', reject);
    c.on('exit', (n) => resolve(n ?? -1));
  });
}

describe('padrões de sala CROSS-PROCESS (broadcast / pipeline)', () => {
  let baseDir: string;
  let worker: string;

  beforeEach(() => {
    baseDir = tmpDir();
    worker = path.join(baseDir, 'pat-worker.mjs');
    fs.writeFileSync(worker, WORKER_SRC, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('BROADCAST: 1 produtor → N consumidores, cada um (cursor próprio) vê a diretiva', async () => {
    const store = new FileRoomStore(16, baseDir);
    const room = await store.create({ now: Date.now(), ttlMs: 3600_000 });

    // Produtor (processo) posta a diretiva.
    expect(await run(worker, ['post', baseDir, room.code, 'DIRETIVA-DO-PO', 'po'])).toBe(0);

    // 3 consumidores em PARALELO, cada um lê com sinceSeq=0 e exige ver a diretiva.
    const consumers = await Promise.all([
      run(worker, ['check', baseDir, room.code, '0', 'DIRETIVA-DO-PO']),
      run(worker, ['check', baseDir, room.code, '0', 'DIRETIVA-DO-PO']),
      run(worker, ['check', baseDir, room.code, '0', 'DIRETIVA-DO-PO']),
    ]);
    // TODOS os consumidores viram (leitura não-destrutiva, fan-out 1→N).
    expect(consumers).toEqual([0, 0, 0]);
  }, 30_000);

  it('PIPELINE: A posta → B lê A e posta → C lê AMBOS em ordem de seq', async () => {
    const store = new FileRoomStore(16, baseDir);
    const room = await store.create({ now: Date.now(), ttlMs: 3600_000 });

    // A posta o estágio 1.
    expect(await run(worker, ['post', baseDir, room.code, 'STAGE-A-feito', 'a'])).toBe(0);
    // B (processo) lê A (exige ver STAGE-A) e posta o estágio 2.
    expect(
      await run(worker, ['relay', baseDir, room.code, '0', 'STAGE-A', 'STAGE-B-feito', 'b']),
    ).toBe(0);
    // C lê do começo e exige ver AMBOS, EM ORDEM (A antes de B).
    expect(await run(worker, ['check', baseDir, room.code, '0', 'STAGE-A||STAGE-B'])).toBe(0);

    // Sanidade: as 2 msgs do pipeline (A, B) têm seq DISTINTO e ASCENDENTE
    // (o seq inicial pode não ser 1 — `create()` reserva seq de metadata).
    const final = await new FileRoomStore(16, baseDir).get(room.code);
    const seqs = final!.messages.map((m) => m.seq as number);
    expect(seqs).toHaveLength(2);
    expect(seqs[1]).toBeGreaterThan(seqs[0]!);
    expect(final!.messages.map((m) => m.body)).toEqual(['STAGE-A-feito', 'STAGE-B-feito']);
  }, 30_000);
});
