// ADR-0158 §5 — log.ts: append + tail.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLog, tailLog } from '../../src/service/log.js';

describe('log.ts', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-log-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('tailLog de arquivo ausente ⇒ []', () => {
    expect(tailLog(join(base, 'nope.log'), 10)).toEqual([]);
  });

  it('appendLog cria o dir e escreve com timestamp', () => {
    const path = join(base, 'sub', 'runner.log');
    appendLog(path, 'olá');
    const lines = tailLog(path, 10);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('olá');
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
  });

  it('tailLog devolve só as últimas N linhas', () => {
    const path = join(base, 'runner.log');
    for (let i = 0; i < 5; i++) appendLog(path, `linha ${i}`);
    const lines = tailLog(path, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('linha 3');
    expect(lines[1]).toContain('linha 4');
  });
});
