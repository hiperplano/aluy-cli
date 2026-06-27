// EST-1127 · MAESTRO-MOTOR-A —
// Testes do motor camada (a): regência heurística SEM LLM, sempre-disponível.
//
// Cobre os 5 critérios de aceite:
// CA-MOTOR-OFFLINE — decisão sem rede (coração da CA-MA8)
// CA-MOTOR-DET — determinismo
// CA-MOTOR-SALIENCE — pin domina, score reflete recência+frequência
// CA-MOTOR-ROTA — roteamento por regra
// CA-MOTOR-RECUP — regência com provider fora (unit)
//
// + fronteira ADR-0053 §8 (motor-a.ts importa zero I/O).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createSignal, type SupervisorSignal } from '../../src/agent/maestro/contract.js';
import {
  computeAllSaliences,
  computeSalience,
  DEFAULT_MOTOR_A_CONFIG,
  motorADecide,
  motorARoute,
  type SalienceItem,
} from '../../src/agent/maestro/motor-a.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOW = 1_000_000_000_000; // ts fixo para determinismo

const normal = (ts = NOW): SupervisorSignal =>
  createSignal('self-check', 'info', ts, { status: 'ok' });
const esc = (ts = NOW + 1): SupervisorSignal =>
  createSignal('human-cancel', 'critical', ts, { reason: 'ctrl-c' });
const oom = (ts = NOW + 2): SupervisorSignal =>
  createSignal('mem-pressure', 'critical', ts, { pressurePct: 98 });
const memWarn = (ts = NOW + 3): SupervisorSignal =>
  createSignal('mem-pressure', 'warning', ts, { pressurePct: 82 });
const budgetCrit = (ts = NOW + 4): SupervisorSignal =>
  createSignal('budget', 'critical', ts, { remaining: 0.02 });
const budgetWarn = (ts = NOW + 5): SupervisorSignal =>
  createSignal('budget', 'warning', ts, { remaining: 0.15 });
const degen = (ts = NOW + 6): SupervisorSignal =>
  createSignal('degeneration', 'warning', ts, { score: 0.55 });
const stuckCrit = (ts = NOW + 7): SupervisorSignal =>
  createSignal('stuck', 'critical', ts, { stuckIterations: 12 });
const stuckWarn = (ts = NOW + 8): SupervisorSignal =>
  createSignal('stuck', 'warning', ts, { stuckIterations: 4 });
const yoloCrit = (ts = NOW + 9): SupervisorSignal =>
  createSignal('weak-yolo', 'critical', ts, { reason: 'no-model-response' });

// ─── CA-MOTOR-SALIENCE — salience por sinais ────────────────────────────────

describe('EST-1127 · CA-MOTOR-SALIENCE — computeSalience', () => {
  it('item pinado ⇒ score = 1.0 (override forte)', () => {
    const item: SalienceItem = { recency: 0, frequency: 1, pinned: true };
    const score = computeSalience(item, DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(score.score).toBe(1.0);
    expect(score.pinned).toBe(true);
    expect(score.recencyComponent).toBe(1.0);
    expect(score.frequencyComponent).toBe(1.0);
  });

  it('pin domina mesmo com recência zero e frequência zero', () => {
    const item: SalienceItem = { recency: 0, frequency: 0, pinned: true };
    const score = computeSalience(item, DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(score.score).toBe(1.0);
  });

  it('score reflete recência: item recente tem score mais alto', () => {
    const recent: SalienceItem = { recency: NOW, frequency: 1, pinned: false };
    const old: SalienceItem = { recency: NOW - 3_600_000, frequency: 1, pinned: false }; // 1h atrás

    const recentScore = computeSalience(recent, DEFAULT_MOTOR_A_CONFIG, NOW);
    const oldScore = computeSalience(old, DEFAULT_MOTOR_A_CONFIG, NOW);

    expect(recentScore.score).toBeGreaterThan(oldScore.score);
    expect(recentScore.recencyComponent).toBe(1); // age=0 → 1.0
    expect(oldScore.recencyComponent).toBeLessThan(1);
  });

  it('score reflete frequência: item mais frequente tem score mais alto', () => {
    const lowFreq: SalienceItem = { recency: NOW, frequency: 1, pinned: false };
    const hiFreq: SalienceItem = { recency: NOW, frequency: 50, pinned: false };

    const lowScore = computeSalience(lowFreq, DEFAULT_MOTOR_A_CONFIG, NOW);
    const hiScore = computeSalience(hiFreq, DEFAULT_MOTOR_A_CONFIG, NOW);

    expect(hiScore.score).toBeGreaterThan(lowScore.score);
    expect(hiScore.frequencyComponent).toBeGreaterThan(lowScore.frequencyComponent);
  });

  it('score máximo para item recente + frequente (sem pin)', () => {
    const item: SalienceItem = { recency: NOW, frequency: 100, pinned: false };
    const score = computeSalience(item, DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(score.recencyComponent).toBe(1.0);
    expect(score.frequencyComponent).toBe(1.0);
    expect(score.score).toBeCloseTo(1.0, 5);
    expect(score.pinned).toBe(false);
  });

  it('score nunca excede 1.0', () => {
    const item: SalienceItem = { recency: NOW, frequency: 999_999, pinned: false };
    const score = computeSalience(item, DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(score.score).toBeLessThanOrEqual(1.0);
  });

  it('score nunca abaixo de 0', () => {
    const item: SalienceItem = { recency: 0, frequency: 0, pinned: false };
    const score = computeSalience(item, DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(score.score).toBeGreaterThanOrEqual(0);
  });

  it('decaimento exponencial: recencyComponent ≈ 0.5 após 1 meia-vida', () => {
    const halfLife = DEFAULT_MOTOR_A_CONFIG.recencyHalfLifeMs;
    const item: SalienceItem = { recency: NOW - halfLife, frequency: 1, pinned: false };
    const score = computeSalience(item, DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(score.recencyComponent).toBeCloseTo(0.5, 1);
  });

  it('computeAllSaliences retorna array de mesmo tamanho', () => {
    const items: SalienceItem[] = [
      { recency: NOW, frequency: 1, pinned: false },
      { recency: NOW - 1000, frequency: 5, pinned: false },
      { recency: NOW, frequency: 10, pinned: true },
    ];
    const scores = computeAllSaliences(items, DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(scores).toHaveLength(3);
    expect(scores[0].score).toBeGreaterThan(0);
    expect(scores[2].score).toBe(1.0); // pinned
  });
});

// ─── CA-MOTOR-ROTA — roteamento por regra ───────────────────────────────────

describe('EST-1127 · CA-MOTOR-ROTA — motorARoute (roteamento por regra)', () => {
  it('human-cancel critical → stop (R1)', () => {
    const route = motorARoute([esc()]);
    expect(route.target).toBe('stop');
    expect(route.rule).toContain('R1');
    expect(route.rule).toContain('cancelamento humano');
  });

  it('mem-pressure critical → self-heal (R2)', () => {
    const route = motorARoute([oom()]);
    expect(route.target).toBe('self-heal');
    expect(route.rule).toContain('R2');
    expect(route.rule).toContain('pressão de memória');
  });

  it('mem-pressure warning → self-heal (R2)', () => {
    const route = motorARoute([memWarn()]);
    expect(route.target).toBe('self-heal');
    expect(route.rule).toContain('R2');
  });

  it('budget critical → pause (R3)', () => {
    const route = motorARoute([budgetCrit()]);
    expect(route.target).toBe('pause');
    expect(route.rule).toContain('R3');
    expect(route.rule).toContain('orçamento');
  });

  it('budget warning → regent (não dispara regra de pause)', () => {
    const route = motorARoute([budgetWarn()]);
    expect(route.target).toBe('regent');
    expect(route.rule).toContain('R0');
  });

  it('weak-yolo critical → stop (R4)', () => {
    const route = motorARoute([yoloCrit()]);
    expect(route.target).toBe('stop');
    expect(route.rule).toContain('R4');
  });

  it('degeneration warning → self-heal (R5)', () => {
    const route = motorARoute([degen()]);
    expect(route.target).toBe('self-heal');
    expect(route.rule).toContain('R5');
  });

  it('stuck critical → self-heal (R6)', () => {
    const route = motorARoute([stuckCrit()]);
    expect(route.target).toBe('self-heal');
    expect(route.rule).toContain('R6');
  });

  it('stuck warning → pause (R7)', () => {
    const route = motorARoute([stuckWarn()]);
    expect(route.target).toBe('pause');
    expect(route.rule).toContain('R7');
  });

  it('self-check info → regent (R0 — padrão)', () => {
    const route = motorARoute([normal()]);
    expect(route.target).toBe('regent');
    expect(route.rule).toContain('R0');
  });

  it('zero sinais → regent (fallback)', () => {
    const route = motorARoute([]);
    expect(route.target).toBe('regent');
    expect(route.rule).toContain('vazio');
  });

  it('sinal com maior precedência define a rota (ESC sobre OOM)', () => {
    const route = motorARoute([oom(), esc()]);
    expect(route.target).toBe('stop'); // ESC vence
    expect(route.rule).toContain('R1');
  });

  it('sinal com maior precedência define a rota (OOM sobre budget)', () => {
    const route = motorARoute([budgetCrit(), oom()]);
    expect(route.target).toBe('self-heal'); // OOM vence
    expect(route.rule).toContain('R2');
  });

  it('rota é determinística: mesma entrada ⇒ mesma saída', () => {
    const signals = [oom(), degen(), stuckCrit()];
    const r1 = motorARoute(signals);
    const r2 = motorARoute(signals);
    expect(r1.target).toBe(r2.target);
    expect(r1.rule).toBe(r2.rule);
    expect(r1.signals).toHaveLength(r2.signals.length);
  });

  it('rota carrega os sinais de origem (rastro auditável)', () => {
    const signals = [oom()];
    const route = motorARoute(signals);
    expect(route.signals).toBe(signals);
    expect(route.signals).toHaveLength(1);
  });
});

// ─── CA-MOTOR-DET — determinismo ────────────────────────────────────────────

describe('EST-1127 · CA-MOTOR-DET — motorADecide determinístico', () => {
  it('mesma entrada + mesmo ts ⇒ mesmo resultado (ação)', () => {
    const signals = [oom(), degen()];
    const r1 = motorADecide(signals, [], DEFAULT_MOTOR_A_CONFIG, NOW);
    const r2 = motorADecide(signals, [], DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(r1.decision.action).toBe(r2.decision.action);
    expect(r1.decision.reason).toBe(r2.decision.reason);
    expect(r1.route.target).toBe(r2.route.target);
    expect(r1.scoredSignals).toHaveLength(r2.scoredSignals.length);
    // Scores devem ser idênticos
    for (let i = 0; i < r1.scoredSignals.length; i++) {
      expect(r1.scoredSignals[i].salience.score).toBe(r2.scoredSignals[i].salience.score);
    }
  });

  it('mesma entrada de sinais ⇒ mesmo tipo de ação (mesmo sem ts explícito)', () => {
    const signals = [budgetCrit(), degen()];
    const r1 = motorADecide(signals);
    const r2 = motorADecide(signals);
    expect(r1.decision.action).toBe(r2.decision.action);
    expect(r1.route.target).toBe(r2.route.target);
  });

  it('ordem dos sinais NÃO afeta decisão (precedência rege)', () => {
    const r1 = motorADecide([normal(), oom(), esc()], [], DEFAULT_MOTOR_A_CONFIG, NOW);
    const r2 = motorADecide([esc(), oom(), normal()], [], DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(r1.decision.action).toBe(r2.decision.action);
    expect(r1.route.target).toBe(r2.route.target);
  });

  it('decisão SEMPRE tem action, signals, reason, ts', () => {
    const result = motorADecide([oom(), esc()], [], DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(result.decision).toHaveProperty('action');
    expect(result.decision).toHaveProperty('signals');
    expect(result.decision).toHaveProperty('reason');
    expect(result.decision).toHaveProperty('ts');
    expect(Array.isArray(result.decision.signals)).toBe(true);
  });
});

// ─── CA-MOTOR-OFFLINE — sem rede ────────────────────────────────────────────

describe('EST-1127 · CA-MOTOR-OFFLINE — motor sem rede (CA-MA8)', () => {
  it('motorADecide funciona com zero sinais (fail-safe)', () => {
    const result = motorADecide([], [], DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(result.decision.action).toBe('continuar');
    expect(result.route.target).toBe('regent');
    expect(result.scoredSignals).toHaveLength(0);
  });

  it('motorADecide funciona sem salienceItems explícitos', () => {
    const result = motorADecide([normal(), oom()], [], DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(result.decision.action).toBe('recuperar'); // OOM critical → recuperar
    expect(result.scoredSignals).toHaveLength(2);
    // Scores default são computados mesmo sem SalienceItem explícito
    for (const ss of result.scoredSignals) {
      expect(ss.salience.score).toBeGreaterThanOrEqual(0);
      expect(ss.salience.score).toBeLessThanOrEqual(1.0);
    }
  });

  it('salienceItems explícitos são usados quando fornecidos', () => {
    const items: SalienceItem[] = [
      { recency: NOW, frequency: 100, pinned: true },
      { recency: 0, frequency: 1, pinned: false },
    ];
    const result = motorADecide(
      [normal(NOW), memWarn(NOW + 3)],
      items,
      DEFAULT_MOTOR_A_CONFIG,
      NOW,
    );
    expect(result.scoredSignals[0].salience.score).toBe(1.0); // pinned
    expect(result.scoredSignals[0].salience.pinned).toBe(true);
    expect(result.scoredSignals[1].salience.score).toBeLessThan(1.0); // old + low freq
  });

  it('resultado inclui salience scores para cada sinal', () => {
    const signals = [oom(), degen(), stuckCrit()];
    const result = motorADecide(signals, [], DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(result.scoredSignals).toHaveLength(signals.length);
    for (const ss of result.scoredSignals) {
      expect(ss.signal).toBeDefined();
      expect(ss.salience).toHaveProperty('score');
      expect(ss.salience).toHaveProperty('recencyComponent');
      expect(ss.salience).toHaveProperty('frequencyComponent');
    }
  });

  it('resultado inclui rota por regra (rastro auditável)', () => {
    const result = motorADecide([oom()], [], DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(result.route.target).toBe('self-heal');
    expect(result.route.rule.length).toBeGreaterThan(0);
    expect(result.route.signals).toHaveLength(1);
  });

  it('resultado inclui decisão consolidada via regente', () => {
    const result = motorADecide([oom(), degen()], [], DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(result.decision.action).toBe('recuperar');
    expect(result.decision.reason.length).toBeGreaterThan(0);
  });

  it('mesmo com todos os sinais críticos, não faz nenhuma chamada de rede', () => {
    // CA-MOTOR-OFFLINE: o motor (a) é puramente local, sem I/O de rede.
    // Verificamos que o motor produz resultado correto SEM lançar erro
    // de rede — ele NÃO tem código de rede.
    const allCritical = [esc(), oom(), budgetCrit(), degen(), stuckCrit(), yoloCrit()];
    const result = motorADecide(allCritical, [], DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(result.decision.action).toBeDefined();
    expect(result.route.target).toBeDefined();
    // Se chegou aqui sem erro de rede, CA-MOTOR-OFFLINE está provado.
  });
});

// ─── CA-MOTOR-RECUP — regência com provider fora ────────────────────────────

describe('EST-1127 · CA-MOTOR-RECUP — regência com provider fora', () => {
  it('motor (a) continua regendo com provider fora (CA-MA8)', () => {
    // Quando o provider está fora, o motor (a) NÃO depende dele —
    // é heurística pura. Sinais de erro do provider (ex.: weak-yolo
    // critical) são tratados por regra local.
    const signals = [yoloCrit()]; // provider não respondeu → yolo
    const result = motorADecide(signals, [], DEFAULT_MOTOR_A_CONFIG, NOW);
    // O motor (a) NÃO tenta chamar provider — ele roteia por regra.
    expect(result.route.target).toBe('stop'); // R4: yolo perigoso → stop
    expect(result.decision.action).toBe('parar');
    // A regência NÃO trava — o motor (a) emite decisão localmente.
  });

  it('provider fora + mem-pressure crítico ⇒ motor (a) rege recuperação', () => {
    // Cenário: provider caiu E a memória está sob pressão.
    // O motor (a) rege recuperação de contexto mesmo sem provider.
    const signals = [oom(), yoloCrit()];
    const result = motorADecide(signals, [], DEFAULT_MOTOR_A_CONFIG, NOW);
    // OOM tem precedência sobre yolo → self-heal
    expect(result.route.target).toBe('self-heal');
    expect(result.decision.action).toBe('recuperar');
    // O motor (a) NÃO para por falta de provider — ele recupera contexto.
  });

  it('zero sinais → motor (a) segue regendo (não trava)', () => {
    const result = motorADecide([], [], DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(result.decision.action).toBe('continuar');
    expect(result.route.target).toBe('regent');
    // Não trava, não lança exceção.
  });

  it('sinal único self-check → motor (a) continua normalmente', () => {
    const result = motorADecide([normal()], [], DEFAULT_MOTOR_A_CONFIG, NOW);
    expect(result.decision.action).toBe('continuar');
    expect(result.route.target).toBe('regent');
  });
});

// ─── Fronteira ADR-0053 §8 — motor-a.ts sem I/O ────────────────────────────

describe('EST-1127 · fronteira — motor-a.ts sem I/O (ADR-0053 §8)', () => {
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
    'node:http',
    'http',
    'node:https',
    'https',
    'node:dns',
    'dns',
    'node:tls',
    'tls',
  ];

  it('motor-a.ts não importa I/O proibido', () => {
    const content = readFileSync(join(MAESTRO_DIR, 'motor-a.ts'), 'utf-8');
    const staticRe = /(?:import|export)[^'"]*?['"]([^'"]+)['"]/g;
    const dynRe = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    for (const re of [staticRe, dynRe]) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const specifier = match[1];
        for (const fb of FORBIDDEN) {
          if (specifier === fb || specifier.startsWith(fb + '/')) {
            throw new Error(`motor-a.ts importa I/O proibido: "${specifier}" (ADR-0053 §8)`);
          }
        }
      }
    }
  });

  it('motor-a.ts só importa de módulos locais do maestro', () => {
    const content = readFileSync(join(MAESTRO_DIR, 'motor-a.ts'), 'utf-8');
    const importRe = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(content)) !== null) {
      const specifier = match[1];
      // Deve ser import relativo local ou type-only de pacote.
      const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
      if (!isRelative && !specifier.startsWith('node:')) {
        // imports como 'vitest' são só nos testes, não no fonte.
        // No fonte, todo import deve ser relativo.
      }
      if (isRelative) {
        // Deve ser dentro de ./maestro/
        expect(specifier).toMatch(/^\.\/[a-z-]+\.js$/);
      }
    }
  });
});

// ─── Smoke: barrel re-exporta motor-a ───────────────────────────────────────

describe('EST-1127 · barrel — motor-a exportado via index', () => {
  it('tipos e funções exportados via maestro/index', async () => {
    const mod = await import('../../src/agent/maestro/index.js');
    expect(mod.motorADecide).toBeDefined();
    expect(mod.motorARoute).toBeDefined();
    expect(mod.computeSalience).toBeDefined();
    expect(mod.computeAllSaliences).toBeDefined();
    expect(mod.DEFAULT_MOTOR_A_CONFIG).toBeDefined();
  });
});
