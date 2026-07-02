// EST-1013 — testes de cobertura para funções PURAS de session-persist.ts
// (formatRelativeAge, formatResumeOffer, formatSessionList).
// Importa do .js compilado (dist) conforme padrão do repo.

import { describe, it, expect } from 'vitest';
import {
  formatRelativeAge,
  formatResumeOffer,
  formatSessionList,
  autoSaveSession,
  hasResumableContent,
} from '../../src/session/session-persist.js';
import type { SessionBlock } from '../../src/session/model.js';
import type { SessionStore } from '../../src/io/index.js';

// ---------------------------------------------------------------------------
// formatRelativeAge
// ---------------------------------------------------------------------------
describe('formatRelativeAge', () => {
  it('devolve "há instantes" para menos de 60 segundos', () => {
    expect(formatRelativeAge(0)).toBe('há instantes');
    expect(formatRelativeAge(1000)).toBe('há instantes');
    expect(formatRelativeAge(59_000)).toBe('há instantes');
  });

  it('devolve "há N min" para entre 1 minuto e 59 minutos', () => {
    expect(formatRelativeAge(60_000)).toBe('há 1 min');
    expect(formatRelativeAge(120_000)).toBe('há 2 min');
    expect(formatRelativeAge(59 * 60_000)).toBe('há 59 min');
  });

  it('devolve "há N h" para entre 1 hora e 23 horas', () => {
    // 3 horas em ms
    expect(formatRelativeAge(3 * 60 * 60 * 1000)).toBe('há 3 h');
    expect(formatRelativeAge(60 * 60 * 1000)).toBe('há 1 h');
    expect(formatRelativeAge(23 * 60 * 60 * 1000)).toBe('há 23 h');
  });

  it('devolve "há N d" para 24 horas ou mais', () => {
    // 2 dias em ms
    expect(formatRelativeAge(2 * 24 * 60 * 60 * 1000)).toBe('há 2 d');
    expect(formatRelativeAge(24 * 60 * 60 * 1000)).toBe('há 1 d');
    expect(formatRelativeAge(365 * 24 * 60 * 60 * 1000)).toBe('há 365 d');
  });
});

// ---------------------------------------------------------------------------
// formatResumeOffer
// ---------------------------------------------------------------------------
describe('formatResumeOffer', () => {
  it('usa "mensagem" (singular) quando messageCount === 1', () => {
    const result = formatResumeOffer(1, 5000);
    expect(result).toContain('1 mensagem');
    expect(result).toContain('há instantes');
  });

  it('usa "mensagens" (plural) quando messageCount !== 1', () => {
    const result = formatResumeOffer(3, 2 * 60 * 60 * 1000);
    expect(result).toContain('3 mensagens');
    expect(result).toContain('há 2 h');
  });

  it('inclui a idade relativa e o prefixo ↻', () => {
    const result = formatResumeOffer(5, 10 * 60 * 1000);
    expect(result).toContain('↻');
    expect(result).toContain('5 mensagens');
    expect(result).toContain('há 10 min');
  });
});

// ---------------------------------------------------------------------------
// formatSessionList
// ---------------------------------------------------------------------------
describe('formatSessionList', () => {
  it('devolve ["nenhuma sessão salva ainda."] para lista vazia', () => {
    const result = formatSessionList([]);
    expect(result).toEqual(['nenhuma sessão salva ainda.']);
  });

  it('devolve linhas com cabeçalho e "(sem objetivo)" quando session não tem title', () => {
    const summaries = [
      {
        id: 'abc123',
        updatedAt: 1_700_000_000_000,
        cwd: '/home/user/project',
        blockCount: 5,
        // sem title
      },
    ];
    const result = formatSessionList(summaries);
    // Cabeçalho
    expect(result[0]).toBe('sessões salvas (retome com: aluy --resume <id>):');
    // O id aparece
    expect(result.join('\n')).toContain('abc123');
    // "(sem objetivo)" aparece
    expect(result.join('\n')).toContain('(sem objetivo)');
  });

  it('devolve linhas com título quando session tem title', () => {
    const summaries = [
      {
        id: 'xyz789',
        updatedAt: 1_700_000_000_000,
        cwd: '/home/user/other',
        blockCount: 10,
        title: 'minha sessão legal',
      },
    ];
    const result = formatSessionList(summaries);
    expect(result.join('\n')).toContain('xyz789');
    expect(result.join('\n')).toContain('minha sessão legal');
    expect(result.join('\n')).not.toContain('(sem objetivo)');
  });

  it('devolve múltiplas linhas para múltiplas sessões', () => {
    const summaries = [
      {
        id: 'aaa',
        updatedAt: 1_700_000_000_000,
        cwd: '/a',
        blockCount: 1,
        title: 'primeira',
      },
      {
        id: 'bbb',
        updatedAt: 1_700_000_000_001,
        cwd: '/b',
        blockCount: 2,
        // sem title
      },
    ];
    const result = formatSessionList(summaries);
    expect(result[0]).toBe('sessões salvas (retome com: aluy --resume <id>):');
    expect(result.join('\n')).toContain('aaa');
    expect(result.join('\n')).toContain('bbb');
    expect(result.join('\n')).toContain('primeira');
    expect(result.join('\n')).toContain('(sem objetivo)');
  });
});

// ---------------------------------------------------------------------------
// F190 — não persistir sessão sem conteúdo retomável (só notas de boot)
// ---------------------------------------------------------------------------
describe('F190 — hasResumableContent / autoSaveSession gate', () => {
  const note: SessionBlock = { kind: 'note', title: 'config', lines: ['MCP: 5'] };
  const you: SessionBlock = { kind: 'you', text: 'oi' };
  const aluy: SessionBlock = { kind: 'aluy', text: 'olá', streaming: false };

  it('hasResumableContent: só notas ⇒ false; com you/aluy ⇒ true; com rótulo ⇒ true', () => {
    expect(hasResumableContent([note], undefined)).toBe(false);
    expect(hasResumableContent([], undefined)).toBe(false);
    expect(hasResumableContent([note, you], undefined)).toBe(true);
    expect(hasResumableContent([note, aluy], undefined)).toBe(true); // conversa de install (F187)
    expect(hasResumableContent([note], 'setup')).toBe(true); // rótulo explícito
    expect(hasResumableContent([note], '   ')).toBe(false); // rótulo em branco não conta
  });

  it('autoSaveSession NÃO grava uma sessão só de notas (retorna false, não chama save)', () => {
    let saved = 0;
    const store = { save: () => (saved++, true) } as unknown as SessionStore;
    const ok = autoSaveSession(store, { id: 'x', cwd: '/p', tier: 't', blocks: [note] });
    expect(ok).toBe(false);
    expect(saved).toBe(0);
  });

  it('autoSaveSession grava quando há mensagem OU rótulo', () => {
    let saved = 0;
    const store = { save: () => (saved++, true) } as unknown as SessionStore;
    expect(autoSaveSession(store, { id: 'x', cwd: '/p', tier: 't', blocks: [note, you] })).toBe(
      true,
    );
    expect(
      autoSaveSession(store, { id: 'y', cwd: '/p', tier: 't', blocks: [note], label: 'setup' }),
    ).toBe(true);
    expect(saved).toBe(2);
  });
});
