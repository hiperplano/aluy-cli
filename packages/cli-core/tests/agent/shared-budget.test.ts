// EST-0948 · EST-0969 (E-A2) — extend()/reset() do SharedBudget (orçamento AGREGADO).
//
// O `[c] continuar` ESTENDE o MESMO contador compartilhado pelo pai e pelos filhos
// paralelos — estender aqui dá folga à árvore TODA de uma vez (E-A2 preservado). O
// `reset()` re-arma o agregado p/ um novo objetivo. Aqui provamos a mecânica de teto
// (a atomicidade da reserva já tem testes próprios no subagent/loop).

import { describe, expect, it } from 'vitest';
import { SharedBudget } from '../../src/agent/shared-budget.js';
import { MAX_TOKENS_CEILING } from '../../src/agent/limits.js';

describe('EST-0948 — SharedBudget.extend (re-arma o teto AGREGADO, RETOMA)', () => {
  it('sobe tokens+iterações+tool-calls SEM zerar os contadores', () => {
    const b = new SharedBudget({ maxIterations: 1, maxToolCalls: 1, maxTokens: 100 });
    expect(b.tryConsumeIteration().ok).toBe(true);
    expect(b.tryConsumeToolCall().ok).toBe(true);
    b.addTokens(100);
    // tudo no teto ⇒ peek estoura
    expect(b.peekExceeded()).not.toBeNull();
    b.extend(100, 50);
    // contadores PRESERVADOS
    expect(b.usage).toEqual({ iterations: 1, toolCalls: 1, tokens: 100 });
    // agora cabe sob os tetos novos
    expect(b.peekExceeded()).toBeNull();
    expect(b.tryConsumeIteration().ok).toBe(true);
    expect(b.tryConsumeToolCall().ok).toBe(true);
  });

  it('é CLAMPADO no teto-teto (anti-runaway agregado preservado)', () => {
    const b = new SharedBudget({
      maxIterations: 1,
      maxToolCalls: 1,
      maxTokens: MAX_TOKENS_CEILING,
    });
    b.extend(MAX_TOKENS_CEILING, 50); // tentaria dobrar
    b.addTokens(MAX_TOKENS_CEILING);
    expect(b.tokensExceeded()).toBe(true); // o clamp segurou
  });

  it('sem maxTokens só estende iterações/tool-calls', () => {
    const b = new SharedBudget({ maxIterations: 1, maxToolCalls: 1 });
    b.extend(999_999, 10);
    b.addTokens(10_000_000);
    expect(b.tokensExceeded()).toBe(false);
  });
});

describe('EST-0948 — SharedBudget.reset (re-arma o agregado p/ novo objetivo)', () => {
  it('zera contadores E restaura os tetos originais (desfaz extend)', () => {
    const b = new SharedBudget({ maxIterations: 2, maxToolCalls: 2, maxTokens: 100 });
    b.tryConsumeIteration();
    b.tryConsumeToolCall();
    b.addTokens(50);
    b.extend(1000, 100);
    b.reset();
    expect(b.usage).toEqual({ iterations: 0, toolCalls: 0, tokens: 0 });
    // tetos restaurados: 100 tokens dispara de novo
    b.addTokens(100);
    expect(b.tokensExceeded()).toBe(true);
  });
});
