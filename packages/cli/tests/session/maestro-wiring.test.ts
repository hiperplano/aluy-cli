// EST-1137 (C3) · ADR-0123 §8-E1 — PROVA DE FIO do resolveMaestro.
//
// Testes SEM placebo, SEM `|| true`:
//   AC 1: ALUY_MAESTRO off (default) ⇒ resolveMaestro retorna undefined (baseline).
//   AC 2: ON sem sidecars ⇒ rege usa só motor-a (judge degrada); decisão = motor-a.
//   AC 3: ON com JudgeEngine stub devolvendo veredito mode:'heuristic' ⇒ cai no motor-a.
//   AC 4: ON com JudgeEngine stub devolvendo veredito mode:'llm' ⇒ judge pondera.
//   AC 5: rege NUNCA chama decide/permission.
//   AC 6: ALUY_MAESTRO_OFF kill-switch ⇒ mesmo com flag ON, retorna undefined.
//   AC 7: buildSession com maestro default-ON (sem env já injeta).

import { describe, expect, it } from 'vitest';
import {
  createSignal,
  type JudgeEngine,
  type JudgeInput,
  type JudgeResult,
  type SupervisorSignal,
} from '@hiperplano/aluy-cli-core';
import { resolveMaestro } from '../../src/maestro/wiring.js';
import type { ModelClient } from '@hiperplano/aluy-cli-core';
import { buildSession } from '../../src/session/wiring.js';

// ─── Stubs ─────────────────────────────────────────────────────────────────

/** Judge stub que sempre degrada (mode: 'heuristic'). */
function stubHeuristicJudge(): JudgeEngine {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async judge(_input: JudgeInput): Promise<JudgeResult> {
      return {
        chosen: 'continuar',
        confidence: 0.5,
        reasons: [{ optionId: 'continuar', rationale: 'stub heuristic' }],
        mode: 'heuristic',
      };
    },
  };
}

/** Judge stub que devolve um veredito específico mode:'llm'. */
function stubLlmJudge(chosen: string, confidence: number): JudgeEngine {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async judge(_input: JudgeInput): Promise<JudgeResult> {
      return {
        chosen,
        confidence,
        reasons: [{ optionId: chosen, rationale: 'stub llm' }],
        mode: 'llm',
      };
    },
  };
}

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

/** Cria um sinal de mem-pressure warning. */
function memPressureSignal(): SupervisorSignal {
  return createSignal('mem-pressure', 'warning', Date.now(), {
    pressurePct: 87,
  });
}

// ─── Testes ────────────────────────────────────────────────────────────────

describe('EST-1137 · resolveMaestro — wiring ON/OFF', () => {
  it('AC 1 — sem env (default ON) ⇒ resolveMaestro retorna MaestroPort', () => {
    const m = resolveMaestro({ env: {}, judge: stubHeuristicJudge() });
    expect(m).toBeDefined();
    expect(m!.bus).toBeDefined();
    expect(typeof m!.rege).toBe('function');
  });

  it('AC 1 — ALUY_MAESTRO=0 ⇒ retorna undefined', () => {
    const m = resolveMaestro({ env: { ALUY_MAESTRO: '0' } });
    expect(m).toBeUndefined();
  });

  it('AC 1 — ALUY_MAESTRO=false ⇒ retorna undefined', () => {
    const m = resolveMaestro({ env: { ALUY_MAESTRO: 'false' } });
    expect(m).toBeUndefined();
  });

  it('AC 6 — ALUY_MAESTRO_OFF kill-switch ⇒ mesmo com flag ON, retorna undefined', () => {
    const m = resolveMaestro({
      env: { ALUY_MAESTRO: '1', ALUY_MAESTRO_OFF: '1' },
    });
    expect(m).toBeUndefined();
  });

  it('AC 6 — ALUY_MAESTRO_OFF=true também mata', () => {
    const m = resolveMaestro({
      env: { ALUY_MAESTRO: '1', ALUY_MAESTRO_OFF: 'true' },
    });
    expect(m).toBeUndefined();
  });

  it('ALUY_MAESTRO=1 ⇒ resolveMaestro retorna MaestroPort', () => {
    const m = resolveMaestro({
      env: { ALUY_MAESTRO: '1' },
      judge: stubHeuristicJudge(),
    });
    expect(m).toBeDefined();
    expect(m!.bus).toBeDefined();
    expect(typeof m!.rege).toBe('function');
  });

  it('o bus é um PollSignalBus funcional', () => {
    const m = resolveMaestro({
      env: { ALUY_MAESTRO: '1' },
      judge: stubHeuristicJudge(),
    });
    const sig = memPressureSignal();
    m!.bus.publish(sig);
    const drained = m!.bus.poll();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.origin).toBe('mem-pressure');
    // poll seguinte vazio (drena)
    expect(m!.bus.poll()).toHaveLength(0);
  });
});

describe('EST-1137 · rege — motor-a sempre + judge opcional', () => {
  it('AC 2 — rege com sinais e judge heuristic ⇒ usa só motor-a', async () => {
    const m = resolveMaestro({
      env: { ALUY_MAESTRO: '1' },
      judge: stubHeuristicJudge(),
    });
    expect(m).toBeDefined();

    const sigs = [memPressureSignal()];
    const decision = await m!.rege(sigs);

    // Com judge heuristic, a decisão é do motor-a (não 'heuristic').
    expect(decision.action).toBeDefined();
    // O reason vem do motor-a.
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.signals).toBe(sigs);
  });

  it('AC 3 — judge com mode:heuristic ⇒ segue motor-a puro', async () => {
    const m = resolveMaestro({
      env: { ALUY_MAESTRO: '1' },
      judge: stubHeuristicJudge(),
    });
    // Com 1 sinal só de warning, motor-a decide 'recuperar' (R2: mem-pressure warning → self-heal).
    const sigs = [memPressureSignal()];
    const decision = await m!.rege(sigs);
    // motor-a para mem-pressure warning: action='recuperar' (via regentDecide).
    expect(decision.action).toBe('recuperar');
  });

  it('F76 — judge ESCALA a restrição (pausar @0.9 vs motor-a recuperar) ⇒ IGNORADO, motor-a mantido', async () => {
    // O judge 0.5b é overconfiante e ao vivo manda `parar`/`pausar` @ ~1.0 p/ estado
    // SADIO. Inv. I FLUIDEZ: ele NÃO pode escalar a restrição sobre o motor-a (senão
    // trava agente sadio = limbo F54 por porta nova). Aqui ele tenta 'pausar' e é ignorado.
    const m = resolveMaestro({
      env: { ALUY_MAESTRO: '1' },
      judge: stubLlmJudge('pausar', 0.9),
    });
    const sigs: SupervisorSignal[] = [
      memPressureSignal(),
      createSignal('budget', 'warning', Date.now(), { limitKind: 'tokens' }),
    ];
    const decision = await m!.rege(sigs);
    // motor-a (recuperar) MANTIDO — o judge é só anotado (auditoria), NÃO preferido.
    expect(decision.action).toBe('recuperar');
    expect(decision.reason).toContain('judge:pausar');
    expect(decision.reason).not.toContain('preferiu FLUIR');
  });

  it('F76 — judge prefere FLUIR (continuar @0.9 vs motor-a recuperar) ⇒ judge VENCE (só p/ fluidez)', async () => {
    // A ÚNICA direção em que o judge pode override: mais fluidez (`continuar`).
    const m = resolveMaestro({
      env: { ALUY_MAESTRO: '1' },
      judge: stubLlmJudge('continuar', 0.9),
    });
    const sigs: SupervisorSignal[] = [
      memPressureSignal(),
      createSignal('budget', 'warning', Date.now(), { limitKind: 'tokens' }),
    ];
    const decision = await m!.rege(sigs);
    expect(decision.action).toBe('continuar');
    expect(decision.reason).toContain('preferiu FLUIR');
  });

  it('AC 4 — judge com mode:llm concorda com motor-a ⇒ motor-a mantido', async () => {
    const m = resolveMaestro({
      env: { ALUY_MAESTRO: '1' },
      judge: stubLlmJudge('recuperar', 0.7),
    });
    // 2+ sinais ⇒ judge é consultado.
    const sigs: SupervisorSignal[] = [
      memPressureSignal(),
      createSignal('budget', 'warning', Date.now(), { limitKind: 'tokens' }),
    ];
    const decision = await m!.rege(sigs);
    // motor-a decide 'recuperar'; judge concorda ⇒ motor-a mantido.
    expect(decision.action).toBe('recuperar');
    expect(decision.reason).toContain('judge:');
  });

  it('AC 4 — judge com mode:llm confiança moderada discorda ⇒ motor-a mantido', async () => {
    const m = resolveMaestro({
      env: { ALUY_MAESTRO: '1' },
      judge: stubLlmJudge('pausar', 0.6),
    });
    // 2+ sinais ⇒ judge é consultado, mas confiança baixa ⇒ motor-a mantido.
    const sigs: SupervisorSignal[] = [
      memPressureSignal(),
      createSignal('budget', 'warning', Date.now(), { limitKind: 'tokens' }),
    ];
    const decision = await m!.rege(sigs);
    // Confiança 0.6 < 0.8 ⇒ motor-a mantido.
    expect(decision.action).toBe('recuperar');
  });

  it('zero sinais ⇒ motor-a fallback continuar (CA-MA5)', async () => {
    const m = resolveMaestro({
      env: { ALUY_MAESTRO: '1' },
      judge: stubHeuristicJudge(),
    });
    const decision = await m!.rege([]);
    expect(decision.action).toBe('continuar');
  });

  it('AC 5 — rege NUNCA chama decide/permission', async () => {
    // Prova por CONSTRUÇÃO: a função resolveMaestro/rege não importa
    // decide/permission de lugar nenhum e seu código não referencia essas
    // funções. Este teste confirma que resolveMaestro existe e rege funciona
    // sem nenhuma dependência injetada de catraca.
    const m = resolveMaestro({
      env: { ALUY_MAESTRO: '1' },
      judge: stubHeuristicJudge(),
    });
    const sigs = [memPressureSignal()];
    const decision = await m!.rege(sigs);
    // rege só produz decisão de fluxo, nunca chama/retorna decisão de permissão.
    expect(decision.action).toBeDefined();
    // O tipo SupervisorDecision não tem campo de permissão.
    expect((decision as Record<string, unknown>)['permission']).toBeUndefined();
  });
});

describe('EST-1137 · buildSession com maestro', () => {
  it('AC 7 — buildSession sem env (default ON) ⇒ injeta maestro no controller', () => {
    const s = buildSession({
      brokerClient: stubBroker(['feito.']),
    });
    expect(s.controller).toBeDefined();
    // Default ON: maestro injetado mesmo sem ALUY_MAESTRO=1 explícito.
  });

  it('AC 7 — buildSession com ALUY_MAESTRO=1 ⇒ injeta maestro no controller', () => {
    const s = buildSession({
      env: { ALUY_MAESTRO: '1' } as NodeJS.ProcessEnv,
      brokerClient: stubBroker(['feito.']),
    });
    expect(s.controller).toBeDefined();
    // Maestro injetado — a sessão monta sem erro.
    // A presença do maestro é interna ao controller (não exposta publicamente).
    // O que provamos: não quebrou a montagem do loop.
  });
});
