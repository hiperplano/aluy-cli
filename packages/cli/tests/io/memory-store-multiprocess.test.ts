// F71 (#fix) — lost-update CROSS-PROCESS do NodeMemoryStore.
//
// `~/.aluy/memory/global.md` é COMPARTILHADO entre TODAS as CLIs. O `append` faz
// READ-MODIFY-WRITE; sem lock cross-process, dois processos appendando ao MESMO
// escopo perdiam updates (A lê, B lê, A grava, B grava ⇒ o fato de A some). O write
// atômico (tmp+rename) evita arquivo TORTO mas NÃO o lost-update. Aqui spawamos 2
// `node` filhos REAIS (PIDs distintos) que appendam ao MESMO `global` em paralelo e
// provamos que NENHUM fato some — o lock serializa o read→write entre processos.
//
// (Mesma máquina/transporte; sem provider/credencial — CLI-SEC-7.)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { NodeMemoryStore } from '../../src/io/memory-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST_STORE = path.resolve(HERE, '../../dist/io/memory-store.js');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aluy-mem-mp-'));
}

// Workspace stub (só p/ o construtor; o teste usa SÓ o escopo global).
const WORKER_SRC = (storeUrl: string) => `
import { NodeMemoryStore } from ${JSON.stringify(storeUrl)};
const [, , baseDir, workerId, countStr] = process.argv;
const count = Number(countStr);
const ws = { resolveInside: (p) => baseDir + '/ws/' + p };
const store = new NodeMemoryStore({ baseDir, workspace: ws });
for (let i = 0; i < count; i++) {
  await store.append({
    id: workerId + '-' + i,
    text: 'fato ' + workerId + ' numero ' + i,
    scope: 'global',
    provenance: 'usuario',
    pinned: false,
    ts: Date.now() + i,
  });
}
process.exit(0);
`;

function runWorker(
  workerPath: string,
  baseDir: string,
  workerId: string,
  count: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [workerPath, baseDir, workerId, String(count)], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    c.on('error', reject);
    c.on('exit', (n) => resolve(n ?? -1));
  });
}

describe('NodeMemoryStore — append CROSS-PROCESS sem lost-update (F71)', () => {
  let baseDir: string;
  let worker: string;

  beforeEach(() => {
    baseDir = tmpDir();
    worker = path.join(baseDir, 'mem-worker.mjs');
    fs.writeFileSync(worker, WORKER_SRC(DIST_STORE), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('2 processos appendando ao MESMO escopo global em paralelo ⇒ TODOS os fatos preservados', async () => {
    const N = 20;
    // Dois PIDs distintos batem no mesmo global.md ao mesmo tempo.
    const [a, b] = await Promise.all([
      runWorker(worker, baseDir, 'A', N),
      runWorker(worker, baseDir, 'B', N),
    ]);
    expect(a).toBe(0);
    expect(b).toBe(0);

    // Lê o resultado por um store fresco (relê o disco).
    const ws = { resolveInside: (p: string) => path.join(baseDir, 'ws', p) } as never;
    const store = new NodeMemoryStore({ baseDir, workspace: ws });
    const all = await store.readAll();
    const global = all.filter((f) => f.scope === 'global');

    // SEM lock: < 2N (updates perdidos). COM lock: EXATAMENTE 2N e todos os ids únicos.
    expect(global).toHaveLength(2 * N);
    const ids = new Set(global.map((f) => f.id));
    expect(ids.size).toBe(2 * N);
    for (const w of ['A', 'B']) {
      for (let i = 0; i < N; i++) expect(ids.has(`${w}-${i}`)).toBe(true);
    }
  }, 40_000);
});
