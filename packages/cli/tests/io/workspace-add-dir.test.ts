// EST-0982 · /add-dir — CONFINAMENTO MULTI-RAIZ (gate FORTE do `seguranca`).
//
// Prova, com filesystem REAL (fs-temp, sem modelo):
//  1. ANTES do addRoot, o dir extra é FORA: resolveInside/setCwd rejeitam/clampam
//     (não-regressão do single-root, #68/AG-0009);
//  2. DEPOIS do addRoot (ato do USUÁRIO), ler/editar/navegar no extra FUNCIONA;
//  3. a contenção segue DURA: `..`/symlink/absoluto que escapam TODAS as raízes
//     continuam REJEITADOS — inclusive a partir da raiz extra;
//  4. validação do addRoot: inexistente/arquivo/vazio ⇒ AddRootError claro, nada muda;
//  5. idempotência: re-add e subdir de raiz já autorizada NÃO duplicam;
//  6. setCwd navega ENTRE raízes e clampa na raiz da árvore CORRENTE.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddRootError, NodeWorkspace, WorkspaceEscapeError } from '../../src/io/workspace.js';

describe('EST-0982 · /add-dir — NodeWorkspace multi-raiz', () => {
  let base: string;
  let root: string; // raiz primária (onde o aluy "abriu")
  let extra: string; // dir extra que o usuário autoriza
  let outside: string; // dir que NUNCA é autorizado

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-adddir-'));
    root = join(base, 'project');
    extra = join(base, 'extra');
    outside = join(base, 'outside');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(extra, 'sub'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(extra, 'nota.md'), '# extra\n');
    writeFileSync(join(extra, 'sub', 'b.ts'), 'export const b = 2;\n');
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('ANTES do addRoot o extra é FORA (não-regressão single-root)', () => {
    const ws = new NodeWorkspace({ root });
    expect(() => ws.resolveInside(join(extra, 'nota.md'))).toThrow(WorkspaceEscapeError);
    expect(ws.contains(join(extra, 'nota.md'))).toBe(false);
    // setCwd p/ o extra clampa na raiz primária (não navega p/ fora).
    expect(ws.setCwd(extra)).toBe(realpathSync(root));
    expect(ws.roots).toEqual([realpathSync(root)]);
  });

  it('DEPOIS do addRoot, ler/editar/navegar no extra FUNCIONA', () => {
    const ws = new NodeWorkspace({ root });
    const added = ws.addRoot(extra);
    expect(added).toBe(realpathSync(extra));
    expect(ws.roots).toEqual([realpathSync(root), realpathSync(extra)]);
    // leitura (path existente) e escrita (path AINDA inexistente — edit que cria).
    expect(ws.resolveInside(join(extra, 'nota.md'))).toBe(realpathSync(join(extra, 'nota.md')));
    expect(ws.resolveInside(join(extra, 'novo.txt'))).toBe(join(realpathSync(extra), 'novo.txt'));
    expect(ws.contains(join(extra, 'sub', 'b.ts'))).toBe(true);
    // navegação: cd ABSOLUTO p/ a raiz extra e relativo dentro dela.
    expect(ws.setCwd(extra)).toBe(realpathSync(extra));
    expect(ws.setCwd('sub')).toBe(realpathSync(join(extra, 'sub')));
    // com o cwd no extra, um path RELATIVO resolve contra ele.
    expect(ws.resolveInside('b.ts')).toBe(realpathSync(join(extra, 'sub', 'b.ts')));
  });

  it('a contenção segue DURA a partir da raiz EXTRA: `..` que escapa ⇒ rejeitado', () => {
    const ws = new NodeWorkspace({ root });
    ws.addRoot(extra);
    ws.setCwd(extra);
    // `../outside` escapa TODAS as raízes ⇒ rejeita (mesmo com cwd no extra).
    expect(() => ws.resolveInside('../outside/secret.txt')).toThrow(WorkspaceEscapeError);
    expect(() => ws.resolveInside(join(outside, 'secret.txt'))).toThrow(WorkspaceEscapeError);
    // MAS `../project` (a raiz primária) é AUTORIZADA: navegar entre raízes vale.
    expect(ws.resolveInside(join(root, 'src', 'a.ts'))).toBe(
      realpathSync(join(root, 'src', 'a.ts')),
    );
  });

  it('SYMLINK dentro da raiz extra apontando p/ fora ⇒ rejeitado (canonicaliza)', () => {
    const link = join(extra, 'escape-link');
    symlinkSync(join(outside, 'secret.txt'), link);
    const ws = new NodeWorkspace({ root });
    ws.addRoot(extra);
    expect(() => ws.resolveInside(link)).toThrow(WorkspaceEscapeError);
    expect(ws.contains(link)).toBe(false);
  });

  it('raiz extra adicionada VIA SYMLINK é canonicalizada (realpath vira a raiz)', () => {
    const link = join(base, 'extra-link');
    symlinkSync(extra, link);
    const ws = new NodeWorkspace({ root });
    const added = ws.addRoot(link);
    expect(added).toBe(realpathSync(extra));
    expect(ws.roots).toContain(realpathSync(extra));
    // o acesso funciona pelo path real (o symlink foi resolvido ANTES de virar raiz).
    expect(ws.contains(join(extra, 'nota.md'))).toBe(true);
  });

  it('addRoot VALIDA: inexistente/arquivo/vazio ⇒ AddRootError claro, nada muda', () => {
    const ws = new NodeWorkspace({ root });
    expect(() => ws.addRoot(join(base, 'nao-existe'))).toThrow(AddRootError);
    expect(() => ws.addRoot(join(base, 'nao-existe'))).toThrow(/não existe/);
    expect(() => ws.addRoot(join(extra, 'nota.md'))).toThrow(/não é um diretório/);
    expect(() => ws.addRoot('   ')).toThrow(AddRootError);
    expect(ws.roots).toEqual([realpathSync(root)]); // nada mudou
  });

  it('addRoot é IDEMPOTENTE: re-add e subdir de raiz já autorizada não duplicam', () => {
    const ws = new NodeWorkspace({ root });
    ws.addRoot(extra);
    ws.addRoot(extra); // de novo
    ws.addRoot(join(extra, 'sub')); // subdir já coberto
    ws.addRoot(join(root, 'src')); // subdir da PRIMÁRIA já coberto
    expect(ws.roots).toEqual([realpathSync(root), realpathSync(extra)]);
  });

  it('setCwd clampa na raiz da árvore CORRENTE (cd .. no topo do extra fica no extra)', () => {
    const ws = new NodeWorkspace({ root });
    ws.addRoot(extra);
    ws.setCwd(extra);
    // `..` a partir do topo do extra escaparia TODAS as raízes ⇒ clampa no EXTRA
    // (a árvore corrente), não pula silenciosamente p/ a primária.
    expect(ws.setCwd('..')).toBe(realpathSync(extra));
    expect(ws.setCwd('/etc')).toBe(realpathSync(extra));
    // e voltar à primária por path absoluto continua ok (navegação entre raízes).
    expect(ws.setCwd(root)).toBe(realpathSync(root));
  });

  it('`~` expande p/ a home do usuário no addRoot (conforto do slash)', () => {
    const ws = new NodeWorkspace({ root });
    // a home real existe e é diretório — vira raiz canonicalizada (objeto de teste
    // in-memory; nada é persistido).
    const home = ws.addRoot('~');
    expect(home).toBe(realpathSync(process.env.HOME ?? home));
  });
});
