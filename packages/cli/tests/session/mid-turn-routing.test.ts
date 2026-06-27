// EST-1015 — pai-ocioso responde sem enfileirar: a DECISÃO pura de rotear uma linha
// p/ resposta paralela (`askParallel`) quando há sub-agentes rodando.

import { describe, expect, it } from 'vitest';
import { answerInParallelWhileSubagents } from '../../src/session/mid-turn-routing.js';

const base = {
  subagentsRunning: true,
  isPlainGoal: true,
  nonEmpty: true,
  hasPendingAttachment: false,
};

describe('answerInParallelWhileSubagents — pai bloqueado nos sub-agentes', () => {
  it('texto puro não-vazio COM sub-agentes rodando ⇒ responde em paralelo', () => {
    expect(answerInParallelWhileSubagents(base)).toBe(true);
  });

  it('SEM sub-agentes rodando ⇒ NÃO (segue o encaixe/enfileirar normal)', () => {
    expect(answerInParallelWhileSubagents({ ...base, subagentsRunning: false })).toBe(false);
  });

  it('NÃO é texto puro (/slash ou !bang) ⇒ NÃO (comando precisa enfileirar/rotear)', () => {
    expect(answerInParallelWhileSubagents({ ...base, isPlainGoal: false })).toBe(false);
  });

  it('texto VAZIO ⇒ NÃO (nada a perguntar)', () => {
    expect(answerInParallelWhileSubagents({ ...base, nonEmpty: false })).toBe(false);
  });

  it('com anexo `@` PENDENTE ⇒ NÃO (anexo viaja como DADO pelo submit, não numa pergunta)', () => {
    expect(answerInParallelWhileSubagents({ ...base, hasPendingAttachment: true })).toBe(false);
  });

  it('só responde quando TODAS as condições batem (E lógico)', () => {
    // qualquer condição falsa ⇒ false; todas verdadeiras ⇒ true.
    expect(answerInParallelWhileSubagents(base)).toBe(true);
    for (const k of ['subagentsRunning', 'isPlainGoal', 'nonEmpty'] as const) {
      expect(answerInParallelWhileSubagents({ ...base, [k]: false })).toBe(false);
    }
    expect(answerInParallelWhileSubagents({ ...base, hasPendingAttachment: true })).toBe(false);
  });
});
