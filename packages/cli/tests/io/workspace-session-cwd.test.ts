// EST-0982 — DIRETÓRIO DE TRABALHO DE SESSÃO (`sessionCwd`) no NodeWorkspace.
//
// Prova o cwd de sessão SEM relaxar o confinamento:
//   • default = raiz; `setCwd(subdir)` move o cwd;
//   • um path RELATIVO em `resolveInside` resolve contra o `sessionCwd` (não a raiz);
//   • `cd ..`/`cd /etc` além da raiz é CLAMPADO na raiz (NUNCA escapa);
//   • `resolveInside` continua barrando escapes de FS (`..`/absoluto/symlink) — o
//     gate DURO é a raiz, o cwd só muda a ORIGEM do relativo.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeWorkspace, WorkspaceEscapeError } from '../../src/io/workspace.js';

describe('NodeWorkspace — sessionCwd (EST-0982)', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-cwd-'));
    root = join(base, 'project');
    outside = join(base, 'outside');
    mkdirSync(join(root, 'ecommerce-app', 'data'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n');
  });

  afterEach(() => {
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('o cwd ARRANCA na raiz (não-regressão até o 1º change_dir)', () => {
    const ws = new NodeWorkspace({ root });
    expect(ws.cwd).toBe(realpathSync(root));
    expect(ws.cwd).toBe(ws.root);
  });

  it('setCwd(subdir) move o sessionCwd p/ a subpasta', () => {
    const ws = new NodeWorkspace({ root });
    const next = ws.setCwd('ecommerce-app');
    expect(next).toBe(join(realpathSync(root), 'ecommerce-app'));
    expect(ws.cwd).toBe(join(realpathSync(root), 'ecommerce-app'));
  });

  it('um path RELATIVO resolve contra o sessionCwd, NÃO contra a raiz', () => {
    const ws = new NodeWorkspace({ root });
    ws.setCwd('ecommerce-app');
    // `data/x.json` (ainda inexistente) resolve em <root>/ecommerce-app/data/x.json.
    const resolved = ws.resolveInside('data/x.json');
    expect(resolved).toBe(join(realpathSync(root), 'ecommerce-app', 'data', 'x.json'));
    // E NÃO no <root>/data/x.json (o bug que a estória conserta).
    expect(resolved).not.toBe(join(realpathSync(root), 'data', 'x.json'));
  });

  it('setCwd é RELATIVO ao cwd corrente (cd encadeado)', () => {
    const ws = new NodeWorkspace({ root });
    ws.setCwd('ecommerce-app');
    ws.setCwd('data'); // relativo ao ecommerce-app, não à raiz
    expect(ws.cwd).toBe(join(realpathSync(root), 'ecommerce-app', 'data'));
  });

  it('`cd ..` volta um nível (ainda dentro da raiz)', () => {
    const ws = new NodeWorkspace({ root });
    ws.setCwd('ecommerce-app/data');
    ws.setCwd('..');
    expect(ws.cwd).toBe(join(realpathSync(root), 'ecommerce-app'));
  });

  it('CONFINAMENTO — `cd ..` no TOPO é CLAMPADO na raiz (não escapa)', () => {
    const ws = new NodeWorkspace({ root });
    const next = ws.setCwd('..'); // tentaria sair da raiz
    expect(next).toBe(realpathSync(root)); // clampado na raiz
    expect(ws.cwd).toBe(realpathSync(root));
  });

  it('CONFINAMENTO — `cd ../../..` (subir muito) é CLAMPADO na raiz', () => {
    const ws = new NodeWorkspace({ root });
    ws.setCwd('src');
    const next = ws.setCwd('../../../../..');
    expect(next).toBe(realpathSync(root));
  });

  it('CONFINAMENTO — `cd /etc` (absoluto fora) é CLAMPADO na raiz (não escapa)', () => {
    const ws = new NodeWorkspace({ root });
    const next = ws.setCwd('/etc');
    expect(next).toBe(realpathSync(root)); // não vai p/ /etc
  });

  it('CONFINAMENTO — `cd ../outside` (irmão fora da raiz) é CLAMPADO na raiz', () => {
    const ws = new NodeWorkspace({ root });
    const next = ws.setCwd('../outside');
    expect(next).toBe(realpathSync(root));
  });

  it('setCwd LANÇA p/ um diretório inexistente (não navega às cegas)', () => {
    const ws = new NodeWorkspace({ root });
    expect(() => ws.setCwd('nao-existe')).toThrow(WorkspaceEscapeError);
    // o cwd NÃO mudou (fail-safe).
    expect(ws.cwd).toBe(realpathSync(root));
  });

  it('setCwd LANÇA p/ um ARQUIVO (cd só entra em diretório)', () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'x\n');
    const ws = new NodeWorkspace({ root });
    expect(() => ws.setCwd('src/a.ts')).toThrow(WorkspaceEscapeError);
  });

  it('CONFINAMENTO — cd num SYMLINK de dir que aponta p/ FORA é clampado na raiz', () => {
    // symlink DENTRO da raiz apontando p/ o `outside` (fora). canonicaliza p/ fora ⇒
    // o setCwd CLAMPA na raiz (o cwd não vai morar fora via symlink).
    symlinkSync(outside, join(root, 'escape-dir'));
    const ws = new NodeWorkspace({ root });
    const next = ws.setCwd('escape-dir');
    expect(next).toBe(realpathSync(root)); // não foi p/ o outside
  });

  it('o gate DURO de FS segue valendo após cd: relativo que ESCAPA ainda é rejeitado', () => {
    const ws = new NodeWorkspace({ root });
    ws.setCwd('ecommerce-app');
    // de dentro do ecommerce-app, um `../../outside` resolveria FORA da raiz ⇒ rejeita.
    expect(() => ws.resolveInside('../../outside/secret.txt')).toThrow(WorkspaceEscapeError);
    // absoluto fora segue rejeitado.
    expect(() => ws.resolveInside(join(outside, 'secret.txt'))).toThrow(WorkspaceEscapeError);
  });
});
