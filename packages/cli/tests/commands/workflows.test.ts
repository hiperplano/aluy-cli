// EST-1105 · ADR-workflows — `/workflows`: FORMATADOR + RUNNER (comando que lista).
//
// Bateria: buildWorkflowsNote (PURO, do core) + runWorkflows (runner do cli).
// VÁLIDOS (✓) com nome/descrição/N-atividades/escopo; REJEITADOS (⚠) com motivo;
// estado VAZIO com dica de onde criar.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkflowsNote, type WorkflowDef, type WorkflowError } from '@aluy/cli-core';
import { runWorkflows } from '../../src/commands/workflows.js';
import { UserWorkflowsLoader, WORKFLOWS_DIRNAME } from '../../src/io/user-workflows.js';

function wf(over: Partial<WorkflowDef> & Pick<WorkflowDef, 'name' | 'origin'>): WorkflowDef {
  return {
    activities: [{ id: 'a', goal: 'Faz algo.' }],
    ...over,
  };
}

function err(file: string, reason: string): WorkflowError {
  return { error: true, file, reason };
}

function text(lines: readonly string[]): string {
  return lines.join('\n');
}

describe('buildWorkflowsNote — válidos (EST-1105)', () => {
  it('mostra nome, descrição, N atividades e escopo de cada workflow válido', () => {
    const note = buildWorkflowsNote({
      workflows: [
        wf({
          name: 'sdlc-estoria',
          origin: 'global',
          description: 'Fluxo de implementação de uma estória',
          activities: [
            { id: 'entender', goal: 'Leia a estória.' },
            { id: 'implementar', goal: 'Implemente o código.' },
            { id: 'testar', goal: 'Rode build/lint/testes.' },
          ],
        }),
      ],
      errors: [],
    });
    expect(note.title).toBe('workflows');
    const t = text(note.lines);
    expect(t).toContain('válidos (1)');
    expect(t).toContain('✓ sdlc-estoria');
    expect(t).toContain('Fluxo de implementação de uma estória');
    expect(t).toContain('3 atividades');
    expect(t).toContain('global · ~/.aluy/workflows/');
  });

  it('workflow sem description não mostra descrição', () => {
    const note = buildWorkflowsNote({
      workflows: [wf({ name: 'x', origin: 'project' })],
      errors: [],
    });
    const t = text(note.lines);
    expect(t).toContain('✓ x · 1 atividades');
    expect(t).toContain('projeto · .claude/workflows/');
  });
});

describe('buildWorkflowsNote — rejeitados (RES-MD-3)', () => {
  it('mostra o arquivo, o motivo e a dica de conserto', () => {
    const note = buildWorkflowsNote({
      workflows: [],
      errors: [err('ruim.md', 'workflow "x" (ruim.md): nenhuma atividade encontrada')],
    });
    const t = text(note.lines);
    expect(t).toContain('rejeitados (1)');
    expect(t).toContain('⚠ ruim.md');
    expect(t).toContain('nenhuma atividade encontrada');
    expect(t).toContain('conserto:');
  });
});

describe('buildWorkflowsNote — estado vazio', () => {
  it('sem válidos nem rejeitados ⇒ dica de onde criar', () => {
    const note = buildWorkflowsNote({ workflows: [], errors: [] });
    const t = text(note.lines);
    expect(t).toContain('nenhum workflow');
    expect(t).toContain('~/.aluy/workflows/<nome>.md');
    expect(t).toContain('.claude/workflows/<nome>.md');
  });
});

describe('buildWorkflowsNote — ordenação', () => {
  it('global antes de projeto, alfabético dentro', () => {
    const note = buildWorkflowsNote({
      workflows: [
        wf({ name: 'zeta', origin: 'project' }),
        wf({ name: 'beta', origin: 'global' }),
        wf({ name: 'alfa', origin: 'project' }),
      ],
      errors: [],
    });

    const iBeta = note.lines.findIndex((l) => l.includes('✓ beta'));
    const iAlfa = note.lines.findIndex((l) => l.includes('✓ alfa'));
    const iZeta = note.lines.findIndex((l) => l.includes('✓ zeta'));
    expect(iBeta).toBeLessThan(iAlfa);
    expect(iAlfa).toBeLessThan(iZeta);
  });
});

describe('runWorkflows — runner (EST-1105)', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-wr-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('lista workflows válidos + rejeitados (exit 0)', () => {
    const wfDir = join(base, WORKFLOWS_DIRNAME);
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, 'bom.md'), '---\nname: bom\n---\n1. a — goal');
    writeFileSync(join(wfDir, 'ruim.md'), '---\ndescription: sem nome\n---\n1. a — goal');

    const lines: string[] = [];
    const exit = runWorkflows({
      loadGlobal: () => new UserWorkflowsLoader({ baseDir: base }).load(),
      loadProject: () => ({ workflows: [], errors: [] }),
      globalDir: join(base, 'workflows'),
      projectDir: '.claude/workflows',
      out: (l) => lines.push(l),
    });
    expect(exit).toBe(0);
    const t = lines.join('\n');
    expect(t).toContain('válidos (1)');
    expect(t).toContain('✓ bom');
    expect(t).toContain('rejeitados (1)');
    expect(t).toContain('⚠ ruim.md');
  });

  it('estado vazio mostra dica', () => {
    const lines: string[] = [];
    runWorkflows({
      loadGlobal: () => ({ workflows: [], errors: [] }),
      loadProject: () => ({ workflows: [], errors: [] }),
      out: (l) => lines.push(l),
    });
    const t = lines.join('\n');
    expect(t).toContain('nenhum workflow');
  });
});
