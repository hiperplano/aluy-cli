// ADR-0158 §5 — pidfile: grava/lê/checa-vivo/remove.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
  isRunnerAlive,
  pidFileExists,
} from '../../src/service/pid.js';

describe('pid.ts', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-pid-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('grava e lê o pid', () => {
    const path = join(base, 'runner.pid');
    writePidFile(path, 12345);
    expect(readPidFile(path)).toBe(12345);
    expect(pidFileExists(path)).toBe(true);
  });

  it('readPidFile de arquivo ausente ⇒ undefined', () => {
    expect(readPidFile(join(base, 'nope.pid'))).toBeUndefined();
  });

  it('readPidFile de conteúdo não-numérico ⇒ undefined', () => {
    const path = join(base, 'bad.pid');
    writePidFile(path, 1); // garante o dir
    writeFileSync(path, 'lixo');
    expect(readPidFile(path)).toBeUndefined();
  });

  it('removePidFile remove (idempotente — 2ª chamada não lança)', () => {
    const path = join(base, 'runner.pid');
    writePidFile(path, 1);
    removePidFile(path);
    expect(existsSync(path)).toBe(false);
    expect(() => removePidFile(path)).not.toThrow();
  });

  it('isProcessAlive(process.pid) ⇒ true (o próprio processo de teste)', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive de pid absurdo ⇒ false', () => {
    expect(isProcessAlive(999_999_999)).toBe(false);
  });

  it('isRunnerAlive cruza pidfile + processo vivo', () => {
    const path = join(base, 'runner.pid');
    writePidFile(path, process.pid);
    expect(isRunnerAlive(path)).toBe(true);
    writePidFile(path, 999_999_999);
    expect(isRunnerAlive(path)).toBe(false);
  });

  it('isRunnerAlive sem pidfile ⇒ false', () => {
    expect(isRunnerAlive(join(base, 'nope.pid'))).toBe(false);
  });
});
