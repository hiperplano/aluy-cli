// F197 — testes da HEURÍSTICA de sugestão de próximo prompt (pura, sem modelo/tokens).
// Prova que o `TurnDigest` mapeia p/ os `NextSuggestionId` certos (a 1ª regra que casa
// dita o topo), que sem conversa NÃO há sugestão, e que a lista é deduplicada/capada.
//
// F199 — testes de `suggestionParams`: prova que os FATOS do digest viram params quando
// presentes, `undefined` (fallback genérico) quando ausentes, que um fato longo é
// TRUNCADO (composer de 1 linha) e que um segredo embutido num fato NUNCA vaza cru.

import { describe, expect, it } from 'vitest';
import {
  suggestNextPrompts,
  suggestionParams,
  type TurnDigest,
} from '../../src/agent/next-suggest.js';

/** Base neutra: houve conversa, nada característico. */
const base: TurnDigest = { hasConversation: true };

describe('F197 · suggestNextPrompts (heurística local)', () => {
  it('SEM conversa (boot/sessão fresca) ⇒ lista VAZIA (nada a sugerir)', () => {
    expect(suggestNextPrompts({ hasConversation: false })).toEqual([]);
    // mesmo com sinais, sem conversa não sugere.
    expect(suggestNextPrompts({ hasConversation: false, editedFiles: true })).toEqual([]);
  });

  it('editou E NÃO rodou testes ⇒ topo = RODAR os testes (reforça validar)', () => {
    const out = suggestNextPrompts({ ...base, editedFiles: true });
    expect(out[0]).toBe('run-tests');
  });

  it('rodou testes e FALHARAM ⇒ topo = corrigir as falhas', () => {
    const out = suggestNextPrompts({
      ...base,
      editedFiles: true,
      ranTests: true,
      testsFailed: true,
      hadError: true,
    });
    expect(out[0]).toBe('fix-failing');
  });

  it('editou e testes PASSARAM (verde) ⇒ topo = resumir o que mudou', () => {
    const out = suggestNextPrompts({ ...base, editedFiles: true, ranTests: true });
    expect(out[0]).toBe('summarize');
  });

  it('ERRO sem edição ⇒ topo = tentar outra abordagem', () => {
    const out = suggestNextPrompts({ ...base, hadError: true });
    expect(out[0]).toBe('retry-different');
  });

  it('só EXPLOROU (leu/buscou, nada editado) ⇒ topo = implementar', () => {
    const out = suggestNextPrompts({ ...base, explorationOnly: true });
    expect(out[0]).toBe('implement');
  });

  it('nada característico ⇒ fallback = próximo passo genérico', () => {
    expect(suggestNextPrompts(base)[0]).toBe('next-step');
  });

  it('`max` capa o tamanho e a lista é priorizada + deduplicada', () => {
    const full = suggestNextPrompts({ ...base, editedFiles: true }, { max: 3 });
    expect(full.length).toBeLessThanOrEqual(3);
    expect(new Set(full).size).toBe(full.length); // sem repetição
    // max: 1 ⇒ só o topo.
    expect(suggestNextPrompts({ ...base, editedFiles: true }, { max: 1 })).toEqual(['run-tests']);
  });
});

describe('F199 · suggestionParams (fato do turno → params de interpolação)', () => {
  it('fix-failing + failingTestName ⇒ { test }', () => {
    const p = suggestionParams('fix-failing', { ...base, failingTestName: 'soma deve dar 4' });
    expect(p).toEqual({ test: 'soma deve dar 4' });
  });

  it('fix-failing SEM failingTestName ⇒ undefined (cai no genérico)', () => {
    expect(suggestionParams('fix-failing', base)).toBeUndefined();
  });

  it('run-tests + testCommand ⇒ { command }', () => {
    const p = suggestionParams('run-tests', { ...base, testCommand: 'npx vitest run' });
    expect(p).toEqual({ command: 'npx vitest run' });
  });

  it('run-tests SEM testCommand ⇒ undefined', () => {
    expect(suggestionParams('run-tests', base)).toBeUndefined();
  });

  it('summarize + editedFileNames ⇒ { files } juntos por vírgula', () => {
    const p = suggestionParams('summarize', {
      ...base,
      editedFileNames: ['a.ts', 'b.ts'],
    });
    expect(p).toEqual({ files: 'a.ts, b.ts' });
  });

  it('summarize SEM editedFileNames (ausente ou vazio) ⇒ undefined', () => {
    expect(suggestionParams('summarize', base)).toBeUndefined();
    expect(suggestionParams('summarize', { ...base, editedFileNames: [] })).toBeUndefined();
  });

  it('summarize com MAIS de 2 arquivos ⇒ só os 2 primeiros (sem "e mais N")', () => {
    const p = suggestionParams('summarize', {
      ...base,
      editedFileNames: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
    });
    expect(p).toEqual({ files: 'a.ts, b.ts' });
  });

  it('retry-different + errorSummary ⇒ { error }', () => {
    const p = suggestionParams('retry-different', { ...base, errorSummary: 'ECONNREFUSED' });
    expect(p).toEqual({ error: 'ECONNREFUSED' });
  });

  it('retry-different SEM errorSummary ⇒ undefined', () => {
    expect(suggestionParams('retry-different', base)).toBeUndefined();
  });

  it('ids sem parametrização (explain/implement/next-step) ⇒ SEMPRE undefined', () => {
    const rico: TurnDigest = {
      hasConversation: true,
      editedFileNames: ['a.ts'],
      failingTestName: 'x',
      testCommand: 'npm test',
      errorSummary: 'boom',
    };
    expect(suggestionParams('explain', rico)).toBeUndefined();
    expect(suggestionParams('implement', rico)).toBeUndefined();
    expect(suggestionParams('next-step', rico)).toBeUndefined();
  });

  it('fato LONGO é TRUNCADO — o composer é 1 linha só', () => {
    const longName = 'x'.repeat(200);
    const p = suggestionParams('fix-failing', { ...base, failingTestName: longName });
    expect(p?.test.length).toBeLessThan(60);
    expect(p?.test.endsWith('…')).toBe(true);
  });

  it('comando LONGO é TRUNCADO', () => {
    const longCmd = `npx vitest run ${'a/'.repeat(80)}spec.ts`;
    const p = suggestionParams('run-tests', { ...base, testCommand: longCmd });
    expect(p?.command.length).toBeLessThan(60);
  });

  it('nome de arquivo LONGO (dentro da lista) também é truncado', () => {
    const longPath = `src/${'nested/'.repeat(20)}file.ts`;
    const p = suggestionParams('summarize', { ...base, editedFileNames: [longPath] });
    expect(p?.files.length).toBeLessThan(40);
    expect(p?.files.endsWith('…')).toBe(true);
  });

  it('SEGREDO embutido num fato NUNCA vaza cru na sugestão (CLI-SEC-4/6)', () => {
    const withSecret = 'falhou: Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
    const p = suggestionParams('retry-different', { ...base, errorSummary: withSecret });
    expect(p?.error).toBeDefined();
    expect(p?.error).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  });

  it('quebra de linha num fato vira espaço — o composer é 1 linha só', () => {
    const p = suggestionParams('retry-different', {
      ...base,
      errorSummary: 'linha 1\nlinha 2\nlinha 3',
    });
    expect(p?.error).not.toContain('\n');
  });
});
