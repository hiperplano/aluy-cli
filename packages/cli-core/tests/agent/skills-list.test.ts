// EST-1112 · ADR-0116 (proposto) — formatador PURO buildSkillsNote:
//   - estado VAZIO ⇒ dica de onde criar
//   - válidas ✓ ordenadas (global antes de projeto, depois alfabético) com escopo/desc
//   - rejeitadas ⚠ com o motivo + dica de conserto
//   - nota de proveniência (global=dono · projeto=dado)
//   - descrição truncada no teto; 1ª linha das instruções quando sem description

import { describe, expect, it } from 'vitest';
import {
  buildSkillsNote,
  skillOriginLabel,
  skillDescriptionLine,
} from '../../src/agent/skills-list.js';
import type { Skill, SkillError } from '../../src/agent/skill.js';

const skill = (over: Partial<Skill> = {}): Skill => ({
  name: 'sk',
  instructions: 'faz algo útil',
  origin: 'global',
  ...over,
});

describe('EST-1112 · buildSkillsNote — formatador puro', () => {
  it('estado VAZIO ⇒ dica de onde criar', () => {
    const note = buildSkillsNote({ skills: [], errors: [] });
    expect(note.title).toBe('skills');
    expect(note.lines.join('\n')).toMatch(/nenhuma skill mapeada/);
    expect(note.lines.join('\n')).toMatch(/~\/\.aluy\/skills\/<nome>\/SKILL\.md/);
  });

  it('respeita o globalDir injetado na mensagem vazia', () => {
    const note = buildSkillsNote({ skills: [], errors: [], globalDir: '/tmp/x/skills' });
    expect(note.lines.join('\n')).toContain('/tmp/x/skills/<nome>/SKILL.md');
  });

  it('válidas (tabela) ordenadas global antes de projeto, depois alfabético', () => {
    const note = buildSkillsNote({
      skills: [
        skill({ name: 'zeta', origin: 'project' }),
        skill({ name: 'beta', origin: 'global' }),
        skill({ name: 'alfa', origin: 'project' }),
        skill({ name: 'gama', origin: 'global' }),
      ],
      errors: [],
    });
    // Agora cada skill é uma LINHA da tabela com bordas — a ordem é a posição do
    // nome no texto: global (beta, gama) antes de projeto (alfa, zeta), alfabético.
    const txt = note.lines.join('\n');
    expect(txt.indexOf('beta')).toBeLessThan(txt.indexOf('gama'));
    expect(txt.indexOf('gama')).toBeLessThan(txt.indexOf('alfa'));
    expect(txt.indexOf('alfa')).toBeLessThan(txt.indexOf('zeta'));
  });

  it('mostra escopo e descrição de cada skill válida (na tabela)', () => {
    const note = buildSkillsNote({
      skills: [skill({ name: 'pdf', description: 'preenche pdf', origin: 'global' })],
      errors: [],
    });
    const txt = note.lines.join('\n');
    // cabeçalho da tabela + nome + escopo + descrição em células.
    expect(txt).toContain('skill');
    expect(txt).toContain('escopo');
    expect(txt).toContain('pdf');
    expect(txt).toContain('global');
    expect(txt).toContain('preenche pdf');
    expect(txt).toMatch(/invoque por nome com \/skill/);
  });

  it('rejeitadas (tabela) com o motivo + dica de conserto', () => {
    const errors: SkillError[] = [
      { kind: 'error', name: 'ruim', reason: 'corpo vazio — sem instruções' },
    ];
    const note = buildSkillsNote({ skills: [], errors });
    const txt = note.lines.join('\n');
    expect(txt).toMatch(/rejeitadas \(1\)/);
    expect(txt).toContain('ruim');
    expect(txt).toContain('corpo vazio');
    expect(txt).toMatch(/conserto/);
  });

  it('nota de proveniência presente quando há algo a listar', () => {
    const note = buildSkillsNote({ skills: [skill()], errors: [] });
    expect(note.lines.join('\n')).toMatch(/global .* config do dono · projeto .* dado do repo/);
  });

  it('skillOriginLabel distingue global/projeto', () => {
    expect(skillOriginLabel('global')).toContain('~/.aluy/skills/');
    expect(skillOriginLabel('project')).toContain('.claude/skills/');
  });

  it('skillDescriptionLine usa a 1ª linha das instruções quando sem description', () => {
    const s = skill({ description: undefined, instructions: '\n\nlinha útil\noutra' });
    expect(skillDescriptionLine(s)).toBe('linha útil');
  });

  it('skillDescriptionLine trunca no teto com reticências', () => {
    const long = 'x'.repeat(200);
    const out = skillDescriptionLine(skill({ description: long }));
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('…')).toBe(true);
  });
});
