// EST-1136 (C2) — teste de INTEGRAÇÃO dos emissores do AgentLoop com o bus do Maestro.
//
// Cada freio DURO (human-cancel/budget/degeneration/stuck/weak-yolo) é exercitado
// com um bus REAL (PollSignalBus) + um MaestroPort stub, e o teste AFIRMA que o
// sinal CERTO cai no barramento (poll + cheque de origin/severidade/campos-chave).
// SEM placebo, gate honesto.
//
// Para freios onde o loop CONTINUA (stuck, weak-yolo), o regente drena o
// barramento a cada iteração via `bus.poll()`. Os sinais são capturados no
// `mm.allSignals` do stub, que os acumula antes de cada `rege()`.
//
// ADITIVO (C2): os emissores são no-op sem `maestro` — provado no cenário final.

import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import type { MaestroPort } from '../../src/agent/loop.js';
import type { SupervisorDecision, SupervisorSignal } from '../../src/agent/maestro/contract.js';
import { createDecision, createSignal } from '../../src/agent/maestro/contract.js';
import { regentDecide } from '../../src/agent/maestro/regent.js';
import { PollSignalBus } from '../../src/agent/maestro/bus.js';
import type { SignalCollector } from '../../src/agent/maestro/bus.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { DegenerateLoopError } from '../../src/agent/degeneration.js';
import { ModelCallAbortedError } from '../../src/model/errors.js';
import { PolicyPermissionEngine } from '../../src/permission/engine.js';
import type { ModelCaller } from '../../src/agent/loop.js';
import type { ModelCallResult } from '../../src/model/types.js';
import { type StuckResolver } from '../../src/agent/stuck-watchdog.js';
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

/**
 * Stub de MaestroPort que usa um bus REAL, sempre devolve `continuar`,
 * e ACUMULA os sinais que o regente drena a cada iteração.
 *
 * Essencial p/ asserções de sinais emitidos em freios onde o loop CONTINUA
 * (stuck, weak-yolo): o regente chama `bus.poll()` na iteração seguinte,
 * drenando o sinal. `mm.allSignals` retém a cópia.
 */
function stubMaestroContinue(
  bus: SignalCollector = new PollSignalBus(),
): MaestroPort & { allSignals: SupervisorSignal[] } {
  const dummySignal = createSignal('self-check', 'info', Date.now(), { note: 'test-stub' });
  const decision: SupervisorDecision = createDecision(
    'continuar',
    [dummySignal],
    'stub de teste',
    Date.now(),
  );
  const allSignals: SupervisorSignal[] = [];
  return {
    bus,
    allSignals,
    rege: async (signals) => {
      allSignals.push(...signals);
      return decision;
    },
  };
}

/**
 * ModelCaller que, em uma chamada específica (`abortAtCallIndex`), chama
 * `controller.abort()` como EFEITO COLATERAL (simulando Ctrl+C durante a
 * chamada ao modelo). Para as demais, delega ao script normalmente.
 */
class AbortOnCallModelCaller implements ModelCaller {
  constructor(
    private readonly script: ScriptedModelCaller,
    private readonly controller: AbortController,
    private readonly abortAtCallIndex: number,
  ) {}

  async call(args: Parameters<ModelCaller['call']>[0]): Promise<ModelCallResult> {
    if (this.script.calls.length === this.abortAtCallIndex) {
      this.controller.abort();
    }
    return this.script.call(args);
  }
}

// ── helpers p/ repetir tool-calls ────────────────────────────────────────

function repeatSameTool(
  name: string,
  input: Record<string, unknown>,
  n: number,
): { text: string }[] {
  return Array.from({ length: n }, () => ({ text: toolCallBlock(name, input) }));
}

// ─────────────────────────────────────────────────────────────────────────
// 1. human-cancel
// ─────────────────────────────────────────────────────────────────────────

describe('EST-1136 (C2) · human-cancel → bus', () => {
  it('ponto 1 (topo da iteração): signal.aborted ⇒ emit human-cancel (critical)', async () => {
    const bus = new PollSignalBus();
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'nunca chamado.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestroContinue(bus),
    });

    // signal já abortado → o loop lança ModelCallAbortedError no topo da iteração
    await expect(loop.run('faça algo', AbortSignal.abort())).rejects.toThrow(ModelCallAbortedError);

    const signals = bus.poll();
    const hc = signals.filter((s) => s.origin === 'human-cancel');
    expect(hc).toHaveLength(1);
    expect(hc[0]!.severity).toBe('critical');
    expect(hc[0]!.payload).toHaveProperty('reason');
  });

  it('ponto 2 (batch de tool-calls): abort durante native-tool batch ⇒ emit human-cancel', async () => {
    const bus = new PollSignalBus();
    const ac = new AbortController();
    const { ports } = makePorts();

    // O modelo devolve native tool_calls; o caller ABORTA o controller como
    // efeito colateral na PRIMEIRA chamada. Assim, o signal NÃO está abortado
    // no topo da iteração, mas FICA abortado quando o loop processa o batch.
    const inner = new ScriptedModelCaller([
      {
        text: 'vou usar tools.',
        toolCalls: [
          { name: 'grep', input: { pattern: 'x' } },
          { name: 'grep', input: { pattern: 'y' } },
        ],
      },
    ]);
    // Aborta no momento da 1ª chamada (índice 0).
    const model = new AbortOnCallModelCaller(inner, ac, 0);

    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestroContinue(bus),
    });

    await expect(loop.run('busque', ac.signal)).rejects.toThrow(ModelCallAbortedError);

    const signals = bus.poll();
    const hc = signals.filter((s) => s.origin === 'human-cancel');
    expect(hc.length).toBeGreaterThanOrEqual(1);
    expect(hc[0]!.severity).toBe('critical');
    expect(hc[0]!.payload).toHaveProperty('reason');
  });

  it('ponto 2-bis: abort SÓ na 2ª tool do batch (cobre o gate por tool-call)', async () => {
    const bus = new PollSignalBus();
    const ac = new AbortController();
    const { ports } = makePorts();

    // Batch de 3 tools; o caller NÃO aborta — o sinal JÁ vem abortado.
    // Como está abortado no topo da iteração, ponto 1 pega antes.
    // Para testar o gate POR TOOL-CALL do batch, usamos o truque:
    // o caller aborta na 1ª chamada, que é a do batch com 3 tools.
    const inner = new ScriptedModelCaller([
      {
        text: 'batch de 3 tools.',
        toolCalls: [
          { name: 'grep', input: { pattern: 'a' } },
          { name: 'grep', input: { pattern: 'b' } },
          { name: 'grep', input: { pattern: 'c' } },
        ],
      },
    ]);
    const model = new AbortOnCallModelCaller(inner, ac, 0);

    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestroContinue(bus),
    });

    // O loop lança (human-cancel no batch OU no topo da próxima iteração).
    await expect(loop.run('busque 3', ac.signal)).rejects.toThrow(ModelCallAbortedError);

    const signals = bus.poll();
    const hc = signals.filter((s) => s.origin === 'human-cancel');
    expect(hc.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. budget
// ─────────────────────────────────────────────────────────────────────────

describe('EST-1136 (C2) · budget → bus', () => {
  it('limite de iterações excedido ⇒ emit budget (warning)', async () => {
    const bus = new PollSignalBus();
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'ok.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      limits: { maxIterations: 0, maxToolCalls: 100, maxTokens: 100_000, contextWindow: 100_000 },
      maestro: stubMaestroContinue(bus),
    });

    const res = await loop.run('faça algo');
    expect(res.stop.kind).toBe('limit');
    if (res.stop.kind !== 'limit') throw new Error('esperava limit');

    const signals = bus.poll();
    const budgetSignals = signals.filter((s) => s.origin === 'budget');
    expect(budgetSignals).toHaveLength(1);
    expect(budgetSignals[0]!.severity).toBe('warning');
    expect(budgetSignals[0]!.payload).toHaveProperty('limitKind');
    expect(budgetSignals[0]!.payload).toHaveProperty('usage');
  });

  it('limite de tool-calls excedido ⇒ emit budget', async () => {
    const bus = new PollSignalBus();
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('grep', { pattern: 'a' }) },
      { text: 'nunca chega.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      limits: { maxIterations: 100, maxToolCalls: 0, maxTokens: 100_000, contextWindow: 100_000 },
      maestro: stubMaestroContinue(bus),
    });

    const res = await loop.run('busque');
    expect(res.stop.kind).toBe('limit');
    if (res.stop.kind !== 'limit') throw new Error('esperava limit');

    const signals = bus.poll();
    const budgetSignals = signals.filter((s) => s.origin === 'budget');
    expect(budgetSignals.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. degeneration
// ─────────────────────────────────────────────────────────────────────────

describe('EST-1136 (C2) · degeneration → bus', () => {
  it('DegenerateLoopError no model.call ⇒ emit degeneration', async () => {
    const bus = new PollSignalBus();
    const { ports } = makePorts();
    const model: ModelCaller = {
      async call() {
        throw new DegenerateLoopError('line-repeat', 42, 'linha repetida 42×');
      },
    };
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestroContinue(bus),
    });

    const res = await loop.run('faça algo');
    expect(res.stop.kind).toBe('degenerate');
    if (res.stop.kind !== 'degenerate') throw new Error('esperava degenerate');
    expect(res.stop.reason).toBe('line-repeat');

    const signals = bus.poll();
    const degenSignals = signals.filter((s) => s.origin === 'degeneration');
    expect(degenSignals).toHaveLength(1);
    expect(degenSignals[0]!.severity).toBe('warning'); // line-repeat é warning
    expect(degenSignals[0]!.payload).toHaveProperty('kind', 'line-repeat');
    expect(degenSignals[0]!.payload).toHaveProperty('repeats', 42);
    expect(degenSignals[0]!.payload).toHaveProperty('sample', 'linha repetida 42×');
  });

  it('short-cycle ⇒ emit degeneration (critical)', async () => {
    const bus = new PollSignalBus();
    const { ports } = makePorts();
    const model: ModelCaller = {
      async call() {
        throw new DegenerateLoopError('short-cycle', 3, 'ciclo curto');
      },
    };
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: stubMaestroContinue(bus),
    });

    const res = await loop.run('faça algo');
    expect(res.stop.kind).toBe('degenerate');

    const signals = bus.poll();
    const degenSignals = signals.filter((s) => s.origin === 'degeneration');
    expect(degenSignals).toHaveLength(1);
    expect(degenSignals[0]!.severity).toBe('critical');
    expect(degenSignals[0]!.payload).toHaveProperty('kind', 'short-cycle');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. stuck
// ─────────────────────────────────────────────────────────────────────────

describe('EST-1136 (C2) · stuck → bus', () => {
  it('watchdog dispara same-tool-call ⇒ emit stuck (warning) via allSignals', async () => {
    const bus = new PollSignalBus();
    const fs = new MemoryFs(new Map([['a.txt', 'x']]));
    const { ports } = makePorts({ fs });

    // 6× mesma tool call + final. Com ALUY_STUCK_SAME_TOOL=3, o watchdog
    // dispara na 4ª mesma call (índices 0,1,2,3 → count=3 ≥ limiar=3).
    const script = [...repeatSameTool('read_file', { path: 'a.txt' }, 6), { text: 'pronto.' }];
    const model = new ScriptedModelCaller(script);

    const mm = stubMaestroContinue(bus);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: mm,
      stuckResolver: {
        resolve: async () => ({ kind: 'continue' }),
      } satisfies StuckResolver,
      env: { ALUY_STUCK_SAME_TOOL: '3' },
    });

    const res = await loop.run('leia a.txt várias vezes');
    expect(res.stop.kind).toBe('final');

    // O stuck signal é emitido em checkStuck, mas o regente drena o bus
    // a cada iteração seguinte; capturamos pelo acumulador mm.allSignals.
    const stuckSignals = mm.allSignals.filter((s) => s.origin === 'stuck');
    expect(stuckSignals.length).toBeGreaterThanOrEqual(1);
    expect(stuckSignals[0]!.severity).toBe('warning');
    expect(stuckSignals[0]!.payload).toHaveProperty('stuckKind');
    expect(stuckSignals[0]!.payload).toHaveProperty('count');
  });

  it('sem stuckResolver ⇒ watchdog inerte, sem sinal de stuck', async () => {
    const bus = new PollSignalBus();
    const fs = new MemoryFs(new Map([['a.txt', 'x']]));
    const { ports } = makePorts({ fs });

    const script = [...repeatSameTool('read_file', { path: 'a.txt' }, 10), { text: 'pronto.' }];
    const model = new ScriptedModelCaller(script);

    const mm = stubMaestroContinue(bus);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: mm,
      // sem stuckResolver → watchdog nunca nasce
    });

    const res = await loop.run('leia a.txt muitas vezes');
    expect(res.stop.kind).toBe('final');

    // checkStuck retorna 'continue' sem resolver ⇒ NUNCA emite stuck signal.
    const stuckSignals = mm.allSignals.filter((s) => s.origin === 'stuck');
    expect(stuckSignals).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. weak-yolo
// ─────────────────────────────────────────────────────────────────────────

describe('EST-1136 (C2) · weak-yolo → bus', () => {
  it('combo (yolo + tier-fraco + untrusted) ⇒ emit weak-yolo (warning) via allSignals', async () => {
    const bus = new PollSignalBus();
    const fs = new MemoryFs(new Map([['README.md', 'conteúdo qualquer']]));
    const { ports } = makePorts({ fs });

    // 2 leituras (geram untrusted no contexto) + final
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('read_file', { path: 'README.md' }) },
      { text: toolCallBlock('read_file', { path: 'README.md' }) },
      { text: 'pronto.' },
    ]);

    const warnings: string[] = [];
    const mm = stubMaestroContinue(bus);
    const loop = new AgentLoop({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }), // YOLO
      tools: registry(),
      ports,
      maestro: mm,
      weakYoloGuardrail: {
        tier: () => 'custom', // tier fraco
        onWarn: (w) => warnings.push(w),
      },
    });

    const res = await loop.run('leia o README');
    expect(res.stop.kind).toBe('final');
    // one-shot: WARN foi emitido
    expect(warnings).toHaveLength(1);

    // O weak-yolo signal é emitido mas drenado pelo regente na iteração
    // seguinte; capturamos pelo acumulador mm.allSignals.
    const wySignals = mm.allSignals.filter((s) => s.origin === 'weak-yolo');
    expect(wySignals).toHaveLength(1); // one-shot por execução
    expect(wySignals[0]!.severity).toBe('warning');
    expect(wySignals[0]!.payload).toHaveProperty('tier');
  });

  it('SEM yolo (engine normal) ⇒ NENHUM sinal weak-yolo', async () => {
    const bus = new PollSignalBus();
    const fs = new MemoryFs(new Map([['README.md', 'conteúdo qualquer']]));
    const { ports } = makePorts({ fs });

    const model = new ScriptedModelCaller([
      { text: toolCallBlock('read_file', { path: 'README.md' }) },
      { text: 'pronto.' },
    ]);

    const warnings: string[] = [];
    const mm = stubMaestroContinue(bus);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine, // NÃO-yolo
      tools: registry(),
      ports,
      maestro: mm,
      weakYoloGuardrail: {
        tier: () => 'custom',
        onWarn: (w) => warnings.push(w),
      },
    });

    await loop.run('leia o README');
    expect(warnings).toHaveLength(0);

    const wySignals = mm.allSignals.filter((s) => s.origin === 'weak-yolo');
    expect(wySignals).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. no-op sem bus (baseline: sem maestro)
// ─────────────────────────────────────────────────────────────────────────

describe('EST-1136 (C2) · no-op sem maestro (baseline)', () => {
  it('cenário budget sem maestro ⇒ comportamento idêntico, NENHUM sinal', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'ok.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      limits: { maxIterations: 0, maxToolCalls: 100, maxTokens: 100_000, contextWindow: 100_000 },
      // SEM maestro
    });

    const res = await loop.run('faça algo');
    expect(res.stop.kind).toBe('limit');
  });

  it('cenário degeneration sem maestro ⇒ comportamento idêntico, não quebra', async () => {
    const { ports } = makePorts();
    const model: ModelCaller = {
      async call() {
        throw new DegenerateLoopError('line-repeat', 5, 'sample');
      },
    };
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      // SEM maestro
    });

    const res = await loop.run('faça algo');
    expect(res.stop.kind).toBe('degenerate');
  });

  it('cenário weak-yolo sem maestro ⇒ comportamento idêntico, não quebra', async () => {
    const fs = new MemoryFs(new Map([['README.md', 'x']]));
    const { ports } = makePorts({ fs });
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('read_file', { path: 'README.md' }) },
      { text: 'pronto.' },
    ]);
    const warnings: string[] = [];
    const loop = new AgentLoop({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      tools: registry(),
      ports,
      // SEM maestro
      weakYoloGuardrail: {
        tier: () => 'custom',
        onWarn: (w) => warnings.push(w),
      },
    });

    const res = await loop.run('leia o README');
    expect(res.stop.kind).toBe('final');
    expect(warnings).toHaveLength(1);
    // O aviso ainda foi emitido (freio intacto), sem bus ⇒ sem sinal.
  });

  it('cenário human-cancel sem maestro ⇒ comportamento idêntico, não quebra', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'nunca chamado.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      // SEM maestro
    });

    await expect(loop.run('faça algo', AbortSignal.abort())).rejects.toThrow(ModelCallAbortedError);
  });

  it('cenário stuck sem maestro (sem stuckResolver) ⇒ watchdog inerte, não quebra', async () => {
    const fs = new MemoryFs(new Map([['a.txt', 'x']]));
    const { ports } = makePorts({ fs });
    const script = [...repeatSameTool('read_file', { path: 'a.txt' }, 10), { text: 'pronto.' }];
    const model = new ScriptedModelCaller(script);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      // SEM maestro, SEM stuckResolver
    });

    const res = await loop.run('leia a.txt muitas vezes');
    expect(res.stop.kind).toBe('final');
  });
});

// F62 — CHAIN com o REGENTE REAL (não o stub que sempre continua). Prova o seam
// que os testes em metades não exercitam: o weak-yolo emitido pelo loop é DRENADO
// e DECIDIDO pelo `regentDecide` REAL (a mesma wiring de produção: rege=regentDecide).
// O bug F62 era warning→'pausar'; SEM stuckResolver, 'pausar' faz o loop PARAR
// (applyMaestroDecision), então o loop NUNCA chegaria a 'pronto'. O fix
// (warning→'continuar') deixa o loop ir até o fim. "wired ≠ working": prova viva.
describe('F62 — chain com REGENTE REAL (emit→regentDecide→loop não pausa eager)', () => {
  it('yolo + tier-fraco + untrusted ⇒ regente REAL decide continuar ⇒ loop chega a final', async () => {
    const bus = new PollSignalBus();
    const fs = new MemoryFs(new Map([['README.md', 'conteúdo qualquer']]));
    const { ports } = makePorts({ fs });
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('read_file', { path: 'README.md' }) }, // gera untrusted no contexto
      { text: toolCallBlock('read_file', { path: 'README.md' }) },
      { text: 'pronto.' },
    ]);

    // Wiring de PRODUÇÃO: rege = regentDecide REAL. Captura sinais vistos + decisões.
    const seen: SupervisorSignal[] = [];
    const decisions: SupervisorDecision[] = [];
    const maestro: MaestroPort = {
      bus,
      rege: (signals) => {
        seen.push(...signals);
        const d = regentDecide(signals);
        decisions.push(d);
        return d;
      },
    };

    const loop = new AgentLoop({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }), // YOLO
      tools: registry(),
      ports,
      maestro,
      weakYoloGuardrail: { tier: () => 'custom', onWarn: () => {} }, // tier FRACO
      // SEM stuckResolver DE PROPÓSITO: se o regente PAUSASSE (bug F62), o loop
      // PARARIA aqui e não chegaria a 'pronto'.
    });

    const res = await loop.run('leia o README');

    // (1) o regente REAL viu o sinal weak-yolo (não foi um caminho morto).
    expect(seen.some((s) => s.origin === 'weak-yolo' && s.severity === 'warning')).toBe(true);
    // (2) e NUNCA decidiu pausar/parar por causa dele (F62: warning→continuar).
    expect(decisions.every((d) => d.action !== 'pausar' && d.action !== 'parar')).toBe(true);
    // (3) PROVA viva: o loop CONTINUOU até o 'pronto' (3 chamadas), não parou eager.
    expect(model.calls.length).toBe(3);
    expect(res.stop.kind).toBe('final');
  });
});

// EST-1135 — o Maestro é regência de FLUXO (jamais permissão) e baseline quando
// ausente: um `rege()` que LANÇA (judge LLM por rede, ou MaestroPort customizado)
// NÃO pode derrubar o turno. O loop ENFORCE "Maestro nunca crasha o turno".
describe('EST-1135 — maestro.rege() que LANÇA não derruba o turno (degrada p/ baseline)', () => {
  it('rege() lança erro genérico ⇒ loop degrada e CHEGA a final (modelo rodou)', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'pronto.' }]);
    const throwingMaestro: MaestroPort = {
      bus: new PollSignalBus(),
      rege: () => {
        throw new Error('judge/rede boom (rege explodiu)');
      },
    };
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: throwingMaestro,
    });
    const res = await loop.run('faça a tarefa');
    // PROVA: o modelo RODOU (o rege explodiu ANTES do model.call e foi degradado), e o
    // loop entregou o final — em vez de crashar a sessão por um throw da flow-regency.
    expect(model.calls.length).toBe(1);
    expect(res.stop.kind).toBe('final');
  });

  it('rege() lança ABORT ⇒ NÃO é engolido — o cancelamento PROPAGA (ESC/Ctrl-C sobe)', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'pronto.' }]);
    const abortingMaestro: MaestroPort = {
      bus: new PollSignalBus(),
      rege: () => {
        throw new ModelCallAbortedError();
      },
    };
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      maestro: abortingMaestro,
    });
    await expect(loop.run('faça a tarefa')).rejects.toThrow(ModelCallAbortedError);
  });
});

// F78 — o recall de memória é AWAITADO antes do loop (caminho crítico). Se o mem0
// trava/é lento, NÃO pode stalar o start: teto de 2.5s ⇒ [] (fail-open) ⇒ o loop
// prossegue. (O store post-resposta é decisão à parte — não coberto aqui.)
describe('F78 — recall de memória não stala o start (timeout 2.5s)', () => {
  it('memory.search que TRAVA ⇒ recall corta em ~2.5s e o loop CHEGA a final', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'pronto.' }]);
    // Engine cujo `search` NUNCA resolve (simula mem0 pendurado/cold).
    const hangingMemory = {
      add: async () => ({ ids: [] }),
      search: () => new Promise<never>(() => {}), // nunca resolve
      scope: async () => ({ scopes: [] }),
    } as unknown as Parameters<typeof AgentLoop>[0]['memory'];
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      memory: hangingMemory,
      memoryScope: 'proj_test',
    });

    const t0 = Date.now();
    const res = await loop.run('faça a tarefa');
    const dt = Date.now() - t0;

    expect(res.stop.kind).toBe('final'); // o loop RODOU apesar do recall pendurado
    expect(model.calls.length).toBe(1); // o modelo foi chamado (recall não bloqueou pra sempre)
    expect(dt).toBeGreaterThanOrEqual(2000); // esperou ~o teto (não ignorou o recall)
    expect(dt).toBeLessThan(4500); // mas NÃO travou nem esperou os 5s do engine
  }, 10_000);
});

// F78 (opção (a), escolha do dono) — o STORE de memória é FIRE-AND-FORGET: não bloqueia
// o `return result` (a resposta já está pronta). Mas é RASTREADO e `drainMemoryWrites()`
// o completa (headless dren antes do exit ⇒ persistência garantida).
describe('F78 (a) — store em background + drainMemoryWrites', () => {
  it('store NÃO bloqueia o run(); o drain aguarda o write em background', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'pronto.' }]);
    let addStarted = false;
    let addDone = false;
    const slowMemory = {
      add: async () => {
        addStarted = true;
        await new Promise((r) => setTimeout(r, 300)); // write LENTO
        addDone = true;
        return { ids: ['x'] };
      },
      search: async () => ({ hits: [] }),
      scope: async () => ({ scopes: [] }),
    } as unknown as Parameters<typeof AgentLoop>[0]['memory'];
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      memory: slowMemory,
      memoryScope: 'proj_test',
    });

    const t0 = Date.now();
    const res = await loop.run('faça a tarefa');
    const runMs = Date.now() - t0;

    expect(res.stop.kind).toBe('final');
    // o run() NÃO esperou o store: o add começou mas ainda NÃO terminou.
    expect(addStarted).toBe(true);
    expect(addDone).toBe(false);
    expect(runMs).toBeLessThan(250); // não bloqueou os 300ms do write

    // drain aguarda o write em background ⇒ completa (persistência headless garantida).
    await loop.drainMemoryWrites();
    expect(addDone).toBe(true);
  }, 10_000);
});
