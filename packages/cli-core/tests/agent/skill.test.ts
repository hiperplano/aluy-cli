// EST-1112 · ADR-0116 (proposto) — parser PURO de SKILL.md (parseSkill):
//   - válido com frontmatter completo (name + description + corpo)
//   - name herdado do DIRETÓRIO quando ausente no frontmatter (descoberta por pasta)
//   - frontmatter VENCE o nome do diretório
//   - normalização do nome (minúsculas, [a-z0-9_-], bordas, teto)
//   - RES-MD-3 (FALHA FECHADA): sem name (fm nem dir) ⇒ erro · corpo vazio ⇒ erro
//   - sem frontmatter ⇒ corpo inteiro, name do diretório
//   - origin é injetada pelo loader (não inferida do conteúdo)

import { describe, expect, it } from 'vitest';
import { parseSkill, isSkillError, normalizeSkillName, type Skill } from '../../src/agent/skill.js';

describe('EST-1112 · parseSkill — parser puro de SKILL.md', () => {
  describe('válido', () => {
    it('frontmatter completo ⇒ Skill com name/description/instructions/origin', () => {
      const raw =
        '---\nname: pdf-fill\ndescription: Preenche PDFs a partir de JSON.\n---\nPara preencher um PDF, leia o template ao lado.';
      const p = parseSkill('qualquer-pasta', raw, 'global');
      expect(isSkillError(p)).toBe(false);
      const s = p as Skill;
      expect(s.name).toBe('pdf-fill');
      expect(s.description).toBe('Preenche PDFs a partir de JSON.');
      expect(s.instructions).toContain('Para preencher um PDF');
      expect(s.origin).toBe('global');
    });

    it('herda o name do DIRETÓRIO quando o frontmatter não tem name', () => {
      const raw = '---\ndescription: só descrição\n---\ninstruções aqui';
      const p = parseSkill('minha-skill', raw, 'project');
      expect(isSkillError(p)).toBe(false);
      const s = p as Skill;
      expect(s.name).toBe('minha-skill');
      expect(s.origin).toBe('project');
    });

    it('frontmatter name VENCE o nome do diretório', () => {
      const raw = '---\nname: nome-real\n---\ncorpo';
      const s = parseSkill('nome-da-pasta', raw, 'global') as Skill;
      expect(s.name).toBe('nome-real');
    });

    it('sem frontmatter ⇒ corpo inteiro é instruções, name do diretório', () => {
      const raw = 'apenas instruções, sem frontmatter';
      const s = parseSkill('a-skill', raw, 'global') as Skill;
      expect(s.name).toBe('a-skill');
      expect(s.instructions).toBe('apenas instruções, sem frontmatter');
      expect(s.description).toBeUndefined();
    });

    it('tolera CRLF e BOM no frontmatter', () => {
      const raw = '﻿---\r\nname: x\r\n---\r\ncorpo';
      const s = parseSkill('x', raw, 'global') as Skill;
      expect(s.name).toBe('x');
      expect(s.instructions).toBe('corpo');
    });

    it('tira aspas envolventes do valor do frontmatter', () => {
      const raw = '---\nname: "quoted"\ndescription: \'aspas\'\n---\ncorpo';
      const s = parseSkill('q', raw, 'global') as Skill;
      expect(s.name).toBe('quoted');
      expect(s.description).toBe('aspas');
    });
  });

  describe('normalizeSkillName', () => {
    it('minúsculas + só [a-z0-9_-], bordas aparadas', () => {
      expect(normalizeSkillName('  My Skill!  ')).toBe('my-skill');
      expect(normalizeSkillName('PDF__Fill')).toBe('pdf__fill');
      expect(normalizeSkillName('---a---')).toBe('a');
    });

    it('só caracteres inválidos ⇒ string vazia', () => {
      expect(normalizeSkillName('!!!')).toBe('');
      expect(normalizeSkillName('   ')).toBe('');
    });
  });

  describe('RES-MD-3 — FALHA FECHADA', () => {
    it('sem name (frontmatter NEM diretório válido) ⇒ SkillError', () => {
      const p = parseSkill('!!!', '---\ndescription: x\n---\ncorpo', 'global');
      expect(isSkillError(p)).toBe(true);
      if (isSkillError(p)) expect(p.reason).toMatch(/sem "name" válido|fail-closed/);
    });

    it('corpo vazio ⇒ SkillError (sem instruções)', () => {
      const p = parseSkill('skill-x', '---\nname: skill-x\n---\n', 'global');
      expect(isSkillError(p)).toBe(true);
      if (isSkillError(p)) {
        expect(p.name).toBe('skill-x');
        expect(p.reason).toMatch(/corpo vazio|sem instruções/);
      }
    });

    it('só frontmatter, sem corpo ⇒ SkillError', () => {
      const p = parseSkill('y', '---\nname: y\ndescription: z\n---', 'global');
      expect(isSkillError(p)).toBe(true);
    });
  });
});
