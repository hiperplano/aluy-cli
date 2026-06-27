// EST-1105 · ADR-workflows — PARSER de workflows-`.md` (FALHA FECHADA RES-MD-3).
//
// Bateria: descoberta/parse do frontmatter+corpo; atividades numeradas;
// e o ponto-chave RES-MD-3 — FALHA FECHADA: `.md` malformado / sem name /
// sem atividade NÃO vira "workflow vazio".

import { describe, expect, it } from 'vitest';
import { parseWorkflow, isWorkflowError, type WorkflowDef } from '../../src/index.js';

/** Atalho: parseia e exige sucesso. */
function ok(basename: string, raw: string, origin: 'global' | 'project' = 'global'): WorkflowDef {
  const p = parseWorkflow(basename, raw, origin);
  if (isWorkflowError(p)) throw new Error(`esperava workflow, veio erro: ${p.reason}`);
  return p;
}

describe('parseWorkflow — frontmatter + atividades (EST-1105)', () => {
  it('parseia name/description + atividades numeradas', () => {
    const raw = [
      '---',
      'name: sdlc-estoria',
      'description: Fluxo de implementação de uma estória',
      '---',
      '1. entender — Leia a estória e o contexto.',
      '2. implementar — Implemente o código + os testes.',
      '3. testar — Rode build/lint/testes.',
    ].join('\n');
    const wf = ok('sdlc-estoria.md', raw);
    expect(wf.name).toBe('sdlc-estoria');
    expect(wf.description).toBe('Fluxo de implementação de uma estória');
    expect(wf.activities).toHaveLength(3);
    expect(wf.activities[0]!).toEqual({ id: 'entender', goal: 'Leia a estória e o contexto.' });
    expect(wf.activities[1]!).toEqual({
      id: 'implementar',
      goal: 'Implemente o código + os testes.',
    });
    expect(wf.activities[2]!).toEqual({ id: 'testar', goal: 'Rode build/lint/testes.' });
    expect(wf.origin).toBe('global');
  });

  it('parseia [agente] opcional entre id e separador', () => {
    const raw = [
      '---',
      'name: sdlc',
      '---',
      '1. entender — Leia a estória.',
      '2. implementar [coder] — Implemente o código.',
      '3. testar [tester] — Rode os testes.',
    ].join('\n');
    const wf = ok('sdlc.md', raw);
    expect(wf.activities).toHaveLength(3);
    expect(wf.activities[0]!.agent).toBeUndefined();
    expect(wf.activities[0]!.goal).toBe('Leia a estória.');
    expect(wf.activities[1]!.agent).toBe('coder');
    expect(wf.activities[1]!.goal).toBe('Implemente o código.');
    expect(wf.activities[2]!.agent).toBe('tester');
    expect(wf.activities[2]!.goal).toBe('Rode os testes.');
  });

  it('[agente] vazio é ignorado (back-compat)', () => {
    const raw = '---\nname: x\n---\n1. a [] — goal';
    const wf = ok('x.md', raw);
    expect(wf.activities[0]!.agent).toBeUndefined();
  });

  it('aceita hífen simples como separador (— ou -)', () => {
    const raw = ['---', 'name: x', '---', '1. foo - faz algo', '2. bar - faz outra'].join('\n');
    const wf = ok('x.md', raw);
    expect(wf.activities).toHaveLength(2);
    expect(wf.activities[0]!.id).toBe('foo');
    expect(wf.activities[0]!.goal).toBe('faz algo');
  });

  it('description opcional — undefined se ausente ou vazia', () => {
    const raw = '---\nname: x\n---\n1. a — goal';
    expect(ok('x.md', raw).description).toBeUndefined();

    const rawEmpty = '---\nname: x\ndescription:\n---\n1. a — goal';
    expect(ok('x.md', rawEmpty).description).toBeUndefined();
  });

  it('origin é injetada pelo loader (não do conteúdo)', () => {
    const raw = '---\nname: x\n---\n1. a — goal';
    expect(ok('x.md', raw, 'project').origin).toBe('project');
  });

  it('ignora linhas do corpo que não são atividades numeradas', () => {
    const raw = [
      '---',
      'name: x',
      '---',
      'Comentário qualquer.',
      '1. a — goal',
      '',
      'Outro comentário.',
      '2. b — segundo',
    ].join('\n');
    const wf = ok('x.md', raw);
    expect(wf.activities).toHaveLength(2);
    expect(wf.activities[0]!.id).toBe('a');
    expect(wf.activities[1]!.id).toBe('b');
  });
});

describe('RES-MD-3 — FALHA FECHADA (malformado)', () => {
  it('`name` ausente ⇒ ERRO (workflow rejeitado)', () => {
    const p = parseWorkflow('x.md', '---\ndescription: sem nome\n---\n1. a — goal', 'global');
    expect(isWorkflowError(p)).toBe(true);
  });

  it('`name` vazio ⇒ ERRO', () => {
    const p = parseWorkflow('x.md', '---\nname:\n---\n1. a — goal', 'global');
    expect(isWorkflowError(p)).toBe(true);
  });

  it('zero atividades (corpo sem linha numerada) ⇒ ERRO', () => {
    const p = parseWorkflow('x.md', '---\nname: x\n---\nsó comentário, sem atividade', 'global');
    expect(isWorkflowError(p)).toBe(true);
    if (isWorkflowError(p)) {
      expect(p.reason).toMatch(/nenhuma atividade/);
    }
  });

  it('corpo vazio ⇒ ERRO', () => {
    const p = parseWorkflow('x.md', '---\nname: x\n---\n', 'global');
    expect(isWorkflowError(p)).toBe(true);
  });

  it('sem frontmatter algum ⇒ ERRO (sem name)', () => {
    const p = parseWorkflow('x.md', '1. a — goal', 'global');
    expect(isWorkflowError(p)).toBe(true);
  });

  it('linha com número sem separador ⇒ ignorada (não é atividade)', () => {
    const p = parseWorkflow('x.md', '---\nname: x\n---\n1. sem separador aqui', 'global');
    // sem separador → não parseia como atividade → zero atividades → ERRO
    expect(isWorkflowError(p)).toBe(true);
  });
});

describe('isWorkflowError', () => {
  it('distingue WorkflowDef de WorkflowError', () => {
    const wf = ok('x.md', '---\nname: x\n---\n1. a — goal');
    expect(isWorkflowError(wf)).toBe(false);

    const err = parseWorkflow('x.md', '', 'global');
    expect(isWorkflowError(err)).toBe(true);
  });
});
