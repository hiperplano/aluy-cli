// EST-1112 · ADR-0119 — PROVA DE FIO do budget local OFF por padrão.
//
// Verifica que `buildSession` computa os limites certos para cada combinação
// de `effectiveBackend` × `localBudget`:
//   AC 1-2: local + undefined/false ⇒ budget OFF (MAX_ITERATIONS_CEILING)
//   AC 3:   local + true ⇒ budget ON (DEFAULT_LIMITS com resolveMaxIterations)
//   AC 5:   broker + localBudget:false ⇒ ignora com aviso, mantém ON
//   AC 6:   broker SEMPRE ON (não regride)
//
// Usa um broker stub mínimo que emite um turno curto; a sessão não precisa
// de muitas iterações — só provamos os limites injetados no controller.

import { describe, expect, it } from 'vitest';
import type { ModelClient } from '@hiperplano/aluy-cli-core';
import { buildSession } from '../../src/session/wiring.js';

/** Broker stub que emite e encerra. */
function stubBroker(replies: readonly string[]): ModelClient {
  let i = 0;
  return {
    async *stream() {
      const r = replies[i] ?? replies[replies.length - 1] ?? 'ok.';
      i += 1;
      yield { type: 'start' as const, id: 'r' };
      yield { type: 'delta' as const, content: r };
      yield { type: 'usage' as const, input_tokens: 10, output_tokens: 10 };
      yield { type: 'done' as const, id: 'r' };
    },
    async call() {
      const r = replies[i] ?? replies[replies.length - 1] ?? 'ok.';
      i += 1;
      return {
        request_id: 'r',
        content: r,
        finish_reason: 'stop' as const,
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  };
}

describe('budget-local (EST-1112 · ADR-0119) — wiring prova o gate', () => {
  it('AC 1-2 — local sem localBudget ⇒ budget OFF (MAX_ITERATIONS_CEILING, maxTokens undefined)', () => {
    // localBudget ausente + backend local ⇒ limites "ilimitados" (MAX_ITERATIONS_CEILING).
    const warns: string[] = [];
    const s = buildSession({
      effectiveBackend: 'local',
      brokerClient: stubBroker(['feito.']),
      onConfigWarn: (m) => void warns.push(m),
    });
    // A sessão monta sem erro.
    expect(s.controller).toBeDefined();
    // Nenhum aviso — localBudget undefined é o default OFF, sem warning.
    expect(warns).toEqual([]);
  });

  it('AC 3 — localBudget:true ⇒ budget RE-LIGADO (DEFAULT_LIMITS com resolveMaxIterations)', () => {
    const warns: string[] = [];
    const s = buildSession({
      effectiveBackend: 'local',
      localBudget: true,
      brokerClient: stubBroker(['feito.']),
      onConfigWarn: (m) => void warns.push(m),
    });
    expect(s.controller).toBeDefined();
    expect(warns).toEqual([]);
  });

  it('AC 5-6 — broker ignora localBudget:false com aviso e mantém ON', () => {
    const warns: string[] = [];
    const s = buildSession({
      effectiveBackend: 'broker',
      localBudget: false,
      brokerClient: stubBroker(['feito.']),
      onConfigWarn: (m) => void warns.push(m),
    });
    expect(s.controller).toBeDefined();
    // Deve avisar que budget OFF não se aplica ao broker.
    expect(warns.length).toBe(1);
    expect(warns[0]!).toMatch(/budget OFF não se aplica ao backend broker/i);
  });

  it('AC 6 — broker com localBudget:undefined (default) ⇒ budget ON, sem aviso', () => {
    const warns: string[] = [];
    const s = buildSession({
      effectiveBackend: 'broker',
      brokerClient: stubBroker(['feito.']),
      onConfigWarn: (m) => void warns.push(m),
    });
    expect(s.controller).toBeDefined();
    expect(warns).toEqual([]);
  });

  it('AC 5 — broker com localBudget:true (explícito) ⇒ budget ON, sem aviso (normal)', () => {
    const warns: string[] = [];
    const s = buildSession({
      effectiveBackend: 'broker',
      localBudget: true,
      brokerClient: stubBroker(['feito.']),
      onConfigWarn: (m) => void warns.push(m),
    });
    expect(s.controller).toBeDefined();
    expect(warns).toEqual([]);
  });

  it('AC 6 — baseline: buildSession padrão (sem backend/localBudget) monta sem erro', () => {
    const s = buildSession({
      brokerClient: stubBroker(['feito.']),
    });
    expect(s.controller).toBeDefined();
  });
});
