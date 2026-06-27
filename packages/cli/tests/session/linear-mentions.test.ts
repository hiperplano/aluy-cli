// EST-0957 · fallback NÃO-TTY — `@path` LITERAL no objetivo é resolvido pelo reader
// confinado e injetado como dado; escape/path-deny bloqueados também sem TTY.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLinearMentions } from '../../src/session/linear.js';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { NodeFileSystemPort } from '../../src/io/fs-port.js';
import { AttachReader } from '../../src/attach/reader.js';

describe('resolveLinearMentions — @path literal sem TTY', () => {
  let base: string;
  let root: string;

  function reader(): AttachReader {
    const workspace = new NodeWorkspace({ root });
    return new AttachReader({ workspace, fs: new NodeFileSystemPort({ workspace }) });
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-linmention-'));
    root = join(base, 'project');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'export const APP = 1;\n');
    writeFileSync(join(root, '.env'), 'SECRET=x\n');
    writeFileSync(join(base, 'outside.txt'), 'FORA\n');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('resolve `@src/app.ts` e injeta como item rotulado; tira do goal', async () => {
    const r = await resolveLinearMentions('explique @src/app.ts', reader());
    expect(r.items.length).toBe(1);
    expect(r.items[0]!.text).toContain('[arquivo: src/app.ts]');
    expect(r.items[0]!.text).toContain('export const APP = 1;');
    expect(r.goal).toBe('explique');
    expect(r.notes.join('\n')).toContain('[anexo] @src/app.ts');
  });

  it('escape (`@../outside.txt`) é REJEITADO mesmo sem TTY — nenhum byte fora', async () => {
    const r = await resolveLinearMentions('veja @../outside.txt', reader());
    expect(r.items.length).toBe(0);
    expect(r.notes.join('\n')).toMatch(/recusado/i);
    expect(JSON.stringify(r)).not.toContain('FORA');
  });

  it('path-deny (`@.env`) é rejeitado sem TTY — segredo não vaza', async () => {
    const r = await resolveLinearMentions('veja @.env', reader());
    expect(r.items.length).toBe(0);
    expect(JSON.stringify(r)).not.toContain('SECRET=x');
  });

  it('sem reader: passa reto (objetivo intacto, sem anexos)', async () => {
    const r = await resolveLinearMentions('explique @src/app.ts', undefined);
    expect(r.items).toEqual([]);
    expect(r.goal).toBe('explique @src/app.ts');
  });
});
