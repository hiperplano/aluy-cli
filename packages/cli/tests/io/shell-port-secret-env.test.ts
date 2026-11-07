// ADR 0005 — a porta de shell REAL exporta os segredos SÓ no env do filho (processo real),
// nunca no `process.env` do Aluy; e o `localOnly` do bloco `!!` sobrevive ao disco.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeShellPort } from '../../src/io/shell-port.js';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { blocksToHistory, sanitizeBlocks } from '../../src/io/session-record.js';

describe('NodeShellPort — env dos segredos', () => {
  it('o filho enxerga $TOKEN_Z; sem env extra não enxerga; process.env do Aluy fica limpo', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-sh-env-'));
    const root = join(base, 'p');
    mkdirSync(root, { recursive: true });
    try {
      const shell = new NodeShellPort({ workspace: new NodeWorkspace({ root }) });
      const com = await shell.exec('echo "[$TOKEN_Z]"', { env: { TOKEN_Z: 'valor-do-filho' } });
      expect(com.stdout.trim()).toBe('[valor-do-filho]');
      const sem = await shell.exec('echo "[$TOKEN_Z]"');
      expect(sem.stdout.trim()).toBe('[]');
      expect(process.env.TOKEN_Z).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('bloco `!!` (localOnly) no disco', () => {
  it('sanitizeBlocks preserva localOnly (e só ele); blocksToHistory omite o bloco', () => {
    const [b] = sanitizeBlocks([
      { kind: 'bang', command: 'cat .env', status: 'ok', output: 'x', localOnly: true },
    ]);
    expect(b).toMatchObject({ kind: 'bang', localOnly: true });
    const [c] = sanitizeBlocks([{ kind: 'bang', command: 'ls', status: 'ok', output: 'x' }]);
    expect(c).not.toHaveProperty('localOnly');
    expect(blocksToHistory([b!])).toEqual([]);
  });
});
