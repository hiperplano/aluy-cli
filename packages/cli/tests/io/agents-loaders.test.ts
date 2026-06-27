// EST-0977 · ADR-0061 · CLI-SEC-11 — LOADERS confinados dos agentes-`.md` (gate FORTE).
//
// Bateria:
//  - GLOBAL `~/.aluy/agents/*.md` (origin='global') + PROJETO `.claude/agents/*.md`
//    + `.aluy/agents/*.md` (origin='project', confinado ao workspace).
//  - RES-MD-3 (FALHA FECHADA): `.md` malformado / `tools` ilegível é COLETADO em
//    `errors` (carga visível) — NÃO vira agente sem restrição (não entra em `profiles`).
//  - CONFINAMENTO: symlink p/ fora da raiz NÃO é lido (config de projeto = DADO).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { UserAgentsLoader, AGENTS_DIRNAME } from '../../src/io/user-agents.js';
import { ProjectAgentsLoader } from '../../src/io/project-agents.js';

describe('EST-0977 · UserAgentsLoader — ~/.aluy/agents/*.md (global)', () => {
  let base: string;
  let agentsDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-uagents-'));
    agentsDir = join(base, AGENTS_DIRNAME);
    mkdirSync(agentsDir, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function write(name: string, body: string): void {
    writeFileSync(join(agentsDir, name), body);
  }

  it('descobre revisor.md como agente GLOBAL (origin=global) com persona/tools/model', () => {
    write(
      'revisor.md',
      '---\nname: revisor\ndescription: revisa\ntools: read_file, grep\nmodel: sonnet\n---\nVocê é o revisor.',
    );
    const { profiles, errors } = new UserAgentsLoader({ baseDir: base }).load();
    expect(errors).toEqual([]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.name).toBe('revisor');
    expect(profiles[0]!.origin).toBe('global');
    expect(profiles[0]!.tools).toEqual(['read_file', 'grep']);
    expect(profiles[0]!.systemPrompt).toContain('revisor');
  });

  it('dir ausente ⇒ vazio (fail-safe)', () => {
    rmSync(agentsDir, { recursive: true, force: true });
    expect(new UserAgentsLoader({ baseDir: base }).load()).toEqual({ profiles: [], errors: [] });
  });

  it('RES-MD-3 — `tools` ilegível ⇒ erro COLETADO, NÃO entra em profiles', () => {
    write('bom.md', '---\nname: bom\n---\ncorpo');
    write('ruim.md', '---\nname: ruim\ntools:\n---\ncorpo'); // tools presente-vazio
    const { profiles, errors } = new UserAgentsLoader({ baseDir: base }).load();
    expect(profiles.map((p) => p.name)).toEqual(['bom']); // ruim NÃO entra
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toMatch(/não carregado|inválida/);
  });
});

describe('EST-0977 · ProjectAgentsLoader — .claude/agents/*.md confinado (projeto)', () => {
  let base: string;
  let root: string;
  let claudeDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-pagents-'));
    root = join(base, 'project');
    claudeDir = join(root, '.claude/agents');
    mkdirSync(claudeDir, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function loader(): ProjectAgentsLoader {
    return new ProjectAgentsLoader({ workspace: new NodeWorkspace({ root }) });
  }

  it('.claude/agents/x.md ⇒ agente de PROJETO (origin=project)', () => {
    writeFileSync(join(claudeDir, 'x.md'), '---\nname: x\n---\npersona de projeto');
    const { profiles } = loader().load();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.origin).toBe('project');
  });

  it('.aluy/agents/ de PROJETO É lido (ADR-0113 carve-out no path-deny)', () => {
    // ADR-0113: o carve-out de path-deny agora permite `.aluy/agents/` de workspace.
    // A fonte global do Aluy é `~/.aluy/agents/` (UserAgentsLoader); a compat de
    // projeto inclui `.claude/agents/` + `.aluy/agents/`.
    const aluyDir = join(root, '.aluy/agents');
    mkdirSync(aluyDir, { recursive: true });
    writeFileSync(join(aluyDir, 'y.md'), '---\nname: y\n---\npersona de .aluy');
    const names = loader()
      .load()
      .profiles.map((p) => p.name);
    expect(names).toContain('y');
  });

  it('.claude/agents/ tem precedência sobre .aluy/agents/ em colisão de name', () => {
    const claudeDir2 = join(root, '.claude/agents');
    const aluyDir2 = join(root, '.aluy/agents');
    mkdirSync(aluyDir2, { recursive: true });
    // Mesmo `name` nas duas pastas — a 1ª (`.claude/agents/`) vence.
    writeFileSync(join(claudeDir2, 'colide.md'), '---\nname: colide\n---\nclaude vence');
    writeFileSync(join(aluyDir2, 'colide.md'), '---\nname: colide\n---\naluy perde');
    const { profiles } = loader().load();
    const c = profiles.find((p) => p.name === 'colide')!;
    expect(c.systemPrompt).toContain('claude vence');
  });

  it('CONFINAMENTO — symlink p/ FORA da raiz NÃO é lido', () => {
    const outside = join(base, 'evil.md');
    writeFileSync(outside, '---\nname: evil\n---\nFORA');
    symlinkSync(outside, join(claudeDir, 'evil.md'));
    writeFileSync(join(claudeDir, 'legit.md'), '---\nname: legit\n---\ndentro');
    const names = loader()
      .load()
      .profiles.map((p) => p.name);
    expect(names).toEqual(['legit']); // o symlink p/ fora é ignorado.
  });

  it('RES-MD-3 — `.md` malformado de projeto ⇒ erro coletado, não entra', () => {
    writeFileSync(join(claudeDir, 'sem-nome.md'), '---\ndescription: x\n---\ncorpo');
    const { profiles, errors } = loader().load();
    expect(profiles).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
