// EST-0981 · ADR-0062 (APR-0067) · CLI-SEC-14 — a bateria do gate FORTE do `seguranca`
// (anti-runaway de autonomia) sobre o MOTOR de `/cycle`. Foca o RUNTIME:
//   • GS-L2/E-A2/RES-L-1 — budget AGREGADO atômico (soma de TODOS os ciclos +
//     sub-agentes; contador ÚNICO) PARA fechado no teto; atomicidade provada.
//   • GS-L2 — teto de iterações + teto de duração param fechado.
//   • GS-L4/RES-L-3 — conclusão para AO CONCLUIR; não-progresso ⇒ para (loop-vazio).
//   • GS-L5/RES-L-2 — parável a qualquer hora (abort entre ciclos E acorda o sleep).
//   • GS-L8 — os dois ritmos (fixed intervalo + auto-pace nextDelayMs), mesmos tetos.
//   • GS-L1 — a MESMA `task` re-dispara o MESMO runner (sem grant carregado — o
//     engine NÃO toca a catraca; quem roda a catraca por-ciclo é o runner).

import { describe, expect, it } from 'vitest';
import {
  CycleEngine,
  SharedBudget,
  resolveCycleCeilings,
  aggregateLimitsOf,
  DEFAULT_STALL_TOLERANCE,
  type CycleCeilings,
  type CycleRunner,
  type CycleOutcome,
  type AbortableSleep,
} from '../../src/index.js';

/** Relógio determinístico controlável. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** Sleep determinístico que AVANÇA o relógio fake (e respeita o abort — GS-L5). */
function clockSleep(clock: { advance: (ms: number) => void }): AbortableSleep {
  return (ms, signal) => {
    if (!signal.aborted) clock.advance(ms);
    return Promise.resolve();
  };
}

/** Um runner controlado por uma fila de desfechos (um por ciclo). */
function queuedRunner(outcomes: CycleOutcome[]): CycleRunner & { calls: number; tasks: string[] } {
  let i = 0;
  const tasks: string[] = [];
  return {
    calls: 0,
    tasks,
    async runCycle({ task }) {
      this.calls += 1;
      tasks.push(task);
      return outcomes[Math.min(i++, outcomes.length - 1)] ?? { done: false };
    },
  };
}

describe('EST-0981 · GS-L2 — teto de ITERAÇÕES para FECHADO (não faz "só mais uma")', () => {
  it('roda exatamente maxIterations ciclos e para', async () => {
    const ceilings = resolveCycleCeilings({ rhythm: 'fixed', maxIterations: 3 });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    const runner = queuedRunner([{ done: false, progress: 'p0' }]);
    // marcadores de progresso distintos p/ não disparar anti-loop-vazio
    let n = 0;
    runner.runCycle = async ({ task }) => {
      runner.calls++;
      runner.tasks.push(task);
      return { done: false, progress: `p${n++}` };
    };
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: fakeClock().now,
      sleep: () => Promise.resolve(),
    });
    const res = await engine.run('tarefa', new AbortController().signal);
    expect(res.stop).toEqual({ kind: 'max-iterations', limit: 3 });
    expect(res.cyclesRun).toBe(3);
  });
});

describe('EST-0981 · GS-L2 — teto de DURAÇÃO (relógio) para FECHADO', () => {
  it('para quando o relógio cruza o deadline (não inicia ciclo que estouraria)', async () => {
    const clock = fakeClock();
    const ceilings = resolveCycleCeilings({
      rhythm: 'fixed',
      intervalMs: 5 * 60_000,
      maxDurationMs: 12 * 60_000,
    });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    let n = 0;
    const runner: CycleRunner = {
      async runCycle() {
        return { done: false, progress: `p${n++}` };
      },
    };
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: clock.now,
      sleep: clockSleep(clock), // cada espera de 5min avança o relógio
    });
    const res = await engine.run('tarefa', new AbortController().signal);
    expect(res.stop).toEqual({ kind: 'max-duration', limitMs: 12 * 60_000 });
    // 0min: c0 → sleep 5min(=5) → 5min: c1 → sleep(=10) → 10min: c2 → sleep clamp(=12) → deadline.
    expect(res.cyclesRun).toBe(3);
  });
});

describe('EST-0981 · GS-L2/E-A2/RES-L-1 · FU-S3-RES1 — BUDGET AGREGADO atômico para FECHADO', () => {
  it('CORTE ATÔMICO (overshoot=0): o ciclo PARA no ponto EXATO do teto agregado, não "teto + 1 ciclo"', async () => {
    // FU-S3-RES1 — O FIX. O `aggregate` é injetado COMO o budget de cada ciclo (no real:
    // `loop.run(..., aggregate)` via budgetOverride). O loop do ciclo debita DIRETO no
    // contador agregado e, com a reserva ATÔMICA (E-A2), PARA assim que a soma cross-ciclo
    // bate o teto — DENTRO do ciclo, não depois. Aqui modelamos exatamente isso: o runner
    // só "gasta" enquanto a reserva atômica permite (espelha o `tryConsume*` do loop).
    const ceilings: CycleCeilings = resolveCycleCeilings({
      rhythm: 'fixed',
      maxIterations: 100, // alto: quem deve parar é o BUDGET, não as iterações
      maxTokens: 1000,
    });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    let n = 0;
    const runner: CycleRunner = {
      async runCycle() {
        // O ciclo gasta em PASSOS de 100 tokens, MAS reserva-e-checa atômico contra o
        // MESMO contador agregado: assim que a soma cross-ciclo atinge o teto, o ciclo
        // CESSA no ato (não há "passou de 1000"). Espelha o débito intra-ciclo do loop real.
        for (let step = 0; step < 4; step++) {
          if (budget.tokensExceeded()) break; // portão pré-gasto (fail-safe pré-429)
          budget.addTokens(100);
        }
        return { done: false, progress: `p${n++}` };
      },
    };
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: fakeClock().now,
      sleep: () => Promise.resolve(),
    });
    const res = await engine.run('tarefa', new AbortController().signal);
    // c0: 0→400, c1: 400→800, c2: 800→1000 (corta NO teto: 2 passos, não 4). O portão
    // pré-ciclo seguinte PARA por budget. O contador para EXATAMENTE em 1000 — overshoot=0
    // (antes do fix parava em 1200 = "teto + 1 ciclo"; a tabela GS-L2 agora é honesta).
    expect(res.stop).toEqual({ kind: 'budget', limit: 'tokens' });
    expect(res.usage.tokens).toBe(1000); // PROVA do corte atômico: NÃO 1200
    expect(budget.usage.tokens).toBeLessThanOrEqual(1000); // a soma NUNCA fura o teto
  });

  it('o portão pré-ciclo do CycleEngine permanece como 2ª linha de defesa (peek não-consome)', async () => {
    // Mesmo que um ciclo "esqueça" de cortar intra-ciclo, o portão pré-ciclo (peekExceeded)
    // ainda barra o PRÓXIMO ciclo — defesa em profundidade. Aqui o budget JÁ está no teto
    // antes do 1º ciclo ⇒ nenhum ciclo inicia (falha-fechada).
    const ceilings: CycleCeilings = resolveCycleCeilings({
      rhythm: 'fixed',
      maxIterations: 100,
      maxTokens: 1000,
    });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    budget.addTokens(1000); // já no teto
    const runner = queuedRunner([{ done: false, progress: 'x' }]);
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: fakeClock().now,
      sleep: () => Promise.resolve(),
    });
    const res = await engine.run('tarefa', new AbortController().signal);
    expect(res.stop).toEqual({ kind: 'budget', limit: 'tokens' });
    expect(res.cyclesRun).toBe(0); // nenhum ciclo iniciou — peek barrou no portão
    expect(runner.calls).toBe(0);
  });

  it('ATOMICIDADE: ciclos + SUB-AGENTES debitam do MESMO contador (soma nunca fura)', async () => {
    // O budget agregado é UM só. Aqui o "ciclo" inclui sub-agentes que reservam
    // tool-calls do MESMO SharedBudget — provamos que a reserva atômica impede
    // que a soma (ciclo + sub-agentes) passe do teto.
    const limits = { maxIterations: 1000, maxToolCalls: 5, maxTokens: 1_000_000 };
    const budget = new SharedBudget(limits);
    // Simula DOIS sub-agentes paralelos por ciclo, cada um tentando reservar
    // tool-calls do MESMO contador, intercalados (interleave de Promises).
    const reservations: boolean[] = [];
    const childWork = async (): Promise<void> => {
      for (let k = 0; k < 4; k++) {
        // reserva ATÔMICA (síncrona) — indivisível sob interleave (E-A2)
        const r = budget.tryConsumeToolCall();
        reservations.push(r.ok);
        await Promise.resolve(); // ponto de interleave
      }
    };
    await Promise.all([childWork(), childWork()]);
    // 2 filhos × 4 tentativas = 8 reservas; teto = 5 ⇒ exatamente 5 ok, 3 falham.
    expect(reservations.filter((ok) => ok).length).toBe(5);
    expect(budget.usage.toolCalls).toBe(5); // NUNCA passa de 5 — atomicidade
  });
});

describe('EST-0981 · GS-L4/RES-L-3 — conclusão + anti-loop-vazio', () => {
  it('para AO CONCLUIR (não espera o teto)', async () => {
    const ceilings = resolveCycleCeilings({ rhythm: 'fixed', maxIterations: 50 });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    const runner = queuedRunner([
      { done: false, progress: 'a' },
      { done: false, progress: 'b' },
      { done: true, progress: 'c' }, // 3º ciclo conclui
    ]);
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: fakeClock().now,
      sleep: () => Promise.resolve(),
    });
    const res = await engine.run('tarefa', new AbortController().signal);
    expect(res.stop).toEqual({ kind: 'completed' });
    expect(res.cyclesRun).toBe(3);
  });

  it('NÃO-PROGRESSO ⇒ para (loop-vazio): mesmo marcador em ciclos consecutivos', async () => {
    const ceilings = resolveCycleCeilings({ rhythm: 'fixed', maxIterations: 50 });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    // sempre o MESMO marcador 'same' ⇒ não progride
    const runner: CycleRunner = {
      async runCycle() {
        return { done: false, progress: 'same' };
      },
    };
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: fakeClock().now,
      sleep: () => Promise.resolve(),
    });
    const res = await engine.run('tarefa', new AbortController().signal);
    expect(res.stop).toMatchObject({ kind: 'no-progress' });
    // c0 estabelece o baseline; c1 e c2 sem progresso ⇒ stall atinge tolerância.
    expect(res.cyclesRun).toBe(1 + DEFAULT_STALL_TOLERANCE);
  });

  it('auto-pacing que "decide repetir" sobre o mesmo estado ⇒ detecta e para (RES-L-3)', async () => {
    const ceilings = resolveCycleCeilings({ rhythm: 'auto-pace', maxIterations: 50 });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    // auto-pace pede re-disparo imediato (nextDelayMs:0) mas sem progredir.
    const runner: CycleRunner = {
      async runCycle() {
        return { done: false, progress: 'frozen', nextDelayMs: 0 };
      },
    };
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: fakeClock().now,
      sleep: () => Promise.resolve(),
    });
    const res = await engine.run('tarefa', new AbortController().signal);
    expect(res.stop).toMatchObject({ kind: 'no-progress' });
  });

  it('ausência de marcador de progresso conta como NÃO-progresso (conservador)', async () => {
    const ceilings = resolveCycleCeilings({ rhythm: 'fixed', maxIterations: 50 });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    const runner: CycleRunner = {
      async runCycle() {
        return { done: false }; // sem progress
      },
    };
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: fakeClock().now,
      sleep: () => Promise.resolve(),
    });
    const res = await engine.run('tarefa', new AbortController().signal);
    expect(res.stop).toMatchObject({ kind: 'no-progress' });
  });
});

describe('EST-0981 · GS-L5/RES-L-2 — PARÁVEL a qualquer hora (reusa abort/freio)', () => {
  it('abortado ENTRE ciclos ⇒ para limpo (cessar≠agir)', async () => {
    const ceilings = resolveCycleCeilings({ rhythm: 'fixed', maxIterations: 50 });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    const ac = new AbortController();
    let n = 0;
    const runner: CycleRunner = {
      async runCycle() {
        n++;
        if (n === 2) ac.abort(); // usuário aborta durante o 2º ciclo
        return { done: false, progress: `p${n}` };
      },
    };
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: fakeClock().now,
      sleep: () => Promise.resolve(),
    });
    const res = await engine.run('tarefa', ac.signal);
    expect(res.stop).toEqual({ kind: 'aborted' });
    expect(res.cyclesRun).toBe(2); // parou logo após o ciclo que abortou
  });

  it('abortar ACORDA o sleep (não espera o intervalo inteiro)', async () => {
    const ceilings = resolveCycleCeilings({
      rhythm: 'fixed',
      intervalMs: 60 * 60_000, // 1h de intervalo
      maxDurationMs: 2 * 60 * 60_000,
    });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    const ac = new AbortController();
    let n = 0;
    const runner: CycleRunner = {
      async runCycle() {
        n++;
        ac.abort(); // aborta já no 1º ciclo, antes de "dormir" 1h
        return { done: false, progress: `p${n}` };
      },
    };
    // sleep REAL abortável (default): se respeitar o abort, resolve na hora.
    const engine = new CycleEngine({ ceilings, runner, budget, clock: fakeClock().now });
    const res = await engine.run('tarefa', ac.signal);
    expect(res.stop).toEqual({ kind: 'aborted' });
  });

  it('signal JÁ abortado ⇒ não roda nenhum ciclo', async () => {
    const ceilings = resolveCycleCeilings({ rhythm: 'fixed', maxIterations: 5 });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    const runner = queuedRunner([{ done: false, progress: 'x' }]);
    const ac = new AbortController();
    ac.abort();
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: fakeClock().now,
      sleep: () => Promise.resolve(),
    });
    const res = await engine.run('tarefa', ac.signal);
    expect(res.stop).toEqual({ kind: 'aborted' });
    expect(runner.calls).toBe(0);
  });
});

describe('EST-0981 · GS-L8 — os DOIS ritmos', () => {
  it('AUTO-PACE: o runner decide o ritmo (nextDelayMs) — tetos valem iguais', async () => {
    const clock = fakeClock();
    const ceilings = resolveCycleCeilings({
      rhythm: 'auto-pace',
      maxDurationMs: 25 * 60_000,
    });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    let n = 0;
    const runner: CycleRunner = {
      async runCycle() {
        return { done: false, progress: `p${n++}`, nextDelayMs: 10 * 60_000 };
      },
    };
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: clock.now,
      sleep: clockSleep(clock),
    });
    const res = await engine.run('tarefa', new AbortController().signal);
    // 0: c0 → sleep 10 → 10: c1 → sleep 10 → 20: c2 → sleep clamp 5 → 25 deadline.
    expect(res.stop).toEqual({ kind: 'max-duration', limitMs: 25 * 60_000 });
    expect(res.cyclesRun).toBe(3);
  });
});

describe('EST-0981 · GS-L1 — a MESMA task re-dispara o MESMO runner (engine não toca catraca)', () => {
  it('a task é idêntica em todos os ciclos (sem mutação/acúmulo de estado pelo engine)', async () => {
    const ceilings = resolveCycleCeilings({ rhythm: 'fixed', maxIterations: 3 });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    let n = 0;
    const runner = queuedRunner([]);
    runner.runCycle = async ({ task }) => {
      runner.tasks.push(task);
      return { done: false, progress: `p${n++}` };
    };
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: fakeClock().now,
      sleep: () => Promise.resolve(),
    });
    await engine.run('rode os testes', new AbortController().signal);
    expect(runner.tasks).toEqual(['rode os testes', 'rode os testes', 'rode os testes']);
  });

  it('observer é notificado de início/fim de cada ciclo e da parada (UI do laço vivo)', async () => {
    const ceilings = resolveCycleCeilings({ rhythm: 'fixed', maxIterations: 2 });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    let n = 0;
    const runner: CycleRunner = {
      async runCycle() {
        return { done: false, progress: `p${n++}` };
      },
    };
    const starts: number[] = [];
    const ends: number[] = [];
    const stops: string[] = [];
    const engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: fakeClock().now,
      sleep: () => Promise.resolve(),
      observer: {
        onCycleStart: (i) => starts.push(i),
        onCycleEnd: (i) => ends.push(i),
        onStop: (s) => stops.push(s.kind),
      },
    });
    await engine.run('t', new AbortController().signal);
    expect(starts).toEqual([0, 1]);
    expect(ends).toEqual([0, 1]);
    expect(stops).toEqual(['max-iterations']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EST-1158 — reconfigurar AO VIVO + pausar/retomar (lifecycle do /cycle in-session)
// ═══════════════════════════════════════════════════════════════════════════════

describe('EST-1158 — reconfigurar ao vivo + pausar/retomar', () => {
  function base(maxIterations: number): {
    clock: ReturnType<typeof fakeClock>;
    ceilings: CycleCeilings;
    budget: SharedBudget;
  } {
    const clock = fakeClock();
    const ceilings = resolveCycleCeilings({ rhythm: 'fixed', maxIterations, intervalMs: 0 });
    const budget = new SharedBudget(aggregateLimitsOf(ceilings));
    return { clock, ceilings, budget };
  }

  it('reconfigure(task) vale na PRÓXIMA iteração (não reinicia; contadores acumulam)', async () => {
    const { clock, ceilings, budget } = base(10);
    const tasks: string[] = [];
    // eslint-disable-next-line prefer-const -- forward-ref: o runner referencia `engine` antes da criação
    let engine!: CycleEngine;
    const runner: CycleRunner = {
      async runCycle({ task, iteration }) {
        tasks.push(task);
        if (iteration === 1) engine.reconfigure({ task: 'tarefa NOVA' });
        return { done: iteration >= 3, progress: `p${iteration}` };
      },
    };
    engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: clock.now,
      sleep: () => Promise.resolve(),
    });
    const res = await engine.run('tarefa ORIGINAL', new AbortController().signal);
    expect(tasks[0]).toBe('tarefa ORIGINAL');
    expect(tasks[1]).toBe('tarefa ORIGINAL'); // reconfig na iter 1 só vale da iter 2
    expect(tasks[2]).toBe('tarefa NOVA');
    expect(res.cyclesRun).toBe(4); // 0..3 ACUMULADO, não reiniciou
  });

  it('reconfigure(maxIterations) menor PARA mais cedo (o teto vale ao vivo)', async () => {
    const { clock, ceilings, budget } = base(10);
    // eslint-disable-next-line prefer-const -- forward-ref: o runner referencia `engine` antes da criação
    let engine!: CycleEngine;
    const runner: CycleRunner = {
      async runCycle({ iteration }) {
        if (iteration === 0) engine.reconfigure({ maxIterations: 2 });
        return { done: false, progress: `p${iteration}` };
      },
    };
    engine = new CycleEngine({
      ceilings,
      runner,
      budget,
      clock: clock.now,
      sleep: () => Promise.resolve(),
    });
    const res = await engine.run('t', new AbortController().signal);
    expect(res.cyclesRun).toBe(2);
    expect(res.stop.kind).toBe('max-iterations');
  });

  it('reconfigure REJEITA tirar o teto (CLI-SEC-14): max-iter <1 / não-inteiro / intervalo <0', () => {
    const { clock, ceilings, budget } = base(3);
    const engine = new CycleEngine({
      ceilings,
      runner: queuedRunner([]),
      budget,
      clock: clock.now,
      sleep: () => Promise.resolve(),
    });
    expect(() => engine.reconfigure({ maxIterations: 0 })).toThrow();
    expect(() => engine.reconfigure({ maxIterations: 1.5 })).toThrow();
    expect(() => engine.reconfigure({ intervalMs: -1 })).toThrow();
    expect(() => engine.reconfigure({ maxIterations: 5, task: 'ok', intervalMs: 0 })).not.toThrow();
  });

  it('pause: o loop ESPERA enquanto pausado; resume destrava e completa', async () => {
    const { clock, ceilings, budget } = base(5);
    // eslint-disable-next-line prefer-const -- forward-ref: o runner referencia `engine` antes da criação
    let engine!: CycleEngine;
    const runner: CycleRunner = {
      async runCycle({ iteration }) {
        if (iteration === 0) engine.pause();
        return { done: iteration >= 2, progress: `p${iteration}` };
      },
    };
    // intervalMs=0 ⇒ sem sleep de ritmo; o sleep só roda na ESPERA de pausa. Após 3
    // verificações, retoma.
    let pauseChecks = 0;
    const sleep: AbortableSleep = async (_ms, signal) => {
      if (signal.aborted) return;
      pauseChecks += 1;
      if (pauseChecks === 3) engine.resume();
    };
    engine = new CycleEngine({ ceilings, runner, budget, clock: clock.now, sleep });
    const res = await engine.run('t', new AbortController().signal);
    expect(pauseChecks).toBeGreaterThanOrEqual(3); // esperou de fato
    expect(engine.isPaused).toBe(false); // retomado
    expect(res.cyclesRun).toBe(3); // 0,1,2 — completou após retomar
  });
});
