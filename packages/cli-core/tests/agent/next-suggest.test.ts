// F197 — testes da HEURÍSTICA de sugestão de próximo prompt (pura, sem modelo/tokens).
// Prova que o `TurnDigest` mapeia p/ os `NextSuggestionId` certos (a 1ª regra que casa
// dita o topo), que sem conversa NÃO há sugestão, e que a lista é deduplicada/capada.

import { describe, expect, it } from 'vitest';
import { suggestNextPrompts, type TurnDigest } from '../../src/agent/next-suggest.js';

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
