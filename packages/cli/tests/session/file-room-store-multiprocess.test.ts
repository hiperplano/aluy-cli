// EST-1118 · ADR-0121 — CA-FILE-3 (reforço): concorrência CROSS-PROCESS REAL.
//
// O teste existente de concorrência (file-room-store.test.ts CA-FILE-3) usa
// `Promise.all` no MESMO processo — não exercita o que o FileRoomStore existe
// para resolver: DOIS BINÁRIOS `aluy` SEPARADOS (PIDs distintos) na mesma
// máquina compartilhando uma sala por arquivo. O lock `wx`, a detecção de lock
// stale (por `process.pid`) e a durabilidade do fs ENTRE processos só têm
// significado real com processos OS de verdade. Aqui spawamos 2 `node` filhos
// que batem na MESMA sala em paralelo e provamos: nenhuma mensagem perdida
// (read-merge-write sob lock dedupa por msg_id), seq único e monotônico.
//
// CLI-SEC-7: nada de provider/credencial — só o transporte de arquivo.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { FileRoomStore } from '../../src/session/rooms/file-room-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// O filho roda JS COMPILADO (dist) — o transporte real que o binário usa.
const DIST_STORE = path.resolve(HERE, '../../dist/session/rooms/file-room-store.js');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aluy-room-mp-'));
}

/** Worker: abre o store no dir compartilhado e posta `count` msgs na sala. */
const WORKER_SRC = (storeUrl: string) => `
import { FileRoomStore } from ${JSON.stringify(storeUrl)};
const [, , baseDir, code, workerId, countStr] = process.argv;
const count = Number(countStr);
const store = new FileRoomStore(16, baseDir);
for (let i = 0; i < count; i++) {
  const room = await store.get(code);
  if (!room) { console.error('sala sumiu'); process.exit(2); }
  const msg = {
    msg_id: workerId + '-' + i,
    from: workerId,
    to: 'all',
    kind: 'inform',
    body: 'm' + i + ' de ' + workerId,
    ts: Date.now() + i,
  };
  await store.set(code, { ...room, messages: [...room.messages, msg] });
}
process.exit(0);
`;

function runWorker(
  workerPath: string,
  baseDir: string,
  code: string,
  workerId: string,
  count: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, baseDir, code, workerId, String(count)], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (codeNum) => resolve(codeNum ?? -1));
  });
}

describe('CA-FILE-3 (cross-process REAL): 2 processos OS postam na MESMA sala', () => {
  let baseDir: string;
  let workerPath: string;

  beforeEach(() => {
    baseDir = tmpDir();
    workerPath = path.join(baseDir, 'worker.mjs');
    fs.writeFileSync(workerPath, WORKER_SRC(DIST_STORE), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('2 processos × N posts ⇒ 2N mensagens, sem perda, seq único e monotônico', async () => {
    const N = 15;
    const store = new FileRoomStore(16, baseDir);
    const room = await store.create({ now: Date.now(), ttlMs: 3600_000 });

    // Dois PROCESSOS OS de verdade, em paralelo, na MESMA sala.
    const [exitA, exitB] = await Promise.all([
      runWorker(workerPath, baseDir, room.code, 'A', N),
      runWorker(workerPath, baseDir, room.code, 'B', N),
    ]);
    expect(exitA).toBe(0);
    expect(exitB).toBe(0);

    // Lê do disco (instância nova — fresh read).
    const final = await new FileRoomStore(16, baseDir).get(room.code);
    expect(final).toBeDefined();
    const msgs = final!.messages;

    // (1) Nenhuma mensagem perdida na corrida cross-process (RMW sob lock + dedupe).
    expect(msgs).toHaveLength(2 * N);

    // (2) Todos os msg_id esperados presentes (ambos os processos), sem duplicata.
    const ids = new Set(msgs.map((m) => m.msg_id));
    expect(ids.size).toBe(2 * N);
    for (const w of ['A', 'B']) {
      for (let i = 0; i < N; i++) expect(ids.has(`${w}-${i}`)).toBe(true);
    }

    // (3) seq único e monotônico (1..2N, sem buraco nem repetição).
    const seqs = msgs.map((m) => m.seq).filter((s): s is number => typeof s === 'number');
    expect(seqs.length).toBe(2 * N);
    expect(new Set(seqs).size).toBe(2 * N);
    const sorted = [...seqs].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!).toBeGreaterThan(sorted[i - 1]!);
  }, 30_000);
});
