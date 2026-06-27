// EST-1112 · ADR-0116 (proposto) — `aluy skills` (shell): lista as SKILLS (SKILL.md)
// mapeadas das DUAS camadas (global + projeto/cwd), via os MESMOS loaders confinados,
// sem tocar a home real, sem modelo, sem rede. Bateria:
//  - 1 válida + 1 rejeitada ⇒ as duas saem (válida c/ nome/escopo/desc; rejeitada c/ motivo).
//  - pasta ausente ⇒ "nenhuma" (loader fail-safe).
//  - projeto + global ⇒ AMBOS os escopos na saída.
//  - exit 0 SEMPRE (listagem, não gate).
//  - fallback dos loaders reais ⇒ 0 sem lançar.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSkills } from '../../src/commands/skills.js';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { UserSkillsLoader, SKILLS_DIRNAME, SKILL_MANIFEST } from '../../src/io/user-skills.js';
import { ProjectSkillsLoader, PROJECT_SKILLS_DIRNAMES } from '../../src/io/project-skills.js';

function run(opts: { globalBase?: string; projectRoot?: string }): {
  code: number;
  out: string[];
} {
  const out: string[] = [];
  const code = runSkills({
    out: (l) => out.push(l),
    ...(opts.globalBase !== undefined
      ? { loadGlobal: () => new UserSkillsLoader({ baseDir: opts.globalBase! }).load() }
      : { loadGlobal: () => ({ skills: [], errors: [] }) }),
    ...(opts.projectRoot !== undefined
      ? {
          loadProject: () =>
            new ProjectSkillsLoader({
              workspace: new NodeWorkspace({ root: opts.projectRoot! }),
            }).load(),
        }
      : { loadProject: () => ({ skills: [], errors: [] }) }),
  });
  return { code, out };
}

describe('EST-1112 · aluy skills (shell)', () => {
  let globalBase: string;
  let globalSkillsDir: string;
  let projectRoot: string;

  beforeEach(() => {
    globalBase = mkdtempSync(join(tmpdir(), 'aluy-skills-g-'));
    globalSkillsDir = join(globalBase, SKILLS_DIRNAME);
    mkdirSync(globalSkillsDir, { recursive: true });
    projectRoot = mkdtempSync(join(tmpdir(), 'aluy-skills-p-'));
  });
  afterEach(() => {
    rmSync(globalBase, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeGlobal(name: string, body: string): void {
    const dir = join(globalSkillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SKILL_MANIFEST), body);
  }
  function writeProject(name: string, body: string): void {
    const dir = join(projectRoot, PROJECT_SKILLS_DIRNAMES[0]!, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SKILL_MANIFEST), body);
  }

  it('1 válida + 1 rejeitada ⇒ lista as duas com detalhe e motivo, exit 0', () => {
    writeGlobal('pdf-fill', '---\nname: pdf-fill\ndescription: Preenche PDFs.\n---\ninstruções');
    writeGlobal('quebrada', '---\nname: quebrada\n---\n'); // corpo vazio ⇒ RES-MD-3

    const { code, out } = run({ globalBase });
    const t = out.join('\n');

    expect(code).toBe(0);
    // válida numa LINHA de tabela com bordas (skill · escopo · sobre).
    const rowPdf = out.find((l) => l.includes('pdf-fill'))!;
    expect(rowPdf).toContain('pdf-fill');
    expect(rowPdf).toContain('global');
    expect(t).toContain('Preenche PDFs.');
    expect(t).toContain('quebrada');
    expect(t).toMatch(/conserto/);
  });

  it('pasta ausente ⇒ "nenhuma", exit 0', () => {
    rmSync(globalSkillsDir, { recursive: true, force: true });
    const { code, out } = run({ globalBase });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('nenhuma skill mapeada');
  });

  it('projeto + global ⇒ AMBOS os escopos aparecem', () => {
    writeGlobal('g-skill', '---\nname: gskill\ndescription: global\n---\ncorpo');
    writeProject('p-skill', '---\nname: pskill\ndescription: project\n---\ncorpo');

    const { code, out } = run({ globalBase, projectRoot });
    const t = out.join('\n');
    expect(code).toBe(0);
    const rowG = out.find((l) => l.includes('gskill'))!;
    const rowP = out.find((l) => l.includes('pskill'))!;
    expect(rowG).toContain('global');
    expect(rowP).toContain('projeto');
  });

  it('SÓ rejeitadas ⇒ ainda exit 0 (listagem, não gate)', () => {
    writeGlobal('x', '---\nname: x\n---\n');
    const { code, out } = run({ globalBase });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('rejeitadas (1)');
  });

  it('fallback dos loaders reais: sem injeção, retorna 0 sem lançar', () => {
    const sink: string[] = [];
    expect(() => {
      const code = runSkills({ out: (l) => sink.push(l) });
      expect(code).toBe(0);
    }).not.toThrow();
    expect(sink.length).toBeGreaterThan(0);
  });
});
