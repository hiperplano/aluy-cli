// EST-1105 · ADR-0113 — LOADER CONFINADO dos workflows de PROJETO
// (`.claude/workflows/*.md` + `.aluy/workflows/*.md`, carve-out).
// Mesmo mecanismo do `ProjectAgentsLoader`; config de projeto = DADO confinado.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeWorkspace } from '../../src/io/workspace.js';
import {
  ProjectWorkflowsLoader,
  PROJECT_WORKFLOWS_DIRNAMES,
} from '../../src/io/project-workflows.js';

function makeLoader(root: string): ProjectWorkflowsLoader {
  return new ProjectWorkflowsLoader({ workspace: new NodeWorkspace({ root }) });
}

describe('EST-1105 · ADR-0113 — ProjectWorkflowsLoader (.claude/ + .aluy/ workflows)', () => {
  let base: string;
  let root: string;
  let claudeWfDir: string;
  let aluyWfDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-pwf-'));
    root = join(base, 'project');
    claudeWfDir = join(root, PROJECT_WORKFLOWS_DIRNAMES[0]);
    aluyWfDir = join(root, PROJECT_WORKFLOWS_DIRNAMES[1]);
    mkdirSync(claudeWfDir, { recursive: true });
    mkdirSync(aluyWfDir, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function writeClaude(name: string, body: string): void {
    writeFileSync(join(claudeWfDir, name), body);
  }
  function writeAluy(name: string, body: string): void {
    writeFileSync(join(aluyWfDir, name), body);
  }

  // ── .claude/workflows ──────────────────────────────────────────────────

  it('.claude/workflows/x.md ⇒ workflow de PROJETO (origin=project)', () => {
    writeClaude(
      'sdlc.md',
      [
        '---',
        'name: sdlc',
        'description: Fluxo',
        '---',
        '1. entender — Leia.',
        '2. implementar — Code.',
      ].join('\n'),
    );
    const { workflows, errors } = makeLoader(root).load();
    expect(errors).toEqual([]);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]!.name).toBe('sdlc');
    expect(workflows[0]!.origin).toBe('project');
    expect(workflows[0]!.activities).toHaveLength(2);
  });

  it('dirs ausentes ⇒ vazio (fail-safe, sem crash)', () => {
    rmSync(claudeWfDir, { recursive: true, force: true });
    rmSync(aluyWfDir, { recursive: true, force: true });
    expect(makeLoader(root).load()).toEqual({ workflows: [], errors: [] });
  });

  it('CONFINAMENTO — symlink p/ FORA da raiz NÃO é lido', () => {
    const outside = join(base, 'evil.md');
    writeFileSync(outside, '---\nname: evil\n---\n1. a — FORA');
    symlinkSync(outside, join(claudeWfDir, 'evil.md'));
    writeClaude('ok.md', '---\nname: ok\n---\n1. a — dentro');
    const names = makeLoader(root)
      .load()
      .workflows.map((w) => w.name);
    expect(names).toEqual(['ok']);
  });

  it('RES-MD-3 — .md malformado ⇒ erro coletado, NÃO entra', () => {
    writeClaude('sem-nome.md', '---\ndescription: x\n---\n1. a — goal');
    const { workflows, errors } = makeLoader(root).load();
    expect(workflows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toMatch(/sem "name"/);
  });

  // ── ADR-0113: .aluy/workflows carve-out ────────────────────────────────

  it('.aluy/workflows/x.md ⇒ workflow de PROJETO (origin=project, carve-out)', () => {
    rmSync(claudeWfDir, { recursive: true, force: true });
    writeAluy(
      'deploy.md',
      ['---', 'name: deploy', '---', '1. build — npm run build', '2. push — git push'].join('\n'),
    );
    const { workflows, errors } = makeLoader(root).load();
    expect(errors).toEqual([]);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]!.name).toBe('deploy');
    expect(workflows[0]!.origin).toBe('project');
  });

  it('.claude/workflows/ tem precedência sobre .aluy/workflows/ em colisão', () => {
    writeClaude('shared.md', '---\nname: shared\n---\n1. a — claude vence');
    writeAluy('shared.md', '---\nname: shared\n---\n1. a — aluy perde');
    const { workflows } = makeLoader(root).load();
    const shared = workflows.find((w) => w.name === 'shared')!;
    expect(shared.activities[0]!.goal).toContain('claude vence');
  });

  it('carrega workflows de AMBAS as pastas (união)', () => {
    writeClaude('a.md', '---\nname: a\n---\n1. a — A');
    writeAluy('b.md', '---\nname: b\n---\n1. a — B');
    const names = makeLoader(root)
      .load()
      .workflows.map((w) => w.name)
      .sort();
    expect(names).toEqual(['a', 'b']);
  });

  it('.aluy/workflows/ com symlink p/ FORA ⇒ ignorado (confinamento)', () => {
    rmSync(claudeWfDir, { recursive: true, force: true });
    const outside = join(base, 'evil.md');
    writeFileSync(outside, '---\nname: evil\n---\n1. a — FORA');
    symlinkSync(outside, join(aluyWfDir, 'evil.md'));
    writeAluy('ok.md', '---\nname: ok\n---\n1. a — dentro');
    const names = makeLoader(root)
      .load()
      .workflows.map((w) => w.name);
    expect(names).toEqual(['ok']);
  });
});
