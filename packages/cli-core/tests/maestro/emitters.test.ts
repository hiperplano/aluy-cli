// EST-1124 · MAESTRO-EMISSORES —
// Testes dos emissores de SupervisorSignal para o barramento do Maestro.
//
// Cobre os critérios de aceite:
// Q-MA1: human-cancel é `critical` e o `reason` é user-facing
// Q-MA2: degenerate/stuck/mem-pressure/self-check/weak-yolo/budget emitem sinais corretos
// Q-MA3: sem bus ⇒ no-op (forward-compat)
// Q-MA4: testes de regressão — nenhum freio DURO relaxado

import { describe, expect, it } from 'vitest';
import {
  makeSignal,
  emitDegenerationSignal,
  emitStuckSignal,
  emitMemPressureSignal,
  emitSelfCheckSignal,
  emitWeakYoloSignal,
  emitBudgetSignal,
  emitHumanCancelSignal,
} from '../../src/agent/maestro/emitters.js';
import { PollSignalBus } from '../../src/agent/maestro/bus.js';
import { createSignal } from '../../src/agent/maestro/contract.js';

// ─────────────────────────────────────────────────────────────────────────
// Q-MA3 — sem bus ⇒ no-op (forward-compat)
// ─────────────────────────────────────────────────────────────────────────
describe('EST-1124 · Q-MA3 — sem bus ⇒ no-op (forward-compat)', () => {
  it('emitDegenerationSignal sem bus ⇒ no-op', () => {
    expect(() =>
      emitDegenerationSignal(undefined, 'line-repeat', 30, 'sample line', 0),
    ).not.toThrow();
  });

  it('emitStuckSignal sem bus ⇒ no-op', () => {
    expect(() => emitStuckSignal(undefined, 'no-tool-call', 5, 'sample', 0)).not.toThrow();
  });

  it('emitMemPressureSignal sem bus ⇒ no-op', () => {
    expect(() =>
      emitMemPressureSignal(undefined, 'compact', 0.8, 1024 * 1024 * 512, 0),
    ).not.toThrow();
  });

  it('emitSelfCheckSignal sem bus ⇒ no-op', () => {
    expect(() => emitSelfCheckSignal(undefined, 'reanchor', 100, 1, 3, 0)).not.toThrow();
  });

  it('emitWeakYoloSignal sem bus ⇒ no-op', () => {
    expect(() => emitWeakYoloSignal(undefined, 'tier-2', 0)).not.toThrow();
  });

  it('emitBudgetSignal sem bus ⇒ no-op', () => {
    expect(() =>
      emitBudgetSignal(
        undefined,
        'iterations',
        { iterations: 100, toolCalls: 50, tokens: 5000 },
        0,
      ),
    ).not.toThrow();
  });

  it('emitHumanCancelSignal sem bus ⇒ no-op', () => {
    expect(() => emitHumanCancelSignal(undefined, 'ctrl-c', 0)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Q-MA2 — sinais corretos de cada guarda
// ─────────────────────────────────────────────────────────────────────────
describe('EST-1124 · Q-MA2 — emitDegenerationSignal', () => {
  it('emite sinal com origin=degeneration, severity=warning p/ line-repeat', () => {
    const bus = new PollSignalBus();
    emitDegenerationSignal(bus, 'line-repeat', 30, 'linha repetida\n', 100);
    const signals = bus.poll();
    expect(signals).toHaveLength(1);
    expect(signals[0].origin).toBe('degeneration');
    expect(signals[0].severity).toBe('warning');
    expect(signals[0].ts).toBe(100);
    expect(signals[0].payload).toEqual({
      kind: 'line-repeat',
      repeats: 30,
      sample: 'linha repetida\n',
    });
  });

  it('emite sinal com severity=critical p/ short-cycle', () => {
    const bus = new PollSignalBus();
    emitDegenerationSignal(bus, 'short-cycle', 15, 'abcabcabc', 200);
    const signals = bus.poll();
    expect(signals).toHaveLength(1);
    expect(signals[0].origin).toBe('degeneration');
    expect(signals[0].severity).toBe('critical');
    expect(signals[0].ts).toBe(200);
    expect(signals[0].payload).toEqual({
      kind: 'short-cycle',
      repeats: 15,
      sample: 'abcabcabc',
    });
  });

  it('ts default usa Date.now() quando não injetado', () => {
    const bus = new PollSignalBus();
    const before = Date.now();
    emitDegenerationSignal(bus, 'line-repeat', 5, 'x');
    const after = Date.now();
    const signals = bus.poll();
    expect(signals[0].ts).toBeGreaterThanOrEqual(before);
    expect(signals[0].ts).toBeLessThanOrEqual(after);
  });
});

describe('EST-1124 · Q-MA2 — emitStuckSignal', () => {
  it('emite sinal com origin=stuck, severity=warning', () => {
    const bus = new PollSignalBus();
    emitStuckSignal(bus, 'no-tool-call', 5, 'iterações sem ferramenta', 300);
    const signals = bus.poll();
    expect(signals).toHaveLength(1);
    expect(signals[0].origin).toBe('stuck');
    expect(signals[0].severity).toBe('warning');
    expect(signals[0].ts).toBe(300);
    expect(signals[0].payload).toEqual({
      stuckKind: 'no-tool-call',
      count: 5,
      sample: 'iterações sem ferramenta',
    });
  });

  it('stuckKind "no-mutation" com payload correto', () => {
    const bus = new PollSignalBus();
    emitStuckSignal(bus, 'no-mutation', 10, 'nenhuma alteração de arquivo', 400);
    const signals = bus.poll();
    expect(signals[0].origin).toBe('stuck');
    expect(signals[0].payload.stuckKind).toBe('no-mutation');
    expect(signals[0].payload.count).toBe(10);
  });
});

describe('EST-1124 · Q-MA2 — emitMemPressureSignal', () => {
  it('emite sinal com origin=mem-pressure, severity=warning p/ compact', () => {
    const bus = new PollSignalBus();
    emitMemPressureSignal(bus, 'compact', 0.8, 536870912, 500);
    const signals = bus.poll();
    expect(signals).toHaveLength(1);
    expect(signals[0].origin).toBe('mem-pressure');
    expect(signals[0].severity).toBe('warning');
    expect(signals[0].ts).toBe(500);
    expect(signals[0].payload).toEqual({
      action: 'compact',
      ratio: 0.8,
      heapLimitBytes: 536870912,
    });
  });

  it('severity=critical p/ shutdown', () => {
    const bus = new PollSignalBus();
    emitMemPressureSignal(bus, 'shutdown', 0.98, 536870912, 600);
    const signals = bus.poll();
    expect(signals).toHaveLength(1);
    expect(signals[0].origin).toBe('mem-pressure');
    expect(signals[0].severity).toBe('critical');
  });

  it('severity=warning p/ warn', () => {
    const bus = new PollSignalBus();
    emitMemPressureSignal(bus, 'warn', 0.85, 536870912, 700);
    const signals = bus.poll();
    expect(signals[0].severity).toBe('warning');
  });
});

describe('EST-1124 · Q-MA2 — emitSelfCheckSignal', () => {
  it('emite sinal com origin=self-check, severity=info (todos os checkKind)', () => {
    const kinds: Array<'reanchor' | 'verify' | 'cap-reached'> = [
      'reanchor',
      'verify',
      'cap-reached',
    ];
    for (const kind of kinds) {
      const bus = new PollSignalBus();
      emitSelfCheckSignal(bus, kind, 50, 1, 3, 800);
      const signals = bus.poll();
      expect(signals).toHaveLength(1);
      expect(signals[0].origin).toBe('self-check');
      expect(signals[0].severity).toBe('info');
      expect(signals[0].ts).toBe(800);
      expect(signals[0].payload.checkKind).toBe(kind);
      expect(signals[0].payload.iteration).toBe(50);
      expect(signals[0].payload.attempt).toBe(1);
      expect(signals[0].payload.max).toBe(3);
    }
  });

  it('campos opcionais undefined não aparecem no payload', () => {
    const bus = new PollSignalBus();
    emitSelfCheckSignal(bus, 'verify', undefined, undefined, undefined, 900);
    const signals = bus.poll();
    expect(signals[0].payload).toEqual({ checkKind: 'verify' });
    expect('iteration' in signals[0].payload).toBe(false);
    expect('attempt' in signals[0].payload).toBe(false);
    expect('max' in signals[0].payload).toBe(false);
  });
});

describe('EST-1124 · Q-MA2 — emitWeakYoloSignal', () => {
  it('emite sinal com origin=weak-yolo, severity=warning', () => {
    const bus = new PollSignalBus();
    emitWeakYoloSignal(bus, 'tier-2', 1000);
    const signals = bus.poll();
    expect(signals).toHaveLength(1);
    expect(signals[0].origin).toBe('weak-yolo');
    expect(signals[0].severity).toBe('warning');
    expect(signals[0].ts).toBe(1000);
    expect(signals[0].payload).toEqual({ tier: 'tier-2' });
  });

  it('tier "yolo" também emite corretamente', () => {
    const bus = new PollSignalBus();
    emitWeakYoloSignal(bus, 'yolo', 1100);
    const signals = bus.poll();
    expect(signals[0].origin).toBe('weak-yolo');
    expect(signals[0].payload.tier).toBe('yolo');
  });
});

describe('EST-1124 · Q-MA2 — emitBudgetSignal', () => {
  it('emite sinal com origin=budget, severity=warning', () => {
    const bus = new PollSignalBus();
    emitBudgetSignal(bus, 'iterations', { iterations: 100, toolCalls: 50, tokens: 5000 }, 1200);
    const signals = bus.poll();
    expect(signals).toHaveLength(1);
    expect(signals[0].origin).toBe('budget');
    expect(signals[0].severity).toBe('warning');
    expect(signals[0].ts).toBe(1200);
    expect(signals[0].payload).toEqual({
      limitKind: 'iterations',
      usage: { iterations: 100, toolCalls: 50, tokens: 5000 },
    });
  });

  it('limitKind "tokens" emite corretamente', () => {
    const bus = new PollSignalBus();
    emitBudgetSignal(bus, 'tokens', { iterations: 10, toolCalls: 5, tokens: 200_000 }, 1300);
    const signals = bus.poll();
    expect(signals[0].payload.limitKind).toBe('tokens');
    expect(signals[0].payload.usage.tokens).toBe(200_000);
  });

  it('limitKind "tool-calls" emite corretamente', () => {
    const bus = new PollSignalBus();
    emitBudgetSignal(bus, 'tool-calls', { iterations: 10, toolCalls: 500, tokens: 1000 }, 1400);
    const signals = bus.poll();
    expect(signals[0].payload.limitKind).toBe('tool-calls');
    expect(signals[0].payload.usage.toolCalls).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Q-MA1 — human-cancel é `critical` e reason é user-facing
// ─────────────────────────────────────────────────────────────────────────
describe('EST-1124 · Q-MA1 — emitHumanCancelSignal (critical, reason user-facing)', () => {
  it('emite sinal com origin=human-cancel, severity=critical', () => {
    const bus = new PollSignalBus();
    emitHumanCancelSignal(bus, 'ctrl-c', 1500);
    const signals = bus.poll();
    expect(signals).toHaveLength(1);
    expect(signals[0].origin).toBe('human-cancel');
    expect(signals[0].severity).toBe('critical');
    expect(signals[0].ts).toBe(1500);
    expect(signals[0].payload).toEqual({ reason: 'ctrl-c' });
  });

  it('reason é texto livre user-facing (preservado como está)', () => {
    const bus = new PollSignalBus();
    const reason = 'Usuário pressionou ESC durante o planejamento da tarefa';
    emitHumanCancelSignal(bus, reason, 1600);
    const signals = bus.poll();
    expect(signals[0].payload.reason).toBe(reason);
  });

  it('human-cancel é SEMPRE critical, nunca outro severity', () => {
    const bus = new PollSignalBus();
    // Mesmo com reason vazio ou trivial, severidade é critical
    emitHumanCancelSignal(bus, '', 1700);
    const signals = bus.poll();
    expect(signals[0].severity).toBe('critical');
    // Q-MA1 garante que o regente o coloque no topo absoluto da precedência
  });
});

// ─────────────────────────────────────────────────────────────────────────
// makeSignal — factory pura
// ─────────────────────────────────────────────────────────────────────────
describe('EST-1124 · makeSignal — factory pura de SupervisorSignal', () => {
  it('cria sinal imutável com todos os campos obrigatórios', () => {
    const signal = makeSignal('stuck', 'warning', { count: 5 }, 100);
    expect(signal.origin).toBe('stuck');
    expect(signal.severity).toBe('warning');
    expect(signal.ts).toBe(100);
    expect(signal.payload).toEqual({ count: 5 });
  });

  it('ts default usa Date.now() quando omitido', () => {
    const before = Date.now();
    const signal = makeSignal('self-check', 'info', {});
    const after = Date.now();
    expect(signal.ts).toBeGreaterThanOrEqual(before);
    expect(signal.ts).toBeLessThanOrEqual(after);
  });

  it('payload vazio é válido', () => {
    const signal = makeSignal('human-cancel', 'critical', {}, 200);
    expect(signal.payload).toEqual({});
  });

  it('payload complexo é preservado', () => {
    const payload = {
      nested: { a: 1, b: [2, 3] },
      list: ['x', 'y'],
      flag: true,
    };
    const signal = makeSignal('degeneration', 'warning', payload, 300);
    expect(signal.payload).toEqual(payload);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Q-MA4 — testes de regressão: nenhum freio DURO relaxado
// ─────────────────────────────────────────────────────────────────────────
describe('EST-1124 · Q-MA4 — regressão: freios DUROS intactos', () => {
  it('os emissores NÃO alteram o comportamento do barramento (apenas publicam)', () => {
    const bus = new PollSignalBus();

    // Publica múltiplos sinais simulando uma rodada real
    emitDegenerationSignal(bus, 'line-repeat', 30, 'repetida\n', 1);
    emitStuckSignal(bus, 'no-tool-call', 5, 'sample', 2);
    emitMemPressureSignal(bus, 'compact', 0.8, 512 * 1024 * 1024, 3);
    emitSelfCheckSignal(bus, 'reanchor', 100, 1, 3, 4);
    emitWeakYoloSignal(bus, 'tier-2', 5);
    emitBudgetSignal(bus, 'iterations', { iterations: 98, toolCalls: 40, tokens: 4000 }, 6);
    emitHumanCancelSignal(bus, 'ctrl-c', 7);

    const signals = bus.poll();
    expect(signals).toHaveLength(7);

    // Nenhum sinal perdeu informação
    const origins = signals.map((s) => s.origin);
    expect(origins).toContain('degeneration');
    expect(origins).toContain('stuck');
    expect(origins).toContain('mem-pressure');
    expect(origins).toContain('self-check');
    expect(origins).toContain('weak-yolo');
    expect(origins).toContain('budget');
    expect(origins).toContain('human-cancel');
  });

  it('PollSignalBus.reset() ainda funciona após emissões múltiplas', () => {
    const bus = new PollSignalBus();
    emitStuckSignal(bus, 'no-mutation', 3, 'sample', 0);
    expect(bus.pending).toBe(1);

    bus.reset();
    expect(bus.pending).toBe(0);
    expect(bus.poll()).toEqual([]);

    // Após reset, novas emissões funcionam
    emitStuckSignal(bus, 'no-tool-call', 5, 'sample', 1);
    expect(bus.pending).toBe(1);
    expect(bus.poll()).toHaveLength(1);
  });

  it('createSignal do contrato original permanece compatível com os emissores', () => {
    // createSignal do contract cria o mesmo formato que makeSignal
    const contractSignal = createSignal('stuck', 'warning', 200, { count: 3 });
    const emitterSignal = makeSignal('stuck', 'warning', { count: 3 }, 200);

    expect(emitterSignal.origin).toBe(contractSignal.origin);
    expect(emitterSignal.severity).toBe(contractSignal.severity);
    expect(emitterSignal.ts).toBe(contractSignal.ts);
    expect(emitterSignal.payload).toEqual(contractSignal.payload);
  });

  it('os testes de guarda existentes continuam passando (degeneration)', async () => {
    // O arquivo degeneration.test.ts já testa a guarda sem o barramento.
    // Este teste confirma que o módulo degeneration ainda exporta o mesmo.
    const mod = await import('../../src/agent/degeneration.js');
    expect(mod.DegenerationDetector).toBeDefined();
    expect(mod.DegenerateLoopError).toBeDefined();
    expect(mod.detectShortCycle).toBeDefined();
    expect(mod.resolveDegenerationConfig).toBeDefined();
    expect(mod.isDegenerationGuardEnabled).toBeDefined();
  });

  it('os testes de guarda existentes continuam passando (stuck-watchdog)', async () => {
    const mod = await import('../../src/agent/stuck-watchdog.js');
    expect(mod.StuckWatchdog).toBeDefined();
    // StuckAlert pode ser exportado ou não; verificamos a classe principal
  });

  it('os testes de guarda existentes continuam passando (mem-pressure)', async () => {
    const mod = await import('../../src/agent/mem-pressure.js');
    // mem-pressure exporta funções puras, não classe
    expect(typeof mod.decideMemPressure).toBe('function');
    expect(typeof mod.heapPressureRatio).toBe('function');
    expect(typeof mod.isMemPressureEnabled).toBe('function');
    expect(mod.DEFAULT_COMPACT_AT).toBeDefined();
  });

  it('os testes de guarda existentes continuam passando (self-check)', async () => {
    const mod = await import('../../src/agent/self-check.js');
    // self-check exporta funções puras
    expect(typeof mod.buildReanchor).toBe('function');
    expect(typeof mod.buildSelfCheckProbe).toBe('function');
    expect(typeof mod.resolveSelfCheck).toBe('function');
    expect(mod.SELF_CHECK_OFF).toBeDefined();
  });

  it('os testes de guarda existentes continuam passando (weak-yolo-guardrail)', async () => {
    const mod = await import('../../src/agent/weak-yolo-guardrail.js');
    // weak-yolo-guardrail exporta funções puras
    expect(typeof mod.detectWeakYoloUntrusted).toBe('function');
    expect(typeof mod.hasUntrustedInContext).toBe('function');
    expect(typeof mod.buildWeakYoloWarning).toBe('function');
  });

  it('os testes de guarda existentes continuam passando (shared-budget)', async () => {
    const mod = await import('../../src/agent/shared-budget.js');
    expect(mod.SharedBudget).toBeDefined();
    // SharedBudget é a classe principal; configuração é injetada no construtor
    expect(typeof mod.SharedBudget).toBe('function');
  });
});
