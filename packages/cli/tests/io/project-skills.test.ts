// EST-1112 · ADR-0116 (proposto) — ProjectSkillsLoader: load() confinado.
//   - load() com SKILL.md VÁLIDO ⇒ skill com origin='project'
//   - precedência: `.claude/skills/` antes de `.aluy/skills/`; colisão ⇒ 1ª pasta vence
//   - RES-MD-3 (corpo vazio) ⇒ erro, NÃO entra em skills
//   - pasta ausente ⇒ { skills: [], errors: [] } (fail-safe)
//   - subdir sem SKILL.md ⇒ ignorado

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectSkillsLoader, PROJECT_SKILLS_DIRNAMES } from '../../src/io/project-skills.js';
import { SKILL_MANIFEST } from '../../src/io/user-skills.js';
import { NodeWorkspace } from '../../src/io/workspace.js';

describe('EST-1112 · ProjectSkillsLoader — load confinado', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aluy-ps-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeLoader(): ProjectSkillsLoader {
    return new ProjectSkillsLoader({ workspace: new NodeWorkspace({ root }) });
  }

  function writeSkill(base: string, name: string, body: string): void {
    const dir = join(root, base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SKILL_MANIFEST), body);
  }

  it('SKILL.md válido em .claude/skills ⇒ skill com origin=project', () => {
    writeSkill(PROJECT_SKILLS_DIRNAMES[0]!, 'my-skill', '---\nname: my-skill\n---\ninstruções');
    const { skills, errors } = makeLoader().load();
    expect(errors).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('my-skill');
    expect(skills[0]!.origin).toBe('project');
  });

  it('lê de ambas as pastas; colisão de name ⇒ .claude/skills (1ª) vence', () => {
    writeSkill(PROJECT_SKILLS_DIRNAMES[0]!, 'dup', '---\nname: dup\n---\ncorpo CLAUDE');
    writeSkill(PROJECT_SKILLS_DIRNAMES[1]!, 'dup', '---\nname: dup\n---\ncorpo ALUY');
    writeSkill(PROJECT_SKILLS_DIRNAMES[1]!, 'so-aluy', '---\nname: so-aluy\n---\ncorpo');
    const { skills } = makeLoader().load();
    const dup = skills.find((s) => s.name === 'dup');
    expect(dup!.instructions).toContain('CLAUDE');
    expect(skills.map((s) => s.name).sort()).toEqual(['dup', 'so-aluy']);
  });

  it('RES-MD-3: corpo vazio ⇒ erro coletado, NÃO entra', () => {
    writeSkill(PROJECT_SKILLS_DIRNAMES[0]!, 'boa', '---\nname: boa\n---\ncorpo');
    writeSkill(PROJECT_SKILLS_DIRNAMES[0]!, 'ruim', '---\nname: ruim\n---\n');
    const { skills, errors } = makeLoader().load();
    expect(skills.map((s) => s.name)).toEqual(['boa']);
    expect(errors).toHaveLength(1);
  });

  it('subdir sem SKILL.md é ignorado', () => {
    mkdirSync(join(root, PROJECT_SKILLS_DIRNAMES[0]!, 'vazio'), { recursive: true });
    writeSkill(PROJECT_SKILLS_DIRNAMES[0]!, 'ok', '---\nname: ok\n---\ncorpo');
    const { skills } = makeLoader().load();
    expect(skills.map((s) => s.name)).toEqual(['ok']);
  });

  it('pasta ausente ⇒ { skills: [], errors: [] } sem lançar', () => {
    const { skills, errors } = makeLoader().load();
    expect(skills).toEqual([]);
    expect(errors).toEqual([]);
  });
});
