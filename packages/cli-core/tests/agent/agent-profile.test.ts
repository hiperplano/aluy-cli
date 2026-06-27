// EST-0977 · ADR-0061 · CLI-SEC-11 — PARSER de agentes-`.md` (gate FORTE do `seguranca`).
//
// Bateria: descoberta/parse do frontmatter+corpo; campos; `tools` lista; `model`;
// e o ponto-chave RES-MD-3 — FALHA FECHADA: `.md` malformado / `tools` ilegível NÃO
// vira "agente sem restrição" (nunca "sem tools = herda tudo").

import { describe, expect, it } from 'vitest';
import {
  parseAgentProfile,
  isAgentProfileError,
  normalizeAgentName,
  normalizeToolName,
  type AgentProfile,
} from '../../src/index.js';

/** Atalho: parseia e exige sucesso (falha o teste se for erro). */
function ok(basename: string, raw: string, origin: 'global' | 'project' = 'global'): AgentProfile {
  const p = parseAgentProfile(basename, raw, origin);
  if (isAgentProfileError(p)) throw new Error(`esperava perfil, veio erro: ${p.reason}`);
  return p;
}

describe('parseAgentProfile — frontmatter + corpo (EST-0977)', () => {
  it('parseia name/description/tools/model + corpo=system prompt', () => {
    const raw = [
      '---',
      'name: revisor',
      'description: Revisa diffs e aponta bugs/regressões.',
      'tools: read_file, grep',
      'model: sonnet',
      '---',
      'Você é um revisor rigoroso. Aponte bugs e riscos.',
    ].join('\n');
    const p = ok('revisor.md', raw);
    expect(p.name).toBe('revisor');
    expect(p.description).toBe('Revisa diffs e aponta bugs/regressões.');
    expect(p.tools).toEqual(['read_file', 'grep']);
    expect(p.model).toBe('sonnet');
    expect(p.systemPrompt).toBe('Você é um revisor rigoroso. Aponte bugs e riscos.');
    expect(p.origin).toBe('global');
  });

  it('corpo (após o frontmatter) é o system prompt (CA: corpo→system prompt)', () => {
    const raw = '---\nname: x\n---\nlinha1\nlinha2\n';
    expect(ok('x.md', raw).systemPrompt).toBe('linha1\nlinha2');
  });

  it('aceita a forma YAML-flow `tools: [a, b]` e o estilo Claude Code (Read/Bash)', () => {
    const raw = '---\nname: a\ntools: [Read, Bash]\n---\ncorpo';
    // Read→read_file, Bash→run_command (compat de nomes do Claude Code).
    expect(ok('a.md', raw).tools).toEqual(['read_file', 'run_command']);
  });

  it('`tools` AUSENTE ⇒ tools undefined (HERDA o do pai, ⊆ sessão — não é falha)', () => {
    const raw = '---\nname: a\n---\ncorpo';
    expect(ok('a.md', raw).tools).toBeUndefined();
  });

  it('preserva `spawn_agent`/`task` declarado (a catraca nega; não filtra em silêncio)', () => {
    const raw = '---\nname: a\ntools: read_file, task\n---\ncorpo';
    // `task` é normalizado p/ `spawn_agent` (alias Claude Code) e PRESERVADO — o gate
    // do filho o NEGA visivelmente (E-A1/GS-MD2), em vez de ser removido aqui.
    expect(ok('a.md', raw).tools).toContain('spawn_agent');
  });

  it('origin é injetada pelo loader (não do conteúdo)', () => {
    const raw = '---\nname: a\n---\ncorpo';
    expect(ok('a.md', raw, 'project').origin).toBe('project');
  });

  // HUNT-SUBAGENT-ESCALATION (privilege-escalation) — vetor #1: um `.md` malicioso
  // tenta `tools: *` / `tools: all` esperando que vire "TODAS as tools". O parser NÃO
  // expande coringa: trata `*`/`all` como NOME LITERAL de tool (desconhecido). O
  // toolScope resultante é `{'*'}` / `{'all'}` — que a catraca usa p/ NEGAR toda tool
  // real (read_file/run_command/…), nunca p/ liberar. Coringa = fail-closed, jamais
  // escalada. (A não-expansão na catraca está pinada no engine-test abaixo.)
  it('`tools: *` NÃO expande p/ "todas" — vira o nome LITERAL `*` (coringa fail-closed)', () => {
    expect(ok('a.md', '---\nname: a\ntools: *\n---\ncorpo').tools).toEqual(['*']);
  });

  it('`tools: all` NÃO expande p/ "todas" — vira o nome LITERAL `all` (sem coringa)', () => {
    expect(ok('a.md', '---\nname: a\ntools: all\n---\ncorpo').tools).toEqual(['all']);
  });
});

describe('RES-MD-3 — FALHA FECHADA (malformado / tools ilegível)', () => {
  it('`name` ausente ⇒ ERRO (perfil rejeitado, não entra)', () => {
    const p = parseAgentProfile('x.md', '---\ndescription: sem nome\n---\ncorpo', 'global');
    expect(isAgentProfileError(p)).toBe(true);
  });

  it('corpo vazio ⇒ ERRO (sem system prompt)', () => {
    const p = parseAgentProfile('x.md', '---\nname: a\n---\n', 'global');
    expect(isAgentProfileError(p)).toBe(true);
  });

  it('`tools:` PRESENTE mas VAZIO ⇒ FALHA FECHADA (NUNCA "herda tudo")', () => {
    const p = parseAgentProfile('x.md', '---\nname: a\ntools:\n---\ncorpo', 'global');
    expect(isAgentProfileError(p)).toBe(true);
    if (isAgentProfileError(p)) expect(p.reason).toMatch(/não carregado|inválida/);
  });

  it('`tools:` PRESENTE mas só lixo/separadores ⇒ FALHA FECHADA', () => {
    const p = parseAgentProfile('x.md', '---\nname: a\ntools: , , ,\n---\ncorpo', 'global');
    expect(isAgentProfileError(p)).toBe(true);
  });

  it('sem frontmatter algum ⇒ ERRO (sem name)', () => {
    const p = parseAgentProfile('x.md', 'só um corpo, sem frontmatter', 'global');
    expect(isAgentProfileError(p)).toBe(true);
  });
});

describe('normalização', () => {
  it('normalizeAgentName: minúsculas, só [a-z0-9_-]', () => {
    expect(normalizeAgentName('  Revisor De Código!  ')).toBe('revisor-de-c-digo');
    expect(normalizeAgentName('@@@')).toBe('');
  });

  it('normalizeToolName mapeia nomes Claude Code → nativos', () => {
    expect(normalizeToolName('Read')).toBe('read_file');
    expect(normalizeToolName('Bash')).toBe('run_command');
    expect(normalizeToolName('WebFetch')).toBe('web_fetch');
    expect(normalizeToolName('Task')).toBe('spawn_agent');
    // EST-0944 — Edit (cirúrgico) ⇒ edit_file; Write (full content) ⇒ write_file.
    expect(normalizeToolName('Edit')).toBe('edit_file');
    expect(normalizeToolName('MultiEdit')).toBe('edit_file');
    expect(normalizeToolName('Write')).toBe('write_file');
  });
});
