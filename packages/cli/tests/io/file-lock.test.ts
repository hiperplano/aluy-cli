// F71 — lock de arquivo cross-process reusável: exclusão mútua + quebra de stale.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withFileLock, acquireFileLock, releaseFileLock } from '../../src/io/file-lock.js';

describe('file-lock (F71)', () => {
  let dir: string;
  let lockPath: string;
  let dataPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aluy-flock-'));
    lockPath = path.join(dir, 'res.lock');
    dataPath = path.join(dir, 'data');
    fs.writeFileSync(dataPath, '0', 'utf-8');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('serializa read-modify-write concorrente NO MESMO processo (sem lost-update)', async () => {
    // Incremento NÃO-atômico: lê, +1, escreve com um await no meio (força interleave
    // sem lock). Sob o lock, as 50 chamadas concorrentes têm de somar exatamente 50.
    const bump = () =>
      withFileLock(lockPath, async () => {
        const v = Number(fs.readFileSync(dataPath, 'utf-8'));
        await new Promise((r) => setTimeout(r, 1)); // janela de corrida
        fs.writeFileSync(dataPath, String(v + 1), 'utf-8');
      });
    await Promise.all(Array.from({ length: 50 }, () => bump()));
    expect(Number(fs.readFileSync(dataPath, 'utf-8'))).toBe(50);
  });

  it('quebra um lock STALE pré-existente (createdAt antigo) e adquire', async () => {
    // Planta um lock stale (createdAt=1 ⇒ idade >> teto contra o relógio real).
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, createdAt: 1 }), { mode: 0o600 });
    let ran = false;
    await withFileLock(lockPath, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    // Lock liberado no fim e nenhum arquivo .steal renomeado pra trás.
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.steal.'))).toEqual([]);
  });

  it('libera o lock mesmo quando fn LANÇA (finally)', async () => {
    await expect(
      withFileLock(lockPath, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Lock NÃO ficou preso: uma 2ª aquisição funciona na hora.
    await acquireFileLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    await releaseFileLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // F95 — release checa POSSE: um dono que estourou o lease NÃO apaga o lock de quem o roubou.
  describe('F95 — release só apaga se o lock ainda for nosso', () => {
    it('release com token ALHEIO não apaga o lock vivo de outro dono (anti-clobber)', async () => {
      const tokenA = await acquireFileLock(lockPath); // A adquire
      // A estourou o lease; B roubou stale e adquiriu o SEU lock (sobrescreve o lockfile).
      const tokenB = { pid: tokenA.pid + 1, createdAt: tokenA.createdAt + 99999 };
      fs.writeFileSync(lockPath, JSON.stringify(tokenB), { mode: 0o600 });
      // A acorda e libera com o token DELE → não deve tocar no lock de B.
      await releaseFileLock(lockPath, tokenA);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(tokenB.pid);
    });

    it('release com o PRÓPRIO token apaga o lock', async () => {
      const token = await acquireFileLock(lockPath);
      await releaseFileLock(lockPath, token);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('withFileLock no caminho normal libera o próprio lock (sem regressão)', async () => {
      let ran = false;
      await withFileLock(lockPath, () => {
        ran = true;
        expect(fs.existsSync(lockPath)).toBe(true); // segurando durante a fn
      });
      expect(ran).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false); // liberou no fim
    });
  });
});
