// EST-0948 — CONFINAMENTO DE WORKSPACE REAL (cravada do seguranca, gate FORTE).
// Prova que `..`, path absoluto fora e symlink que escapa são REJEITADOS, e que
// paths legítimos dentro da raiz (incl. arquivo ainda inexistente) passam.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeWorkspace, WorkspaceEscapeError } from '../../src/io/workspace.js';

describe('NodeWorkspace — confinamento de workspace REAL', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-ws-'));
    root = join(base, 'project');
    outside = join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n');
  });

  afterEach(() => {
    // limpa o tmp pai
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('aceita um path RELATIVO dentro da raiz', () => {
    const ws = new NodeWorkspace({ root });
    const resolved = ws.resolveInside('src/a.ts');
    expect(resolved).toBe(realpathSync(join(root, 'src', 'a.ts')));
    expect(ws.contains('src/a.ts')).toBe(true);
  });

  it('aceita um arquivo AINDA INEXISTENTE dentro da raiz (edit que cria)', () => {
    const ws = new NodeWorkspace({ root });
    const resolved = ws.resolveInside('src/novo.ts');
    expect(resolved).toBe(join(realpathSync(root), 'src', 'novo.ts'));
  });

  it('REJEITA `..` que escapa a raiz', () => {
    const ws = new NodeWorkspace({ root });
    expect(() => ws.resolveInside('../outside/secret.txt')).toThrow(WorkspaceEscapeError);
    expect(ws.contains('../outside/secret.txt')).toBe(false);
  });

  it('REJEITA `..` aninhado que sobe e volta p/ fora', () => {
    const ws = new NodeWorkspace({ root });
    expect(() => ws.resolveInside('src/../../outside/secret.txt')).toThrow(WorkspaceEscapeError);
  });

  it('REJEITA path ABSOLUTO fora da raiz', () => {
    const ws = new NodeWorkspace({ root });
    expect(() => ws.resolveInside(join(outside, 'secret.txt'))).toThrow(WorkspaceEscapeError);
  });

  it('REJEITA SYMLINK que aponta p/ fora da raiz (canonicaliza e checa)', () => {
    // cria um symlink DENTRO da raiz apontando p/ um arquivo FORA.
    const link = join(root, 'escape-link');
    symlinkSync(join(outside, 'secret.txt'), link);
    const ws = new NodeWorkspace({ root });
    // o path textual está "dentro", mas canonicaliza p/ fora ⇒ rejeita.
    expect(() => ws.resolveInside('escape-link')).toThrow(WorkspaceEscapeError);
    expect(ws.contains('escape-link')).toBe(false);
  });

  it('REJEITA symlink de DIRETÓRIO que aponta p/ fora (via path dentro dele)', () => {
    const linkDir = join(root, 'escape-dir');
    symlinkSync(outside, linkDir);
    const ws = new NodeWorkspace({ root });
    expect(() => ws.resolveInside('escape-dir/secret.txt')).toThrow(WorkspaceEscapeError);
  });

  // FAIL-CLOSED (bug-hunt EST-0948) — SYMLINK PENDENTE (dangling) p/ FORA. Um link
  // DENTRO da raiz apontando p/ um arquivo FORA que AINDA NÃO existe: `realpathSync`
  // lança ENOENT (o ALVO não existe), e a reconstrução léxica devolvia o caminho do
  // próprio link — aprovado como "dentro" — mas uma ESCRITA segue o link e cai FORA.
  // Era um escape de confinamento (write_file gravava fora da raiz). Deve REJEITAR.
  it('REJEITA symlink PENDENTE (alvo inexistente) que aponta p/ fora da raiz', () => {
    const link = join(root, 'dangling-out');
    // alvo FORA da raiz e AINDA INEXISTENTE (o link é dangling).
    symlinkSync(join(outside, 'planted.txt'), link);
    const ws = new NodeWorkspace({ root });
    expect(() => ws.resolveInside('dangling-out')).toThrow(WorkspaceEscapeError);
    expect(ws.contains('dangling-out')).toBe(false);
  });

  it('REJEITA symlink de DIR PENDENTE p/ fora, ao criar arquivo novo sob ele', () => {
    // link de DIRETÓRIO p/ `outside` (existe), mas o arquivo-folha sob ele é novo.
    symlinkSync(outside, join(root, 'dangling-dir'));
    const ws = new NodeWorkspace({ root });
    expect(() => ws.resolveInside('dangling-dir/novo.ts')).toThrow(WorkspaceEscapeError);
  });

  it('REJEITA symlink PENDENTE RELATIVO (../outside) p/ fora da raiz', () => {
    symlinkSync('../outside/planted.txt', join(root, 'rel-dangling'));
    const ws = new NodeWorkspace({ root });
    expect(() => ws.resolveInside('rel-dangling')).toThrow(WorkspaceEscapeError);
  });

  it('ACEITA symlink PENDENTE que aponta p/ DENTRO da raiz (alvo a ser criado)', () => {
    // link pendente p/ um alvo INTERNO ainda inexistente: criação legítima — passa.
    symlinkSync(join(root, 'src', 'real-target.ts'), join(root, 'dangling-in'));
    const ws = new NodeWorkspace({ root });
    const resolved = ws.resolveInside('dangling-in');
    expect(resolved).toBe(join(realpathSync(root), 'src', 'real-target.ts'));
    expect(ws.contains('dangling-in')).toBe(true);
  });

  it('REJEITA path vazio', () => {
    const ws = new NodeWorkspace({ root });
    expect(() => ws.resolveInside('')).toThrow(WorkspaceEscapeError);
  });

  it('a raiz é canonicalizada (root absoluto e estável)', () => {
    const ws = new NodeWorkspace({ root });
    expect(ws.root).toBe(realpathSync(root));
  });
});
