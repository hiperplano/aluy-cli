// EST-1110 · ADR-0114 — o QuestionPort da TUI (controlador). Prova: publica o pendente,
// a UI o resolve UMA vez; fail-safe NÃO-PENDURA — não-interativo E abort ⇒ `unavailable`.

import { describe, expect, it } from 'vitest';
import type { QuestionSpec } from '@aluy/cli-core';
import { TuiQuestionResolver, type PendingQuestionEntry } from '../../src/ask/question-resolver.js';

const spec: QuestionSpec = {
  kind: 'single',
  question: 'Qual stack?',
  options: [{ label: 'Next' }, { label: 'Remix' }],
  allowOther: true,
};

describe('TuiQuestionResolver — controlador + fail-safe não-pendura', () => {
  it('publica o pendente e resolve com a resposta da UI (uma vez)', async () => {
    const resolver = new TuiQuestionResolver();
    let pending: PendingQuestionEntry | null = null;
    resolver.subscribe((p) => {
      pending = p;
    });
    const promise = resolver.ask(spec);
    expect(pending).not.toBeNull();
    expect(resolver.pending?.spec.question).toBe('Qual stack?');
    pending!.resolve({ kind: 'choice', index: 1, label: 'Remix' });
    const ans = await promise;
    expect(ans).toEqual({ kind: 'choice', index: 1, label: 'Remix' });
    // resolvido ⇒ pendente limpo (observador re-notificado com null)
    expect(resolver.pending).toBeNull();
  });

  it('CA-5: NÃO-INTERATIVO ⇒ resolve unavailable na hora (não pendura)', async () => {
    const resolver = new TuiQuestionResolver();
    resolver.setNonInteractive(true);
    const ans = await resolver.ask(spec);
    expect(ans.kind).toBe('unavailable');
  });

  it('CA-5: ABORT (Ctrl-C) durante a pergunta ⇒ unavailable', async () => {
    const ac = new AbortController();
    const resolver = new TuiQuestionResolver();
    const promise = resolver.ask(spec, ac.signal);
    ac.abort();
    const ans = await promise;
    expect(ans.kind).toBe('unavailable');
  });

  it('já abortado antes de começar ⇒ unavailable imediato', async () => {
    const ac = new AbortController();
    ac.abort();
    const resolver = new TuiQuestionResolver();
    const ans = await resolver.ask(spec, ac.signal);
    expect(ans.kind).toBe('unavailable');
  });
});
