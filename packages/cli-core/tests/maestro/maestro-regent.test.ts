// EST-1123 · MAESTRO-REGENTE —
// Testes do regente: ponto único de decisão de turno com precedência Q-MA1.
//
// Cobre os 3 critérios de aceite:
//   CA-REG-1 — exatamente 1 SupervisorDecision por chamada
//   CA-REG-2 — precedência Q-MA1: human-cancel > mem-pressure > budget >
//              degeneração > stuck > weak-yolo > self-check
//   CA-REG-3 — determinismo: mesma entrada ⇒ mesma saída

import { describe, expect, it } from 'vitest';
import { createSignal, type SupervisorSignal } from '../../src/agent/maestro/contract.js';
import { regentDecide } from '../../src/agent/maestro/regent.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Cria um sinal de self-check info (tudo normal). */
const normal = (ts = 0): SupervisorSignal =>
  createSignal('self-check', 'info', ts, { status: 'ok' });

/** Cria um sinal human-cancel critical (ctrl-c). */
const esc = (ts = 1): SupervisorSignal =>
  createSignal('human-cancel', 'critical', ts, { reason: 'ctrl-c' });

/** Cria um sinal mem-pressure critical. */
const oom = (ts = 2): SupervisorSignal =>
  createSignal('mem-pressure', 'critical', ts, { pressurePct: 98 });

/** Cria um sinal mem-pressure warning. */
const memWarn = (ts = 3): SupervisorSignal =>
  createSignal('mem-pressure', 'warning', ts, { pressurePct: 82 });

/** Cria um sinal budget critical. */
const budgetCrit = (ts = 4): SupervisorSignal =>
  createSignal('budget', 'critical', ts, { remaining: 0.02 });

/** Cria um sinal degeneration warning. */
const degen = (ts = 5): SupervisorSignal =>
  createSignal('degeneration', 'warning', ts, { score: 0.55 });

/** Cria um sinal stuck critical. */
const stuckCrit = (ts = 6): SupervisorSignal =>
  createSignal('stuck', 'critical', ts, { stuckIterations: 12 });

/** Cria um sinal weak-yolo critical. */
const yoloCrit = (ts = 7): SupervisorSignal =>
  createSignal('weak-yolo', 'critical', ts, { reason: 'no-model' });

/** Cria um sinal weak-yolo WARNING (o combo yolo+tier-fraco+dado não-confiável). */
const yoloWarn = (ts = 7): SupervisorSignal =>
  createSignal('weak-yolo', 'warning', ts, { tier: 'custom' });

// ─── CA-REG-1 — exatamente UMA decisão ─────────────────────────────────────

describe('EST-1123 · CA-REG-1 — ponto único de decisão de turno', () => {
  it('retorna exatamente UMA SupervisorDecision', () => {
    const decision = regentDecide([normal()]);
    expect(decision).toBeDefined();
    expect(decision.action).toBeDefined();
    expect(decision.signals).toBeDefined();
    expect(decision.reason).toBeDefined();
    expect(decision.ts).toBeDefined();
    // Garante que é UM objeto, não array
    expect(typeof decision.action).toBe('string');
  });

  it('com 1 sinal: decisão contém o sinal de entrada (rastro)', () => {
    const sig = normal(100);
    const decision = regentDecide([sig]);
    expect(decision.signals).toHaveLength(1);
    expect(decision.signals[0]).toBe(sig);
  });

  it('com N sinais: decisão contém TODOS os sinais (rastro completo)', () => {
    const signals = [normal(), oom(), degen()];
    const decision = regentDecide(signals);
    expect(decision.signals).toHaveLength(3);
    expect(decision.signals).toContain(signals[0]);
    expect(decision.signals).toContain(signals[1]);
    expect(decision.signals).toContain(signals[2]);
  });

  it('zero sinais → fail-safe CA-MA5: continuar (não-destrutivo)', () => {
    const decision = regentDecide([]);
    expect(decision.action).toBe('continuar');
    expect(decision.signals).toHaveLength(1);
    expect(decision.signals[0].origin).toBe('self-check');
    expect(decision.signals[0].severity).toBe('info');
    expect(decision.reason).toContain('CA-MA5');
  });

  it('razão NUNCA é vazia (CLI-SEC-10)', () => {
    const decision = regentDecide([normal()]);
    expect(decision.reason.trim().length).toBeGreaterThan(0);
  });

  it('ts da decisão é >= ts de todos os sinais (causalidade)', () => {
    const signals = [normal(100), oom(200), degen(300)];
    const decision = regentDecide(signals, 400);
    expect(decision.ts).toBe(400);
    for (const s of decision.signals) {
      expect(decision.ts).toBeGreaterThanOrEqual(s.ts);
    }
  });
});

// ─── CA-REG-2 — precedência Q-MA1 ──────────────────────────────────────────

describe('EST-1123 · CA-REG-2 — precedência canônica Q-MA1', () => {
  it('human-cancel (ESC) é o TOPO absoluto — vence qualquer outro', () => {
    // ESC + OOM + budget + degen + stuck → ESC vence → 'parar'
    const signals = [oom(), esc(), budgetCrit(), degen(), stuckCrit()];
    const decision = regentDecide(signals);
    expect(decision.action).toBe('parar');
    expect(decision.reason).toContain('human-cancel');
  });

  it('ESC + OOM no mesmo passo ⇒ vence o cancelamento humano (coração Q-MA1)', () => {
    const decision = regentDecide([oom(), esc()]);
    expect(decision.action).toBe('parar');
  });

  it('mem-pressure > budget', () => {
    // mem-pressure warning vs budget critical → mem-pressure vence
    const decision = regentDecide([budgetCrit(), memWarn()]);
    expect(decision.action).toBe('recuperar');
    expect(decision.reason).toContain('mem-pressure');
  });

  it('mem-pressure > degeneração', () => {
    const decision = regentDecide([degen(), memWarn()]);
    expect(decision.action).toBe('recuperar');
    expect(decision.reason).toContain('mem-pressure');
  });

  it('budget > degeneração', () => {
    const decision = regentDecide([degen(), budgetCrit()]);
    expect(decision.action).toBe('pausar');
    expect(decision.reason).toContain('budget');
  });

  it('degeneração > stuck', () => {
    const decision = regentDecide([stuckCrit(), degen()]);
    expect(decision.action).toBe('recuperar');
    expect(decision.reason).toContain('degeneration');
  });

  it('stuck > weak-yolo', () => {
    const decision = regentDecide([yoloCrit(), stuckCrit()]);
    expect(decision.action).toBe('recuperar');
    expect(decision.reason).toContain('stuck');
  });

  it('weak-yolo > self-check', () => {
    const decision = regentDecide([normal(), yoloCrit()]);
    expect(decision.action).toBe('parar');
    expect(decision.reason).toContain('weak-yolo');
  });

  it('cadeia completa de precedência (7 sinais, 7 origens)', () => {
    const signals = [
      normal(0), // self-check (prioridade 6)
      yoloCrit(1), // weak-yolo (5)
      stuckCrit(2), // stuck (4)
      degen(3), // degeneração (3)
      budgetCrit(4), // budget (2)
      oom(5), // mem-pressure (1)
      esc(6), // human-cancel (0) — TOPO
    ];
    const decision = regentDecide(signals);
    // human-cancel é topo → 'parar'
    expect(decision.action).toBe('parar');
    expect(decision.reason).toContain('human-cancel');
  });

  it('sem sinais críticos: self-check → continuar', () => {
    const decision = regentDecide([normal()]);
    expect(decision.action).toBe('continuar');
  });

  it('sinal único mem-pressure critical → recuperar', () => {
    const decision = regentDecide([oom()]);
    expect(decision.action).toBe('recuperar');
  });

  it('sinal único budget critical → pausar', () => {
    const decision = regentDecide([budgetCrit()]);
    expect(decision.action).toBe('pausar');
  });

  it('sinal único stuck critical → recuperar', () => {
    const decision = regentDecide([stuckCrit()]);
    expect(decision.action).toBe('recuperar');
  });

  it('sinal único weak-yolo critical → parar', () => {
    const decision = regentDecide([yoloCrit()]);
    expect(decision.action).toBe('parar');
  });

  // F62 — weak-yolo WARNING NÃO pausa (veredito AG-0008: warn+reanchor, nunca
  // promptar). O combo dispara JÁ na 1ª iteração porque mem0-recall/@anexo
  // injetam um `observation` (DADO não-confiável); pausar ali travava toda tarefa.
  it('sinal único weak-yolo WARNING → continuar (F62: não pausa eager)', () => {
    const decision = regentDecide([yoloWarn()]);
    expect(decision.action).toBe('continuar');
  });

  it('weak-yolo warning + self-check → continuar (não vira pausa)', () => {
    const decision = regentDecide([normal(0), yoloWarn(1)]);
    expect(decision.action).toBe('continuar');
  });
});

// ─── CA-REG-3 — determinismo ───────────────────────────────────────────────

describe('EST-1123 · CA-REG-3 — determinismo', () => {
  it('mesma entrada de sinais + mesmo ts ⇒ mesma decisão (ação)', () => {
    const signals = [oom(), degen(), stuckCrit()];
    const d1 = regentDecide(signals, 500);
    const d2 = regentDecide(signals, 500);
    expect(d1.action).toBe(d2.action);
    expect(d1.reason).toBe(d2.reason);
    expect(d1.ts).toBe(d2.ts);
    expect(d1.signals).toHaveLength(d2.signals.length);
  });

  it('mesma entrada de sinais ⇒ mesmo tipo de ação (sem ts explícito)', () => {
    const signals = [budgetCrit(), degen()];
    const d1 = regentDecide(signals);
    const d2 = regentDecide(signals);
    expect(d1.action).toBe(d2.action);
    // razão e ts podem diferir se Date.now() variar entre chamadas
    // mas a AÇÃO é estável (Inv. 3 do contrato ADR-0123 §2.1)
  });

  it('ordem dos sinais NÃO afeta decisão (a precedência rege)', () => {
    const d1 = regentDecide([normal(), oom(), esc()], 700);
    const d2 = regentDecide([esc(), normal(), oom()], 700);
    const d3 = regentDecide([oom(), esc(), normal()], 700);
    expect(d1.action).toBe('parar'); // ESC sempre topo
    expect(d1.action).toBe(d2.action);
    expect(d1.action).toBe(d3.action);
  });

  it('sinais idênticos em chamadas separadas ⇒ mesma ação', () => {
    const makeSignals = (): SupervisorSignal[] => [
      createSignal('mem-pressure', 'warning', 10, { pressurePct: 80 }),
      createSignal('stuck', 'info', 20, { stuckIterations: 2 }),
    ];

    const d1 = regentDecide(makeSignals(), 900);
    const d2 = regentDecide(makeSignals(), 900);

    expect(d1.action).toBe(d2.action);
    expect(d1.reason).toBe(d2.reason);
  });
});

// ─── CA-MA5 — fail-safe adicional ──────────────────────────────────────────

describe('EST-1123 · CA-MA5 — fail-safe', () => {
  it('origem desconhecida → fallback continuar (não-destrutivo)', () => {
    const unknown = createSignal('self-check' as never, 'info', 0) as SupervisorSignal;
    // Força uma origem que não está na tabela de precedência
    const weird = { ...unknown, origin: 'fantasma' as never } as SupervisorSignal;
    const decision = regentDecide([weird]);
    // Não deve quebrar e deve degradar para continuar
    expect(decision.action).toBe('continuar');
  });

  it('sinal sem severidade reconhecida → fallback continuar', () => {
    const sig = createSignal('self-check', 'info', 0);
    const weird = { ...sig, severity: 'apocalipse' as never } as SupervisorSignal;
    const decision = regentDecide([weird]);
    // Não deve quebrar
    expect(decision.action).toBe('continuar');
  });
});

// ─── Fronteira: regentDecide é função pura (ADR-0053 §8) ──────────────────

describe('EST-1123 · fronteira — regente é puro (ADR-0053 §8)', () => {
  it('regentDecide não lança com entrada válida', () => {
    expect(() => regentDecide([normal()])).not.toThrow();
  });

  it('regentDecide não lança com array vazio (CA-MA5)', () => {
    expect(() => regentDecide([])).not.toThrow();
  });

  it('decisão SEMPRE tem action, signals, reason, ts', () => {
    const decision = regentDecide([oom(), esc()]);
    expect(decision).toHaveProperty('action');
    expect(decision).toHaveProperty('signals');
    expect(decision).toHaveProperty('reason');
    expect(decision).toHaveProperty('ts');
    expect(Array.isArray(decision.signals)).toBe(true);
  });
});
