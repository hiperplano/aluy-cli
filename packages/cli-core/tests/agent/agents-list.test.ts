// EST-0977 · ADR-0061 — `/agents` + `aluy agents`: FORMATADOR PURO (`buildAgentsNote`).
//
// Bateria: VÁLIDOS (nome/escopo/tools/persona, 1 linha — nunca o .md inteiro);
// REJEITADOS (motivo EXATO RES-MD-3 + dica de conserto); estado VAZIO (onde criar);
// AMBOS os escopos (global + projeto) juntos; ordenação (global antes de projeto, depois
// alfabético). PURO — sem fs, sem Ink.

import { describe, expect, it } from 'vitest';
import {
  buildAgentsNote,
  agentOriginLabel,
  agentPersonaLine,
  agentToolsLine,
  type AgentProfile,
  type AgentProfileError,
} from '../../src/index.js';

function profile(
  over: Partial<AgentProfile> & Pick<AgentProfile, 'name' | 'origin'>,
): AgentProfile {
  return {
    systemPrompt: 'Você é um agente de teste. Faça o que for pedido com rigor.',
    ...over,
  };
}

function err(file: string, reason: string): AgentProfileError {
  return { kind: 'error', file, reason };
}

/** Junta as linhas p/ asserts de substring legíveis. */
function text(lines: readonly string[]): string {
  return lines.join('\n');
}

describe('buildAgentsNote — válidos', () => {
  it('mostra nome, escopo, tools e persona (1 linha) de cada agente válido', () => {
    const note = buildAgentsNote({
      profiles: [
        profile({
          name: 'revisor',
          origin: 'global',
          tools: ['read_file', 'grep'],
          description: 'Revisa diffs e aponta bugs/regressões.',
        }),
      ],
      errors: [],
    });
    expect(note.title).toBe('agents');
    const t = text(note.lines);
    expect(t).toContain('válidos (1)');
    // tabela com bordas: a linha do agente traz nome + escopo + tools + persona.
    const row = note.lines.find((l) => l.includes('revisor'))!;
    expect(row).toContain('revisor');
    expect(row).toContain('global');
    expect(row).toContain('read_file, grep');
    expect(t).toContain('Revisa diffs e aponta bugs/regressões.');
  });

  it('tools AUSENTE ⇒ "herda do pai" (não inventa lista)', () => {
    const note = buildAgentsNote({
      profiles: [profile({ name: 'planner', origin: 'global', description: 'Planeja.' })],
      errors: [],
    });
    expect(text(note.lines)).toContain('herda do pai');
  });

  it('sem description, usa a 1ª linha não-vazia do systemPrompt como persona', () => {
    const note = buildAgentsNote({
      profiles: [
        profile({
          name: 'p',
          origin: 'project',
          systemPrompt: '\n\nSou a persona da 1ª linha.\nresto ignorado',
        }),
      ],
      errors: [],
    });
    expect(text(note.lines)).toContain('Sou a persona da 1ª linha.');
    // NÃO despeja o corpo inteiro.
    expect(text(note.lines)).not.toContain('resto ignorado');
  });

  it('trunca a persona longa com … (nunca o .md inteiro)', () => {
    const longDesc = 'x'.repeat(300);
    const line = agentPersonaLine(profile({ name: 'a', origin: 'global', description: longDesc }));
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(100);
  });
});

describe('buildAgentsNote — rejeitados (RES-MD-3)', () => {
  it('mostra o arquivo, o motivo EXATO e a dica de conserto', () => {
    const note = buildAgentsNote({
      profiles: [],
      errors: [
        err(
          'saudador.md',
          'agente "saudador" (saudador.md): "tools" presente mas ilegível/vazio — FALHA FECHADA (RES-MD-3)',
        ),
      ],
    });
    const t = text(note.lines);
    expect(t).toContain('rejeitados (1)');
    expect(t).toContain('saudador.md');
    expect(t).toContain('não foram carregados por estarem inválidos');
    expect(t).toContain('conserto:');
    expect(t).toContain('LISTA legível');
  });
});

describe('buildAgentsNote — estado vazio', () => {
  it('sem válidos nem rejeitados ⇒ dica de onde criar', () => {
    const note = buildAgentsNote({ profiles: [], errors: [] });
    const t = text(note.lines);
    expect(t).toContain('nenhum agente .md');
    expect(t).toContain('~/.aluy/agents/<nome>.md');
    expect(t).toContain('spawn_agent');
  });

  it('respeita o globalDir injetado na mensagem de vazio', () => {
    const note = buildAgentsNote({ profiles: [], errors: [], globalDir: '/tmp/x/.aluy/agents' });
    expect(text(note.lines)).toContain('/tmp/x/.aluy/agents/<nome>.md');
  });
});

describe('buildAgentsNote — ambos os escopos + ordenação', () => {
  it('lista global E projeto, com global antes de projeto e alfabético dentro', () => {
    const note = buildAgentsNote({
      profiles: [
        profile({ name: 'zeta', origin: 'project', description: 'projeto z' }),
        profile({ name: 'beta', origin: 'global', description: 'global b' }),
        profile({ name: 'alfa', origin: 'project', description: 'projeto a' }),
      ],
      errors: [],
    });
    // Os 3 aparecem como linhas da tabela, com o escopo certo na célula.
    const rowBeta = note.lines.find((l) => l.includes('beta'))!;
    const rowAlfa = note.lines.find((l) => l.includes('alfa'))!;
    const rowZeta = note.lines.find((l) => l.includes('zeta'))!;
    expect(rowBeta).toContain('global');
    expect(rowAlfa).toContain('projeto');
    expect(rowZeta).toContain('projeto');
    // Ordem: beta (global) antes de alfa e zeta (projeto); alfa antes de zeta.
    const iBeta = note.lines.findIndex((l) => l.includes('beta'));
    const iAlfa = note.lines.findIndex((l) => l.includes('alfa'));
    const iZeta = note.lines.findIndex((l) => l.includes('zeta'));
    expect(iBeta).toBeLessThan(iAlfa);
    expect(iAlfa).toBeLessThan(iZeta);
  });

  it('válidos E rejeitados juntos ⇒ as duas seções', () => {
    const note = buildAgentsNote({
      profiles: [profile({ name: 'ok1', origin: 'global', description: 'd' })],
      errors: [err('ruim.md', 'motivo qualquer RES-MD-3')],
    });
    const t = text(note.lines);
    expect(t).toContain('válidos (1)');
    expect(t).toContain('rejeitados (1)');
  });
});

describe('helpers puros', () => {
  it('agentOriginLabel distingue as camadas', () => {
    expect(agentOriginLabel('global')).toContain('~/.aluy/agents/');
    expect(agentOriginLabel('project')).toContain('.claude/agents/');
  });

  it('agentToolsLine lista as tools com a nota ⊆ pai', () => {
    expect(agentToolsLine(profile({ name: 'a', origin: 'global', tools: ['x', 'y'] }))).toBe(
      'tools: x, y (⊆ pai)',
    );
  });
});
