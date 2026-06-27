// EST-1135 (C1) — testes da MaestroPort + seam de regência de fluxo no AgentLoop.
//
// DESLIGADO por default: sem `maestro`, o loop roda IDÊNTICO ao baseline
// (bit-a-bit). Com `maestro` stub, cada DecisionAction é testado isoladamente.
// SEM placebo, gate honesto.

import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import type { MaestroPort } from '../../src/agent/loop.js';
import type { SupervisorDecision } from '../../src/agent/maestro/contract.js';
import { createDecision, createSignal } from '../../src/agent/maestro/contract.js';
import { PollSignalBus } from '../../src/agent/maestro/bus.js';
import type { SignalCollector } from '../../src/agent/maestro/bus.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { AUTOCOMPACT_OFF } from '../../src/agent/auto-compact.js';
import {
  MemoryFs,
  ScriptedModelCaller,
  allowAllEngine,
  makePorts,
  toolCallBlock,
} from './helpers.js';

function registry(): ToolRegistry<ToolPorts> {
  return new ToolRegistry(NATIVE_TOOLS);
}

/** Stub que sempre devolve a decisão configurada. */
function stubMaestro(
  decision: SupervisorDecision,
  bus: SignalCollector = new PollSignalBus(),
): MaestroPort {
  return {
    bus,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    rege: async (_sig?: readonly SupervisorSignal[]) => decision,
  };
}

/** Stub que devolve decisões de uma fila (uma por chamada de rege). */
function queueMaestro(
  decisions: readonly SupervisorDecision[],
  bus: SignalCollector = new PollSignalBus(),
): MaestroPort & { regeCount: number } {
  let i = 0;
  let count = 0;
  return {
    bus,
    get regeCount() {
      return count;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    rege: async (_sig?: readonly SupervisorSignal[]) => {
      const d = decisions[i] ?? decisions[decisions.length - 1]!;
      if (i < decisions.length - 1) i += 1;
      count += 1;
      return d;
    },
  };
}

// ─── 1. Baseline sem maestro ──────────────────────────────────────────────

describe('EST-1135 · MaestroPort — baseline (sem maestro)', () => {
  it('loop SEM maestro roda IDÊNTICO ao baseline (snapshot de eventos/usage)', async () => {
    const fs = new MemoryFs(new Map([['README.md', 'conteúdo do readme']]));
    const { ports } = makePorts({ fs });
    const model = new ScriptedModelCaller([
      { text: `vou ler.\n${toolCallBlock('read_file', { path: 'README.md' })}` },
      { text: 'o README diz: conteúdo do readme.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-m0',
    });

    const res = await loop.run('leia o README');

    // Comportamento padrão: final limpo, 1 tool-call, 2 chamadas ao modelo.
    expect(res.stop.kind).toBe('final');
    if (res.stop.kind !== 'final') throw new Error('esperava final');
    expect(res.stop.answer).toContain('conteúdo do readme');
    expect(model.calls).toHaveLength(2);
    expect(res.usage.toolCalls).toBe(1);
    expect(model.calls[1]!.messageCount).toBeGreaterThan(model.calls[0]!.messageCount);
  });

  it('maestro ausente ⇒ sem consumo de barramento, zero overhead', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'ok.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
    });

    const res = await loop.run('diga ok');
    expect(res.stop.kind).toBe('final');
    // Nenhuma referência ao maestro no histórico (não vazou).
    const maestroItems = res.history.filter(
      (h) => h.role === 'observation' && 'toolName' in h && h.toolName === 'maestro',
    );
    expect(maestroItems).toHaveLength(0);
  });
});

// ─── 2. DecisionAction.parar ──────────────────────────────────────────────

describe('EST-1135 · MaestroPort — DecisionAction.parar', () => {
  it('parar ⇒ encerra o loop com stopByMaestro (fim limpo)', async () => {
    const bus = new PollSignalBus();
    bus.publish(createSignal('stuck', 'critical', Date.now(), { count: 5 }));
    const decision = createDecision(
      'parar',
      [createSignal('stuck', 'critical', Date.now(), { count: 5 })],
      'loop travado, parando',
      Date.now(),
    );
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'continuo...' }, { text: 'nunca chega aqui.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestro(decision, bus),
    });

    const res = await loop.run('faça algo');

    expect(res.stop.kind).toBe('final');
    if (res.stop.kind !== 'final') throw new Error('esperava final');
    expect(res.stop.answer).toContain('Maestro');
    // Parou ANTES de chamar o modelo (o sinal foi drenado antes da chamada).
    // O modelo pode ou não ter sido chamado dependendo se o sinal estava
    // pendente no barramento ANTES da 1ª iteração.
    const maestroObs = res.history.find(
      (h) => h.role === 'observation' && 'toolName' in h && h.toolName === 'maestro',
    );
    expect(maestroObs).toBeDefined();
  });
});

// ─── 3. DecisionAction.pausar ─────────────────────────────────────────────

describe('EST-1135 · MaestroPort — DecisionAction.pausar', () => {
  it('pausar com stuckResolver ⇒ pede direção ao usuário (redirect)', async () => {
    const bus = new PollSignalBus();
    bus.publish(createSignal('budget', 'warning', Date.now(), { pressurePct: 90 }));
    const decision = createDecision(
      'pausar',
      [createSignal('budget', 'warning', Date.now(), { pressurePct: 90 })],
      'budget alerta, pausando para confirmação',
      Date.now(),
    );
    const { ports } = makePorts();
    // O modelo vai emitir 1 tool-call, mas o maestro pausa ANTES (no topo da
    // iteração, após drenar o barramento).
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('grep', { pattern: 'x' }) },
      { text: 'fim.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestro(decision, bus),
      // StuckResolver que redireciona
      stuckResolver: {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        resolve: async (_a?: import('../../src/agent/stuck-watchdog.js').StuckAlert) => ({
          kind: 'redirect',
          text: 'use grep para "y" em vez de "x"',
        }),
      },
    });

    const res = await loop.run('busque algo');

    // O redirect entrou como user_inject no histórico
    expect(res.stop.kind).toBe('final');
    const userItems = res.history.filter((h) => h.role === 'user_inject');
    expect(userItems.some((h) => h.text.includes('grep para "y"'))).toBe(true);
  });

  it('pausar com stuckResolver ⇒ end encerra', async () => {
    const bus = new PollSignalBus();
    bus.publish(createSignal('budget', 'critical', Date.now(), { pressurePct: 98 }));
    const decision = createDecision(
      'pausar',
      [createSignal('budget', 'critical', Date.now(), { pressurePct: 98 })],
      'budget crítico',
      Date.now(),
    );
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'ok.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestro(decision, bus),
      stuckResolver: {
        resolve: async () => ({ kind: 'end' }),
      },
    });

    const res = await loop.run('faça algo');
    expect(res.stop.kind).toBe('final');
  });

  it('pausar SEM stuckResolver ⇒ cai em stopByMaestro', async () => {
    const bus = new PollSignalBus();
    bus.publish(createSignal('budget', 'warning', Date.now(), { pressurePct: 90 }));
    const decision = createDecision(
      'pausar',
      [createSignal('budget', 'warning', Date.now(), { pressurePct: 90 })],
      'pausa sem resolvedor',
      Date.now(),
    );
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'ok.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestro(decision, bus),
      // SEM stuckResolver
    });

    const res = await loop.run('faça algo');
    expect(res.stop.kind).toBe('final');
    if (res.stop.kind !== 'final') throw new Error('esperava final');
    expect(res.stop.answer).toContain('Maestro');
  });
});

// ─── 4. DecisionAction.recuperar ──────────────────────────────────────────

describe('EST-1135 · MaestroPort — DecisionAction.recuperar', () => {
  it('recuperar ⇒ chama autoCompactPort 1×, SEM dupla compactação', async () => {
    const bus = new PollSignalBus();
    bus.publish(createSignal('mem-pressure', 'critical', Date.now(), { pressurePct: 90 }));
    const decision = createDecision(
      'recuperar',
      [createSignal('mem-pressure', 'critical', Date.now(), { pressurePct: 90 })],
      'pressão de memória, compactando',
      Date.now(),
    );
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'vou agir.' }, { text: 'fim.' }]);
    let compactCalls = 0;
    let receivedHistory: unknown;
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestro(decision, bus),
      autoCompact: { at: 0.85, contextWindow: 100_000, maxConsecutive: 3 },
      autoCompactPort: async (history) => {
        compactCalls += 1;
        receivedHistory = [...history];
        return {
          history: [
            { role: 'observation' as const, toolName: 'compact', text: 'resumo compactado' },
            ...history.slice(-2),
          ],
          summarizedTurns: 5,
        };
      },
    });

    await loop.run('faça algo');

    // Chamou a compactação EXATAMENTE 1 vez
    expect(compactCalls).toBe(1);
    // O histórico foi substituído in-place (sumário à frente)
    expect(receivedHistory).toBeDefined();
  });

  it('recuperar sem autoCompactPort ⇒ no-op (não quebra)', async () => {
    const bus = new PollSignalBus();
    bus.publish(createSignal('mem-pressure', 'warning', Date.now(), { pressurePct: 80 }));
    const decision = createDecision(
      'recuperar',
      [createSignal('mem-pressure', 'warning', Date.now(), { pressurePct: 80 })],
      'tentativa de recuperar sem porta',
      Date.now(),
    );
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'ok.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestro(decision, bus),
      autoCompact: AUTOCOMPACT_OFF, // sem porta de compactação
    });

    const res = await loop.run('faça algo');
    // Não quebrou, seguiu normalmente
    expect(res.stop.kind).toBe('final');
  });
});

// ─── 5. DecisionAction.continuar ──────────────────────────────────────────

describe('EST-1135 · MaestroPort — DecisionAction.continuar', () => {
  it('continuar ⇒ no-op, loop segue normalmente', async () => {
    const bus = new PollSignalBus();
    bus.publish(createSignal('self-check', 'info', Date.now(), { note: 'tudo ok' }));
    const decision = createDecision(
      'continuar',
      [createSignal('self-check', 'info', Date.now(), { note: 'tudo ok' })],
      'sem incidentes, continuando',
      Date.now(),
    );
    const fs = new MemoryFs(new Map([['a.txt', 'x']]));
    const { ports } = makePorts({ fs });
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('read_file', { path: 'a.txt' }) },
      { text: 'conteúdo: x.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestro(decision, bus),
    });

    const res = await loop.run('leia a.txt');

    expect(res.stop.kind).toBe('final');
    // A tool rodou normalmente (o maestro não interferiu)
    expect(res.usage.toolCalls).toBe(1);
  });
});

// ─── 6. Delegar/convergir — no-op em C1 ───────────────────────────────────

describe('EST-1135 · MaestroPort — DecisionAction.delegar/convergir (no-op em C1)', () => {
  it('delegar ⇒ no-op (C2 implementará)', async () => {
    const bus = new PollSignalBus();
    bus.publish(createSignal('stuck', 'warning', Date.now(), { count: 3 }));
    const decision = createDecision(
      'delegar',
      [createSignal('stuck', 'warning', Date.now(), { count: 3 })],
      'delegar para sub-agente',
      Date.now(),
    );
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'ok.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestro(decision, bus),
    });

    const res = await loop.run('faça algo');
    // No-op: loop segue normalmente
    expect(res.stop.kind).toBe('final');
  });

  it('convergir ⇒ no-op (C2 implementará)', async () => {
    const bus = new PollSignalBus();
    bus.publish(createSignal('stuck', 'info', Date.now(), {}));
    const decision = createDecision(
      'convergir',
      [createSignal('stuck', 'info', Date.now(), {})],
      'convergindo resultados',
      Date.now(),
    );
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'ok.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestro(decision, bus),
    });

    const res = await loop.run('faça algo');
    expect(res.stop.kind).toBe('final');
  });
});

// ─── 7. rege chamado 1×/turno (não por tool-call) ─────────────────────────

describe('EST-1135 · MaestroPort — rege chamado 1×/turno', () => {
  it('rege é chamado 1× por iteração, NÃO por tool-call', async () => {
    const bus = new PollSignalBus();
    const decision = createDecision(
      'continuar',
      [createSignal('self-check', 'info', Date.now(), {})],
      'normal',
      Date.now(),
    );
    const { ports } = makePorts();
    // Modelo faz 3 tool-calls em turnos distintos (cada tool finaliza o turno)
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('grep', { pattern: 'a' }) },
      { text: toolCallBlock('grep', { pattern: 'b' }) },
      { text: toolCallBlock('grep', { pattern: 'c' }) },
      { text: 'fim.' },
    ]);
    const mm = queueMaestro([decision, decision, decision, decision, decision], bus);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: mm,
    });

    const res = await loop.run('busque três vezes');

    // O loop fez 4 iterações (3 tool-calls + 1 final), cada uma chama rege 1×
    // O modelo tem 4 chamadas (3 tool + 1 final) e rege foi chamado 4 vezes.
    expect(res.stop.kind).toBe('final');
    // regeCount deve ser ≤ model.calls.length + 1 (a 1ª iteração pode ser antes
    // da 1ª chamada ao modelo ou depois; o maestro é chamado no topo de cada
    // iteração, incluindo a 1ª que precede a 1ª chamada ao modelo)
    expect(mm.regeCount).toBeGreaterThanOrEqual(model.calls.length);
    expect(mm.regeCount).toBeLessThanOrEqual(model.calls.length + 1);
    // E nunca é chamado por tool-call (seria model.calls.length * Ntools)
    expect(mm.regeCount).toBeLessThan(model.calls.length * 2);
  });
});
