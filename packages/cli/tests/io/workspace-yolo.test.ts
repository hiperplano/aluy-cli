// EST-0991 · ADR-0072 — YOLO DERRUBA a cerca de FS (root-set `{ '/' }`, disco inteiro).
//
// Prova que, sob `unconfined:true` (derivado do `--yolo`), o `NodeWorkspace`:
//   • aceita um path FORA do cwd do projeto (root passa a ser a raiz do filesystem);
//   • MANTÉM a canonicalização (realpath/symlink/`..`) — não é "desligar o port",
//     é "a raiz é a raiz do FS" (sem TOCTOU bug, só sem a cerca);
//   • arranca o `sessionCwd` no DIRETÓRIO DO PROJETO (não em `/`).
// E a NÃO-REGRESSÃO FORTE: SEM `unconfined`, a cerca de 1 raiz (EST-0948) confina
// exatamente como antes (path fora ⇒ WorkspaceEscapeError).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse as parsePath } from 'node:path';
import { NodeWorkspace, WorkspaceEscapeError } from '../../src/io/workspace.js';

describe('NodeWorkspace · ADR-0072 — YOLO (unconfined) = disco inteiro', () => {
  let base: string;
  let project: string;
  let outside: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-yolo-'));
    project = join(base, 'project');
    outside = join(base, 'outside');
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('NÃO-REGRESSÃO — SEM YOLO, path fora do projeto ⇒ WorkspaceEscapeError', () => {
    const ws = new NodeWorkspace({ root: project });
    expect(() => ws.resolveInside('../outside/secret.txt')).toThrow(WorkspaceEscapeError);
    expect(ws.contains(join(outside, 'secret.txt'))).toBe(false);
  });

  it('YOLO — a RAIZ vira a raiz do filesystem (root-set `/`)', () => {
    const ws = new NodeWorkspace({ root: project, unconfined: true });
    expect(ws.root).toBe(realpathSync(parsePath(realpathSync(project)).root));
  });

  it('YOLO — path FORA do projeto antigo PASSA (disco inteiro)', () => {
    const ws = new NodeWorkspace({ root: project, unconfined: true });
    const target = join(outside, 'secret.txt');
    expect(() => ws.resolveInside(target)).not.toThrow();
    expect(ws.resolveInside(target)).toBe(realpathSync(target));
    expect(ws.contains(target)).toBe(true);
    // path absoluto arbitrário (ex.: /etc) também é "dentro" da raiz `/`.
    expect(ws.contains('/etc')).toBe(true);
  });

  it('YOLO — a CANONICALIZAÇÃO permanece (realpath/`..` resolvidos, sem TOCTOU bug)', () => {
    const ws = new NodeWorkspace({ root: project, unconfined: true });
    // `..` ainda é resolvido lexicamente/realpath — o resultado é o caminho canônico,
    // não a string crua. Prova que o port NÃO foi "desligado": ele ainda canonicaliza.
    const viaDotDot = ws.resolveInside(join(project, 'src', '..', 'src', 'a.ts'));
    expect(viaDotDot).toBe(realpathSync(join(project, 'src', 'a.ts')));
  });

  it('YOLO — o sessionCwd ARRANCA no diretório do projeto (não em `/`)', () => {
    const ws = new NodeWorkspace({ root: project, unconfined: true });
    expect(ws.cwd).toBe(realpathSync(project));
  });

  it('YOLO — change_dir p/ FORA do projeto antigo agora navega (não clampa)', () => {
    const ws = new NodeWorkspace({ root: project, unconfined: true });
    const moved = ws.setCwd(outside);
    expect(moved).toBe(realpathSync(outside));
    expect(ws.cwd).toBe(realpathSync(outside));
    // e um relativo a partir daí resolve no novo cwd (fora do projeto).
    expect(ws.resolveInside('secret.txt')).toBe(realpathSync(join(outside, 'secret.txt')));
  });
});
