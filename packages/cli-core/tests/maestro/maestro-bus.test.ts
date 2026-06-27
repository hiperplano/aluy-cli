// EST-1122 · MAESTRO-BUS —
// Testes do contrato SupervisorSignal / SupervisorDecision + barramento de coleta.
//
// Cobre os 4 critérios de aceite:
//   CA-BUS-1 — exposição dos tipos puros
//   CA-BUS-2 — barramento coleta N sinais sem perda, agnóstico de transporte
//   CA-BUS-3 — decisão carrega rastro auditável (CLI-SEC-10)
//   CA-BUS-FRONTEIRA — nenhum import de I/O no módulo (ADR-0053 §8)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createDecision,
  createSignal,
  type DecisionAction,
  type SignalOrigin,
  type SignalSeverity,
  type SupervisorSignal,
} from '../../src/agent/maestro/contract.js';
import { PollSignalBus, type SignalCollector } from '../../src/agent/maestro/bus.js';

// re-export via barrel (agent/index.ts)
import {
  createDecision as createDecisionBarrel,
  createSignal as createSignalBarrel,
  PollSignalBus as PollSignalBusBarrel,
} from '../../src/index.js';

// ─── CA-BUS-1 — tipos puros, sem I/O ────────────────────────────────────────

describe('EST-1122 · CA-BUS-1 — SupervisorSignal / SupervisorDecision (tipos puros)', () => {
  it('cria um SupervisorSignal válido (origem + severidade + payload)', () => {
    const signal = createSignal('stuck', 'warning', 1_000, {
      stuckIterations: 5,
    });

    expect(signal.origin).toBe('stuck');
    expect(signal.severity).toBe('warning');
    expect(signal.ts).toBe(1_000);
    expect(signal.payload).toEqual({ stuckIterations: 5 });
  });

  it('cria um SupervisorSignal com payload vazio (default)', () => {
    const signal = createSignal('self-check', 'info', 2_000);

    expect(signal.origin).toBe('self-check');
    expect(signal.severity).toBe('info');
    expect(signal.payload).toEqual({});
  });

  it('cria SupervisorSignal para todas as origens de guarda', () => {
    const origins: SignalOrigin[] = [
      'degeneration',
      'stuck',
      'mem-pressure',
      'self-check',
      'weak-yolo',
      'budget',
      'human-cancel',
    ];

    for (const origin of origins) {
      const s = createSignal(origin, 'info', 0);
      expect(s.origin).toBe(origin);
    }
  });

  it('cria SupervisorSignal para todas as severidades', () => {
    const severities: SignalSeverity[] = ['info', 'warning', 'critical'];

    for (const sev of severities) {
      const s = createSignal('self-check', sev, 0);
      expect(s.severity).toBe(sev);
    }
  });

  it('cria SupervisorDecision com rastro auditável completo', () => {
    const sig1 = createSignal('stuck', 'warning', 1_000, { iter: 3 });
    const sig2 = createSignal('mem-pressure', 'critical', 1_001, { pct: 92 });

    const decision = createDecision(
      'recuperar',
      [sig1, sig2],
      'Contexto sob pressão e loop travado',
      1_002,
    );

    expect(decision.action).toBe('recuperar');
    expect(decision.signals).toHaveLength(2);
    expect(decision.signals[0]).toBe(sig1);
    expect(decision.signals[1]).toBe(sig2);
    expect(decision.reason).toBe('Contexto sob pressão e loop travado');
    expect(decision.ts).toBe(1_002);
  });

  it('rejeita decisão sem sinais (Inv. 1 — rastreabilidade)', () => {
    expect(() => createDecision('continuar', [], 'sem sinais', 0)).toThrow(
      'SupervisorDecision requires at least one signal',
    );
  });

  it('rejeita decisão com razão vazia (CLI-SEC-10)', () => {
    const sig = createSignal('self-check', 'info', 0);
    expect(() => createDecision('continuar', [sig], '', 0)).toThrow(
      'SupervisorDecision requires a non-empty reason',
    );
  });

  it('rejeita decisão com razão só de espaços (CLI-SEC-10)', () => {
    const sig = createSignal('self-check', 'info', 0);
    expect(() => createDecision('continuar', [sig], '   ', 0)).toThrow(
      'SupervisorDecision requires a non-empty reason',
    );
  });

  it('cobre todas as ações de decisão (ADR-0123 §2.1)', () => {
    const actions: DecisionAction[] = [
      'continuar',
      'pausar',
      'recuperar',
      'delegar',
      'convergir',
      'parar',
    ];

    const sig = createSignal('self-check', 'info', 0);

    for (const action of actions) {
      const d = createDecision(action, [sig], `decisão: ${action}`, 0);
      expect(d.action).toBe(action);
    }
  });

  it('determinismo: mesma entrada ⇒ mesma saída (Inv. 3)', () => {
    const sig = createSignal('budget', 'warning', 500, { remaining: 0.3 });

    const d1 = createDecision('pausar', [sig], 'orçamento baixo', 501);
    const d2 = createDecision('pausar', [sig], 'orçamento baixo', 501);

    expect(d1).toEqual(d2);
  });
});

// ─── CA-BUS-2 — barramento de coleta sem perda, agnóstico de transporte ─────

describe('EST-1122 · CA-BUS-2 — Barramento de coleta (agnóstico de transporte)', () => {
  it('poll retorna vazio quando nada foi publicado', () => {
    const bus = new PollSignalBus();
    expect(bus.poll()).toEqual([]);
    expect(bus.pending).toBe(0);
  });

  it('poll drena todos os sinais publicados (sem perda)', () => {
    const bus = new PollSignalBus();
    const sig1 = createSignal('stuck', 'warning', 1, { i: 1 });
    const sig2 = createSignal('mem-pressure', 'critical', 2, { pct: 95 });
    const sig3 = createSignal('self-check', 'info', 3, {});

    bus.publish(sig1);
    bus.publish(sig2);
    bus.publish(sig3);

    expect(bus.pending).toBe(3);

    const drained = bus.poll();

    expect(drained).toHaveLength(3);
    expect(drained[0]).toBe(sig1);
    expect(drained[1]).toBe(sig2);
    expect(drained[2]).toBe(sig3);
  });

  it('poll NUNCA retorna os mesmos sinais duas vezes', () => {
    const bus = new PollSignalBus();
    bus.publish(createSignal('budget', 'info', 1));

    const first = bus.poll();
    expect(first).toHaveLength(1);

    const second = bus.poll();
    expect(second).toEqual([]);
    expect(bus.pending).toBe(0);
  });

  it('mantém ordem FIFO entre publish e poll', () => {
    const bus = new PollSignalBus();
    const signals: SupervisorSignal[] = [];

    for (let i = 0; i < 10; i++) {
      const s = createSignal('self-check', 'info', i, { idx: i });
      signals.push(s);
      bus.publish(s);
    }

    const drained = bus.poll();
    expect(drained).toHaveLength(10);

    for (let i = 0; i < 10; i++) {
      expect(drained[i]).toBe(signals[i]);
    }
  });

  it('poll intercalado com publish — cada poll só vê o novo desde a última', () => {
    const bus = new PollSignalBus();

    bus.publish(createSignal('stuck', 'warning', 1));
    bus.publish(createSignal('stuck', 'warning', 2));

    const batch1 = bus.poll();
    expect(batch1).toHaveLength(2);
    expect(bus.pending).toBe(0);

    bus.publish(createSignal('mem-pressure', 'critical', 3));

    const batch2 = bus.poll();
    expect(batch2).toHaveLength(1);
    expect(bus.pending).toBe(0);
  });

  it('reset esvazia o barramento', () => {
    const bus = new PollSignalBus();
    bus.publish(createSignal('stuck', 'warning', 1));
    bus.publish(createSignal('mem-pressure', 'critical', 2));

    expect(bus.pending).toBe(2);

    bus.reset();

    expect(bus.pending).toBe(0);
    expect(bus.poll()).toEqual([]);
  });

  it('implementa a interface SignalCollector (contrato agnóstico)', () => {
    const bus: SignalCollector = new PollSignalBus();

    const sig = createSignal('human-cancel', 'critical', 1, { reason: 'ctrl-c' });
    bus.publish(sig);

    const drained = bus.poll();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toBe(sig);
  });

  it('SignalCollector aceita troca futura de implementação (push não quebra contrato)', () => {
    // Simula uma implementação futura que usa push internamente
    // mas expõe a MESMA interface SignalCollector.
    class FuturePushBus implements SignalCollector {
      private signals: SupervisorSignal[] = [];

      publish(signal: SupervisorSignal): void {
        // Em v2, aqui notificaria assinantes (push).
        // Mas o buffer para poll ainda funciona.
        this.signals.push(signal);
      }

      poll(): readonly SupervisorSignal[] {
        const drained = this.signals;
        this.signals = [];
        return drained;
      }
    }

    const bus: SignalCollector = new FuturePushBus();

    bus.publish(createSignal('degeneration', 'warning', 1, {}));
    bus.publish(createSignal('weak-yolo', 'info', 2, {}));

    const drained = bus.poll();
    expect(drained).toHaveLength(2);
  });
});

// ─── CA-BUS-3 — rastro auditável na decisão (CLI-SEC-10) ────────────────────

describe('EST-1122 · CA-BUS-3 — Rastro auditável (CLI-SEC-10)', () => {
  it('decisão contém os sinais de origem (audit trail)', () => {
    const humanCancel = createSignal('human-cancel', 'critical', 100, {
      reason: 'user pressed Ctrl+C',
    });

    const decision = createDecision('parar', [humanCancel], 'Usuário cancelou — parando', 101);

    // CLI-SEC-10: `actor_type=cli` pode inspecionar a decisão.
    expect(decision.signals).toContain(humanCancel);
    expect(decision.signals[0].origin).toBe('human-cancel');
    expect(decision.signals[0].severity).toBe('critical');
  });

  it('decisão carrega reason legível e não-vazia', () => {
    const sig = createSignal('mem-pressure', 'critical', 200, { pct: 98 });

    const decision = createDecision(
      'recuperar',
      [sig],
      'Pressão de memória crítica (98%) — compactando contexto',
      201,
    );

    expect(decision.reason).toBeTruthy();
    expect(decision.reason.length).toBeGreaterThan(10);
  });

  it('múltiplos sinais de origens diferentes geram rastro completo', () => {
    const sig1 = createSignal('stuck', 'warning', 300, { iter: 5 });
    const sig2 = createSignal('degeneration', 'warning', 301, { score: 0.6 });
    const sig3 = createSignal('budget', 'info', 302, { remaining: 0.4 });

    const decision = createDecision(
      'convergir',
      [sig1, sig2, sig3],
      'Múltiplos sinais de atenção — convergindo sub-agentes',
      303,
    );

    expect(decision.signals).toHaveLength(3);

    const origins = decision.signals.map((s) => s.origin);
    expect(origins).toContain('stuck');
    expect(origins).toContain('degeneration');
    expect(origins).toContain('budget');
  });

  it('ts da decisão é >= ts de todos os sinais (causalidade)', () => {
    const sig = createSignal('self-check', 'info', 400);

    const decision = createDecision('continuar', [sig], 'Tudo normal', 401);

    for (const s of decision.signals) {
      expect(decision.ts).toBeGreaterThanOrEqual(s.ts);
    }
  });
});

// ─── CA-BUS-FRONTEIRA — sem I/O no core (ADR-0053 §8) ──────────────────────

describe('EST-1122 · CA-BUS-FRONTEIRA — Módulo maestro sem I/O (ADR-0053 §8)', () => {
  const MAESTRO_DIR = fileURLToPath(new URL('../../src/agent/maestro', import.meta.url));

  const FORBIDDEN = [
    'node:fs',
    'fs',
    'node:net',
    'net',
    'node:child_process',
    'child_process',
    'node:os',
    'os',
    'node:process',
    'process',
    'node:http',
    'http',
    'node:https',
    'https',
  ];

  it('nenhum arquivo do módulo maestro importa I/O proibido', () => {
    const files = ['contract.ts', 'bus.ts', 'index.ts'];

    for (const file of files) {
      const content = readFileSync(join(MAESTRO_DIR, file), 'utf-8');

      // Extrai specifiers de import/export estáticos e dinâmicos.
      const staticRe = /(?:import|export)[^'"]*?['"]([^'"]+)['"]/g;
      const dynRe = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

      for (const re of [staticRe, dynRe]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          const spec = m[1]!;
          expect(FORBIDDEN, `${file} importa specifier proibido "${spec}"`).not.toContain(spec);
        }
      }
    }
  });
});

// ─── Re-export via barrel (CA-BUS-1 — exposição pública) ────────────────────

describe('EST-1122 · Barrel — exportação pública via @hiperplano/aluy-cli-core', () => {
  it('createSignal é re-exportado via barrel principal', () => {
    const sig = createSignalBarrel('self-check', 'info', 0);
    expect(sig.origin).toBe('self-check');
  });

  it('createDecision é re-exportado via barrel principal', () => {
    const sig = createSignalBarrel('stuck', 'warning', 0);
    const dec = createDecisionBarrel('continuar', [sig], 'ok', 1);
    expect(dec.action).toBe('continuar');
  });

  it('PollSignalBus é re-exportado via barrel principal', () => {
    const bus = new PollSignalBusBarrel();
    bus.publish(createSignalBarrel('budget', 'info', 0));
    expect(bus.poll()).toHaveLength(1);
  });
});
