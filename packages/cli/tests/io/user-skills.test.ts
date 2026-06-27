// EST-1112 · ADR-0116 (proposto) — UserSkillsLoader: ensureDir + load().
// A unidade de descoberta é um DIRETÓRIO por skill (`~/.aluy/skills/<nome>/SKILL.md`):
//   - ensureDir() cria o dir com mode 0700 (best-effort, nunca lança)
//   - load() com SKILL.md VÁLIDO devolve a skill (origin='global'), name herdado da pasta
//   - load() com SKILL.md MALFORMADO (RES-MD-3) ⇒ erro, NÃO entra em skills
//   - subdir SEM SKILL.md ⇒ ignorado em silêncio (não é skill)
//   - DIR AUSENTE ⇒ { skills: [], errors: [] } (fail-safe)
//   - arquivo solto (não-dir) na raiz de skills/ é ignorado
//   - colisão de name (frontmatter igual) ⇒ 1º (alfabético) vence

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserSkillsLoader, SKILLS_DIRNAME, SKILL_MANIFEST } from '../../src/io/user-skills.js';

describe('EST-1112 · UserSkillsLoader — ensureDir + load', () => {
  let base: string;
  let skillsDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-us-'));
    skillsDir = join(base, SKILLS_DIRNAME);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function writeSkill(name: string, body: string): void {
    const dir = join(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SKILL_MANIFEST), body);
  }

  describe('ensureDir()', () => {
    it('cria o dir de skills quando ausente, idempotente, best-effort', () => {
      const loader = new UserSkillsLoader({ baseDir: base });
      expect(existsSync(skillsDir)).toBe(false);
      loader.ensureDir();
      expect(existsSync(skillsDir)).toBe(true);
      expect(() => loader.ensureDir()).not.toThrow();
    });

    it('best-effort — não lança se o caminho já existe como arquivo', () => {
      writeFileSync(skillsDir, 'not-a-dir', { flag: 'wx' });
      expect(() => new UserSkillsLoader({ baseDir: base }).ensureDir()).not.toThrow();
    });
  });

  describe('load() — SKILL.md válido', () => {
    it('devolve a skill com origin=global e name herdado da pasta', () => {
      writeSkill('pdf-fill', '---\ndescription: preenche pdf\n---\nleia o template ao lado');
      const { skills, errors } = new UserSkillsLoader({ baseDir: base }).load();
      expect(errors).toEqual([]);
      expect(skills).toHaveLength(1);
      expect(skills[0]!.name).toBe('pdf-fill');
      expect(skills[0]!.origin).toBe('global');
      expect(skills[0]!.description).toBe('preenche pdf');
      expect(skills[0]!.instructions).toContain('template');
    });

    it('carrega múltiplas skills ordenadas por nome de pasta', () => {
      writeSkill('b-skill', '---\nname: beta\n---\ncorpo b');
      writeSkill('a-skill', '---\nname: alfa\n---\ncorpo a');
      const { skills } = new UserSkillsLoader({ baseDir: base }).load();
      expect(skills.map((s) => s.name)).toEqual(['alfa', 'beta']);
    });

    it('frontmatter name VENCE o nome da pasta', () => {
      writeSkill('pasta-x', '---\nname: nome-real\n---\ncorpo');
      const { skills } = new UserSkillsLoader({ baseDir: base }).load();
      expect(skills[0]!.name).toBe('nome-real');
    });
  });

  describe('load() — RES-MD-3 (fail-closed)', () => {
    it('SKILL.md com corpo vazio ⇒ erro coletado, NÃO entra em skills', () => {
      writeSkill('boa', '---\nname: boa\n---\ncorpo');
      writeSkill('ruim', '---\nname: ruim\n---\n');
      const { skills, errors } = new UserSkillsLoader({ baseDir: base }).load();
      expect(skills.map((s) => s.name)).toEqual(['boa']);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.reason).toMatch(/corpo vazio|sem instruções/);
    });
  });

  describe('load() — subdir sem SKILL.md / fail-safe', () => {
    it('subdir SEM SKILL.md é ignorado em silêncio (não é skill)', () => {
      mkdirSync(join(skillsDir, 'so-recursos'), { recursive: true });
      writeFileSync(join(skillsDir, 'so-recursos', 'template.json'), '{}');
      writeSkill('valida', '---\nname: valida\n---\ncorpo');
      const { skills, errors } = new UserSkillsLoader({ baseDir: base }).load();
      expect(skills.map((s) => s.name)).toEqual(['valida']);
      expect(errors).toEqual([]);
    });

    it('arquivo solto na raiz de skills/ (não-dir) é ignorado', () => {
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, 'README.md'), 'não é skill');
      const { skills, errors } = new UserSkillsLoader({ baseDir: base }).load();
      expect(skills).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('dir de skills ausente ⇒ { skills: [], errors: [] } sem lançar', () => {
      const { skills, errors } = new UserSkillsLoader({ baseDir: base }).load();
      expect(skills).toEqual([]);
      expect(errors).toEqual([]);
    });
  });

  describe('load() — limites', () => {
    it('SKILL.md > 256KB é ignorado (não é skill)', () => {
      writeSkill('peq', '---\nname: peq\n---\ncorpo');
      writeSkill('gigante', '---\nname: gigante\n---\n' + 'x'.repeat(257 * 1024));
      const { skills } = new UserSkillsLoader({ baseDir: base }).load();
      expect(skills.map((s) => s.name)).toEqual(['peq']);
    });
  });
});
