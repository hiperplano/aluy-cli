// EST-1105 · ADR-workflows — FORMATADOR PURO `buildWorkflowsNote`/`workflowDescriptionLine`/
// `workflowOriginLabel` (agent/workflow/workflows-list.ts). Espelha o padrão de
// `tests/agent/agents-list.test.ts` (o irmão `/agents`): estado VAZIO, válidos (ordenação
// global-antes-de-projeto + alfabética, descrição truncada no teto), rejeitados (motivo
// exato + dica de conserto), e ambos juntos. PURO — sem fs, sem Ink.

import { describe, expect, it } from 'vitest';
import {
  buildWorkflowsNote,
  workflowOriginLabel,
  workflowDescriptionLine,
  type WorkflowsListInput,
} from '../../../src/index.js';
import type { WorkflowDef, WorkflowError } from '../../../src/agent/workflow/workflow-parse.js';

function wf(over: Partial<WorkflowDef> & Pick<WorkflowDef, 'name' | 'origin'>): WorkflowDef {
  return { activities: [{ id: 'a1', goal: 'faça algo' }], ...over };
}

function err(file: string, reason: string): WorkflowError {
  return { error: true, file, reason };
}

function text(lines: readonly string[]): string {
  return lines.join('\n');
}

describe('workflowOriginLabel', () => {
  it('global ⇒ rótulo com o caminho ~/.aluy/workflows/', () => {
    expect(workflowOriginLabel('global')).toMatch(/~\/\.aluy\/workflows\//);
  });
  it('project ⇒ rótulo com o caminho .claude/workflows/', () => {
    expect(workflowOriginLabel('project')).toMatch(/\.claude\/workflows\//);
  });
});

describe('workflowDescriptionLine', () => {
  it('sem description ⇒ string vazia', () => {
    expect(workflowDescriptionLine(wf({ name: 'x', origin: 'global' }))).toBe('');
  });
  it('colapsa espaços múltiplos/newlines e apara', () => {
    const w = wf({ name: 'x', origin: 'global', description: '  faz\n  um   review  ' });
    expect(workflowDescriptionLine(w)).toBe('faz um review');
  });
  it('curta (≤100) ⇒ passa direto, sem reticências', () => {
    const w = wf({ name: 'x', origin: 'global', description: 'descrição curta' });
    expect(workflowDescriptionLine(w)).toBe('descrição curta');
  });
  it('longa (>100) ⇒ trunca em 99 chars + "…"', () => {
    const long = 'a'.repeat(150);
    const w = wf({ name: 'x', origin: 'global', description: long });
    const out = workflowDescriptionLine(w);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(100); // 99 chars + reticências
  });
});

describe('buildWorkflowsNote — estado VAZIO', () => {
  it('sem workflows e sem erros ⇒ dica de onde criar (default dirs)', () => {
    const note = buildWorkflowsNote({ workflows: [], errors: [] });
    expect(note.title).toBe('workflows');
    expect(text(note.lines)).toMatch(/nenhum workflow mapeado/);
    expect(text(note.lines)).toMatch(/~\.aluy\/workflows|~\/\.aluy\/workflows/);
  });

  it('usa globalDir/projectDir customizados quando fornecidos', () => {
    const note = buildWorkflowsNote({
      workflows: [],
      errors: [],
      globalDir: '/custom/global',
      projectDir: '/custom/project',
    });
    expect(text(note.lines)).toContain('/custom/global/');
  });
});

describe('buildWorkflowsNote — válidos', () => {
  it('lista nome + descrição + N atividades + escopo, um por linha', () => {
    const note = buildWorkflowsNote({
      workflows: [
        wf({
          name: 'revisao',
          origin: 'global',
          description: 'revisa o PR',
          activities: [
            { id: 'a1', goal: 'lê o diff' },
            { id: 'a2', goal: 'comenta' },
          ],
        }),
      ],
      errors: [],
    });
    const out = text(note.lines);
    expect(out).toContain('válidos (1):');
    expect(out).toMatch(/✓ revisao · revisa o PR · 2 atividades/);
    expect(out).toMatch(/global · ~\/\.aluy\/workflows\//);
  });

  it('ordena: global ANTES de projeto, depois alfabético dentro do escopo', () => {
    const note = buildWorkflowsNote({
      workflows: [
        wf({ name: 'zebra', origin: 'project' }),
        wf({ name: 'abacaxi', origin: 'project' }),
        wf({ name: 'zulu', origin: 'global' }),
        wf({ name: 'alfa', origin: 'global' }),
      ],
      errors: [],
    });
    const names = note.lines.filter((l) => l.includes('✓')).map((l) => l.trim().split(' ')[1]);
    expect(names).toEqual(['alfa', 'zulu', 'abacaxi', 'zebra']);
  });

  it('workflow sem descrição ⇒ omite o " · " extra (sem descrição vazia visível)', () => {
    const note = buildWorkflowsNote({
      workflows: [wf({ name: 'sem-desc', origin: 'global' })],
      errors: [],
    });
    expect(text(note.lines)).toMatch(/✓ sem-desc · 1 atividades/);
  });
});

describe('buildWorkflowsNote — rejeitados', () => {
  it('lista o arquivo + motivo EXATO + dica de conserto', () => {
    const note = buildWorkflowsNote({
      workflows: [],
      errors: [err('quebrado.md', 'frontmatter sem `name`')],
    });
    const out = text(note.lines);
    expect(out).toContain('rejeitados (1)');
    expect(out).toContain('⚠ quebrado.md');
    expect(out).toContain('frontmatter sem `name`');
    expect(out).toMatch(/conserto:/);
  });

  it('ordena os rejeitados por nome de arquivo', () => {
    const note = buildWorkflowsNote({
      workflows: [],
      errors: [err('zzz.md', 'r1'), err('aaa.md', 'r2')],
    });
    const files = note.lines.filter((l) => l.includes('⚠')).map((l) => l.trim());
    expect(files).toEqual(['⚠ aaa.md', '⚠ zzz.md']);
  });
});

describe('buildWorkflowsNote — válidos + rejeitados juntos', () => {
  it('separa as duas seções com uma linha em branco', () => {
    const input: WorkflowsListInput = {
      workflows: [wf({ name: 'ok', origin: 'global' })],
      errors: [err('ruim.md', 'motivo')],
    };
    const note = buildWorkflowsNote(input);
    const out = text(note.lines);
    expect(out).toContain('válidos (1):');
    expect(out).toContain('rejeitados (1)');
    expect(out).toMatch(/✓ ok[\s\S]*rejeitados/);
  });
});
