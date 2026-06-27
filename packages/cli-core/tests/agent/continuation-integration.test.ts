// F54 (fix de integração) — prova que a CONTINUAÇÃO dispara DE VERDADE no loop,
// não só na função pura. Antes, o loop chamava `watchdog.isAnnounceNoTool()` (método
// inexistente ⇒ sempre false ⇒ continuação MORTA). Aqui rodamos o AgentLoop real com
// um modelo que SEMPRE anuncia-sem-tool ("Vou direto ao ponto") e verificamos que o
// loop NUDGA e re-chama o modelo até o teto (giveUp), em vez de devolver na 1ª.

import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import type { MaestroPort } from '../../src/agent/loop.js';
import { createDecision, createSignal } from '../../src/agent/maestro/contract.js';
import { PollSignalBus } from '../../src/agent/maestro/bus.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { ContextGraph } from '../../src/agent/maestro/context-box-graph.js';
import { ScriptedModelCaller, allowAllEngine, makePorts } from './helpers.js';

function registry(): ToolRegistry<ToolPorts> {
  return new ToolRegistry(NATIVE_TOOLS);
}

function presentMaestro(): MaestroPort {
  const sig = createSignal('self-check', 'info', Date.now(), {});
  return {
    bus: new PollSignalBus(),
    rege: async () => createDecision('continuar', [sig], 'segue', Date.now()),
  };
}

describe('F54 INTEGRAÇÃO — continuação dispara no loop real (não só na função pura)', () => {
  it('modelo anúncia-sem-tool ("Vou direto ao ponto") ⇒ loop NUDGA e re-chama até giveUp', async () => {
    const { ports } = makePorts();
    // O modelo SEMPRE anuncia, nunca age (o caso degenerado do dono).
    const model = new ScriptedModelCaller(
      Array.from({ length: 12 }, () => ({ text: 'Vou direto ao ponto: encontrar e clicar.' })),
    );
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-cont-int',
      maestro: presentMaestro(),
      continuationConfig: { maxContinuations: 4, nudgeAt: 1, giveUpAt: 3 },
    });

    const res = await loop.run('faça a tarefa');

    // PROVA viva: COM a continuação, o modelo é chamado MAIS DE UMA VEZ (nudge + re-loop).
    // Com o código morto (antes), seria chamado 1× e devolveria na hora.
    expect(model.calls.length).toBeGreaterThan(1);
    // E o teto giveUp=3 segura o runaway: não vira loop infinito (≤ giveUp+1 chamadas).
    expect(model.calls.length).toBeLessThanOrEqual(4);
    // O loop devolve limpo no fim (não trava).
    expect(res.stop.kind).toBe('final');
    // Nudges de continuação foram injetados (canal trusted reanchor).
    const nudges = res.history.filter(
      (h) => h.role === 'reanchor' && /tool|anunci|emita/i.test(('text' in h && h.text) || ''),
    );
    expect(nudges.length).toBeGreaterThanOrEqual(1);
  });

  it('modelo que CONCLUI ("Pronto, o resultado é 4") ⇒ NÃO continua (devolve na 1ª)', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'Pronto! O resultado é 4.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-cont-done',
      maestro: presentMaestro(),
      continuationConfig: { maxContinuations: 4, nudgeAt: 1, giveUpAt: 3 },
    });

    const res = await loop.run('quanto é 2+2');
    // Conclusão não casa o detector ⇒ 1 chamada, devolve limpo (sem nudge à toa).
    expect(model.calls.length).toBe(1);
    expect(res.stop.kind).toBe('final');
  });

  // F67 (#463) — o modelo escorrega p/ INGLÊS apesar do system PT-BR. ANTES, a
  // detecção era PT-coloquial-só ⇒ anúncio EN devolvia false ⇒ o loop NÃO continuava
  // = limbo F54. Estas 2 provas fecham o "wired ≠ working": o FIX precisa disparar
  // (e NÃO super-disparar) ATRAVÉS DO LOOP REAL, não só na função pura.
  it('F67 — anúncio em INGLÊS ("Let me run the tests") ⇒ loop NUDGA e re-chama (não limba)', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller(
      Array.from({ length: 12 }, () => ({ text: 'Let me run the tests and check the output.' })),
    );
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-cont-en',
      maestro: presentMaestro(),
      continuationConfig: { maxContinuations: 4, nudgeAt: 1, giveUpAt: 3 },
    });

    const res = await loop.run('run the tests');
    // ANTES do #463: 1 chamada (limbo). AGORA: nudge + re-loop até o teto.
    expect(model.calls.length).toBeGreaterThan(1);
    expect(model.calls.length).toBeLessThanOrEqual(4);
    expect(res.stop.kind).toBe('final');
    const nudges = res.history.filter(
      (h) => h.role === 'reanchor' && /tool|anunci|emita/i.test(('text' in h && h.text) || ''),
    );
    expect(nudges.length).toBeGreaterThanOrEqual(1);
  });

  it('F67 — conclusão em INGLÊS ("Done. The answer is 42.") ⇒ NÃO continua (sem FP no loop)', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'Done. The answer is 42.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-cont-en-done',
      maestro: presentMaestro(),
      continuationConfig: { maxContinuations: 4, nudgeAt: 1, giveUpAt: 3 },
    });

    const res = await loop.run('what is 6 times 7');
    // Guarda de FP atravessa o loop: completa EN não vira nudge à toa.
    expect(model.calls.length).toBe(1);
    expect(res.stop.kind).toBe('final');
  });

  // F54 + F79 (wire §4) — o NOVO gatilho: o ContextGraph com passo `pending` faz o loop
  // continuar MESMO sem anúncio. Dá ao grafo seu 1º consumidor de DECISÃO (antes só visual).
  it('F79 — modelo conclui SEM anunciar MAS o plano tem passo pending ⇒ loop CONTINUA (grafo dispara)', async () => {
    const { ports } = makePorts();
    const graph = new ContextGraph();
    graph.openBox('s1', 'curto', 'passo 1');
    graph.openBox('s2', 'curto', 'passo 2');
    graph.closeBox('s1'); // s1 concluído; s2 segue `pending` (não-closed)
    const portsWithGraph = { ...ports, graph };
    // O texto NÃO casa isAnnounceNoTool ("Feito o passo 1.") ⇒ antes LIMBAVA (parava com s2 pendente).
    const model = new ScriptedModelCaller(
      Array.from({ length: 8 }, () => ({ text: 'Feito o passo 1.' })),
    );
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports: portsWithGraph,
      sessionId: 'sess-cont-plan',
      maestro: presentMaestro(),
      continuationConfig: { maxContinuations: 4, nudgeAt: 1, giveUpAt: 3 },
    });

    const res = await loop.run('faça o plano');
    // PROVA viva: com s2 pending no grafo, o loop CONTINUA (>1 chamada) — antes parava (limbo).
    expect(model.calls.length).toBeGreaterThan(1);
    // Os caps seguram o runaway (giveUp=3): ≤ giveUp+1 chamadas, nunca infinito.
    expect(model.calls.length).toBeLessThanOrEqual(4);
    expect(res.stop.kind).toBe('final');
    // Nudge ESPECÍFICO do plano-pendente foi injetado (não o do anúncio).
    const planNudges = res.history.filter(
      (h) => h.role === 'reanchor' && /plano|update_plan/i.test(('text' in h && h.text) || ''),
    );
    expect(planNudges.length).toBeGreaterThanOrEqual(1);
  });

  it('F79 — plano TODO concluído (zero pending) + conclui sem anunciar ⇒ NÃO continua (devolve na 1ª)', async () => {
    const { ports } = makePorts();
    const graph = new ContextGraph();
    graph.openBox('s1', 'curto', 'p1');
    graph.closeBox('s1'); // tudo `closed` ⇒ nada pendente
    const portsWithGraph = { ...ports, graph };
    const model = new ScriptedModelCaller([{ text: 'Pronto, tudo feito.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports: portsWithGraph,
      sessionId: 'sess-cont-plan-done',
      maestro: presentMaestro(),
      continuationConfig: { maxContinuations: 4, nudgeAt: 1, giveUpAt: 3 },
    });

    const res = await loop.run('faça o plano');
    expect(model.calls.length).toBe(1); // sem pending ⇒ não continua (sem nudge à toa)
    expect(res.stop.kind).toBe('final');
  });

  it('F79 — SEM grafo nos ports (baseline) + conclui sem anunciar ⇒ NÃO continua (não-regressão)', async () => {
    const { ports } = makePorts(); // sem graph
    const model = new ScriptedModelCaller([{ text: 'Pronto.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-cont-nograph',
      maestro: presentMaestro(),
      continuationConfig: { maxContinuations: 4, nudgeAt: 1, giveUpAt: 3 },
    });
    const res = await loop.run('x');
    expect(model.calls.length).toBe(1); // sem grafo ⇒ pendingPlan=false ⇒ baseline
    expect(res.stop.kind).toBe('final');
  });
});
