// EST-0981 · ADR-0062 (APR-0067) · CLI-SEC-14 (GS-L1..L8 · RES-L-1/2/3/4) —
// O MOTOR DE `/cycle`: autonomia REPETIDA cercada por paradas DURAS, parável,
// mesma catraca por ciclo, Plan-só-lê. O ÚLTIMO grande da Sprint 3.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ INVARIANTES (gate FORTE do `seguranca` — CLI-SEC-14 · anti-runaway):       ║
// ║                                                                            ║
// ║ • GS-L1 — MESMA CATRACA POR CICLO. Cada ciclo roda o MESMO `runner` (o loop ║
// ║   agêntico completo plugado na `decide()` ÚNICA), no MESMO modo/confinamento.║
// ║   O CycleEngine NÃO toca a catraca: é um ORQUESTRADOR de re-disparo ACIMA da  ║
// ║   sessão. NENHUM grant persiste entre ciclos — o runner usa a MESMA engine de ║
// ║   permissão (grants one-shot do ciclo morrem com o ciclo; sempre-ask pergunta  ║
// ║   a CADA ciclo). "Repetir ≠ relaxar."                                        ║
// ║                                                                            ║
// ║ • GS-L2 / RES-L-1 — PARADAS DURAS. Só roda com `CycleCeilings` (construído por ║
// ║   `resolveCycleCeilings`, que RECUSA "sem teto"). Para SEMPRE por: duração     ║
// ║   (relógio) · iterações (nº de ciclos) · BUDGET AGREGADO (SharedBudget/E-A2,    ║
// ║   soma de TODOS os ciclos + sub-agentes, contador único atômico) · conclusão.  ║
// ║                                                                            ║
// ║ • GS-L3 — `--unsafe`/`--yolo` NÃO relaxa os tetos. O CycleEngine nem conhece    ║
// ║   o modo: os tetos são checados antes de qualquer ciclo, independentes do modo. ║
// ║                                                                            ║
// ║ • GS-L4 / RES-L-3 — ANTI-LOOP-VAZIO. Um ciclo que NÃO PROGRIDE (mesmo estado,   ║
// ║   sem efeito útil) é detectado por `progressOf` do runner; N ciclos sem         ║
// ║   progresso ⇒ PARA. Auto-pacing que "decide repetir" sobre o mesmo estado para. ║
// ║                                                                            ║
// ║ • GS-L5 / RES-L-2 — PARÁVEL. Reusa o `AbortSignal` (EST-0948/0982): abortado ⇒  ║
// ║   o engine para entre ciclos E o `delay` acorda na hora; cessar≠agir (não chama ║
// ║   decide, não executa efeito). Auto-para nos tetos com motivo reportado.        ║
// ║                                                                            ║
// ║ • GS-L6 — PLAN nega efeito POR CICLO. É o runner (mesma engine, modo Plan) que  ║
// ║   nega; o CycleEngine não precisa fazer nada além de NÃO relaxar — em Plan, cada ║
// ║   ciclo só lê. (Plan-só-lê é propriedade da `decide()`, herdada por-ciclo.)     ║
// ║                                                                            ║
// ║ • GS-L7 / RES-L-4 — toda `llm_call` de todo ciclo (+ sub-agentes) pelo broker.   ║
// ║   Propriedade do runner (que roda o loop com o ModelCaller do broker); o engine ║
// ║   não tem rota de modelo própria — re-dispara o MESMO runner.                   ║
// ║                                                                            ║
// ║ • GS-L8 — OS DOIS RITMOS, MESMOS TETOS. `fixed` (intervalo/duração) E            ║
// ║   `auto-pace` (o runner decide via `nextDelayMs`); os tetos DUROS valem iguais.  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL (ADR-0053 §8): scheduler/contadores/abort + relógio/sleep injetáveis.
// Sem Ink, sem I/O de terminal. O comando `/cycle` + a UI do laço vivo são do @aluy/cli.

import type { CycleCeilings } from './cycle-limits.js';
import type { BudgetGate, LimitKind } from '../limits.js';

/** Resultado de UM ciclo, devolvido pelo runner ao engine (observação pura). */
export interface CycleOutcome {
  /**
   * `true` se a TAREFA concluiu (não há mais o que fazer) — sinal de CONCLUSÃO
   * (GS-L4). O runner o deriva do desfecho do loop agêntico (resposta final que
   * declara conclusão), nunca o engine.
   */
  readonly done: boolean;
  /**
   * Marcador de PROGRESSO deste ciclo (GS-L4/RES-L-3): uma string/hash do estado
   * resultante (ex.: nº de efeitos aplicados, hash do resultado). Se o marcador
   * REPETE entre ciclos consecutivos, o ciclo NÃO progrediu (loop-vazio). `undefined`
   * ⇒ tratado como "sem sinal de progresso" (conta como não-progresso).
   */
  readonly progress?: string;
  /**
   * AUTO-PACE (GS-L8): ms até o PRÓXIMO ciclo, decididos pelo runner/agente. Só
   * consultado quando `rhythm === 'auto-pace'`. Negativo/undefined ⇒ back-to-back (0).
   * NÃO afeta os tetos — só o ritmo.
   */
  readonly nextDelayMs?: number;
  /** Texto curto do desfecho do ciclo (p/ a UI/relatório). Opcional. */
  readonly summary?: string;
}

/**
 * O RUNNER de UM ciclo: roda o loop agêntico COMPLETO pela catraca única (GS-L1).
 * É a costura com o `AgentLoop`/controller (que tem a engine de permissão, o modo,
 * o confinamento, o broker). O CycleEngine só o re-dispara — NÃO conhece a catraca.
 *
 * `signal` propaga o abort (parável — GS-L5); `iteration` é o índice 0-based do ciclo
 * (p/ logs/UI). O runner DEVE consumir o MESMO `budget` agregado (injetado no loop) —
 * assim a soma de todos os ciclos + sub-agentes debita do contador único (GS-L2/E-A2).
 */
export interface CycleRunner {
  runCycle(args: {
    readonly iteration: number;
    readonly task: string;
    readonly signal: AbortSignal;
  }): Promise<CycleOutcome>;
}

/** Relógio injetável (teste determinístico). Default `Date.now`. */
export type Clock = () => number;

/**
 * Sleep injetável, ABORTÁVEL (parável — GS-L5): resolve após `ms` OU quando o signal
 * aborta (o que vier primeiro). Default usa `setTimeout` + listener de abort. Em
 * teste, um sleep determinístico (fake timers) é injetado.
 */
export type AbortableSleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Por que o `/cycle` parou (motivo reportado — GS-L5). */
export type CycleStop =
  | { readonly kind: 'completed' } // tarefa concluiu (GS-L4 — detecção de conclusão)
  | { readonly kind: 'max-iterations'; readonly limit: number } // teto de ciclos (GS-L2)
  | { readonly kind: 'max-duration'; readonly limitMs: number } // teto de duração (GS-L2)
  | { readonly kind: 'budget'; readonly limit: LimitKind } // budget agregado (GS-L2/E-A2)
  | { readonly kind: 'no-progress'; readonly stalledCycles: number } // anti-loop-vazio (GS-L4)
  | { readonly kind: 'aborted' }; // parado pelo usuário (GS-L5)

/** Resultado FINAL do `/cycle`: por que parou + contagens. */
export interface CycleRunResult {
  readonly stop: CycleStop;
  readonly cyclesRun: number;
  readonly elapsedMs: number;
  /** Uso AGREGADO (do SharedBudget) — soma de todos os ciclos + sub-agentes. */
  readonly usage: { iterations: number; toolCalls: number; tokens: number };
}

/** Observador OPCIONAL do laço vivo (a UI do @aluy/cli pluga: ciclo N, parada). */
export interface CycleObserver {
  /** Um ciclo VAI rodar (iteration 0-based). */
  onCycleStart?(iteration: number): void;
  /** Um ciclo TERMINOU (com seu desfecho). */
  onCycleEnd?(iteration: number, outcome: CycleOutcome): void;
  /** O `/cycle` parou (motivo final). */
  onStop?(stop: CycleStop): void;
}

/**
 * Quantos ciclos consecutivos SEM PROGRESSO toleramos antes de parar (anti-loop-vazio,
 * GS-L4/RES-L-3). Conservador: 2 ciclos seguidos sem progresso ⇒ para (não fica
 * girando à toa queimando budget). O 1º ciclo nunca conta como "sem progresso"
 * (não há anterior para comparar).
 */
export const DEFAULT_STALL_TOLERANCE = 2;

/** EST-1158 — quando PAUSADO, o loop reverifica o flag a cada N ms (abortável). */
const PAUSE_POLL_MS = 200;

export interface CycleEngineOptions {
  readonly ceilings: CycleCeilings;
  readonly runner: CycleRunner;
  /**
   * O budget AGREGADO COMPARTILHADO (SharedBudget/E-A2): o MESMO contador que o
   * runner injeta no loop de cada ciclo (e que os sub-agentes de cada ciclo
   * compartilham). O engine o LÊ entre ciclos p/ o portão pré-ciclo do budget
   * (GS-L2): se o teto AGREGADO já estourou, NÃO inicia o próximo ciclo. A soma de
   * TODOS os ciclos + sub-agentes nunca passa do teto — atomicidade provada no
   * SharedBudget (E-A2). Reusa, não reinventa.
   */
  readonly budget: BudgetGate;
  readonly clock?: Clock;
  readonly sleep?: AbortableSleep;
  readonly observer?: CycleObserver;
  /** Tolerância de não-progresso (default `DEFAULT_STALL_TOLERANCE`). */
  readonly stallTolerance?: number;
}

/**
 * O MOTOR de `/cycle`. Re-dispara o `runner` em ciclos até bater UM teto DURO,
 * detectar conclusão/não-progresso, ou ser abortado. NÃO toca a catraca (o runner
 * é quem roda o loop pela `decide()` única). Determinístico (relógio/sleep injetáveis).
 */
export class CycleEngine {
  // EST-1158 — `ceilings`/`task` MUTÁVEIS p/ reconfigurar AO VIVO (vale na próxima
  // iteração). O cap NUNCA some (CLI-SEC-14): `reconfigure` exige maxIterations ≥ 1.
  private ceilings: CycleCeilings;
  private currentTask = '';
  private paused = false;
  private readonly runner: CycleRunner;
  private readonly budget: BudgetGate;
  private readonly clock: Clock;
  private readonly sleep: AbortableSleep;
  private readonly observer?: CycleObserver;
  private readonly stallTolerance: number;

  constructor(opts: CycleEngineOptions) {
    this.ceilings = opts.ceilings;
    this.runner = opts.runner;
    this.budget = opts.budget;
    this.clock = opts.clock ?? Date.now;
    this.sleep = opts.sleep ?? defaultAbortableSleep;
    if (opts.observer) this.observer = opts.observer;
    this.stallTolerance = opts.stallTolerance ?? DEFAULT_STALL_TOLERANCE;
  }

  /**
   * Roda o `/cycle` até PARAR (sempre para — nunca roda para sempre). `signal` é o
   * abort/freio reusado da EST-0948/0982 (parável — GS-L5). NÃO recebe `goal` novo a
   * cada ciclo: a MESMA `task` re-dispara o MESMO runner (que carrega a catraca/modo).
   */
  async run(task: string, signal: AbortSignal): Promise<CycleRunResult> {
    this.currentTask = task;
    this.paused = false;
    const startedAt = this.clock();
    const deadline = startedAt + this.ceilings.maxDurationMs;
    let cyclesRun = 0;
    let stalled = 0;
    let lastProgress: string | undefined;

    const stopWith = (stop: CycleStop): CycleRunResult => {
      this.observer?.onStop?.(stop);
      return {
        stop,
        cyclesRun,
        elapsedMs: this.clock() - startedAt,
        usage: this.budget.usage,
      };
    };

    for (;;) {
      // ── PORTÕES PRÉ-CICLO (paradas duras checadas ANTES de re-disparar) ──────

      // GS-L5/RES-L-2 — PARÁVEL: abortado ENTRE ciclos ⇒ para (cessar≠agir).
      if (signal.aborted) return stopWith({ kind: 'aborted' });

      // EST-1158 — PAUSA: enquanto pausado, ESPERA (ABORTÁVEL — Esc ainda para). Não
      // conta ciclo nem consome budget; o relógio de DURAÇÃO segue correndo (o teto
      // de duração no topo encerra na volta — pausar não burla o anti-runaway).
      while (this.paused && !signal.aborted) {
        await this.sleep(PAUSE_POLL_MS, signal);
      }
      if (signal.aborted) return stopWith({ kind: 'aborted' });

      // GS-L2 — TETO DE ITERAÇÕES (nº de ciclos). Falha-fechada.
      if (cyclesRun >= this.ceilings.maxIterations) {
        return stopWith({ kind: 'max-iterations', limit: this.ceilings.maxIterations });
      }

      // GS-L2 — TETO DE DURAÇÃO (relógio de parede). Para ANTES de iniciar um ciclo
      // que estouraria o relógio (não começa "só mais um").
      if (this.clock() >= deadline) {
        return stopWith({ kind: 'max-duration', limitMs: this.ceilings.maxDurationMs });
      }

      // GS-L2/E-A2 — BUDGET AGREGADO: se o contador ÚNICO (soma de TODOS os ciclos +
      // sub-agentes) JÁ estourou, NÃO inicia o próximo ciclo. PEEK não-consome (o
      // débito atômico ocorre dentro do loop de cada ciclo — aqui só observamos).
      const exceeded = this.budget.peekExceeded();
      if (exceeded) {
        return stopWith({ kind: 'budget', limit: exceeded });
      }

      // ── O CICLO: re-dispara o MESMO runner (loop completo pela catraca única) ──
      this.observer?.onCycleStart?.(cyclesRun);
      const outcome = await this.runner.runCycle({
        iteration: cyclesRun,
        task: this.currentTask, // EST-1158 — pode ter sido reconfigurada ao vivo
        signal,
      });
      cyclesRun += 1;
      this.observer?.onCycleEnd?.(cyclesRun - 1, outcome);

      // O ciclo pode ter sido abortado a meio (o runner respeita o signal). Se sim,
      // para limpo — sem efeito a meio (o loop interno cessa no abort, EST-0948).
      if (signal.aborted) return stopWith({ kind: 'aborted' });

      // GS-L4 — CONCLUSÃO: a tarefa terminou ⇒ para AO CONCLUIR (não espera o teto).
      if (outcome.done) return stopWith({ kind: 'completed' });

      // GS-L4/RES-L-3 — ANTI-LOOP-VAZIO: ciclo que não progrediu (mesmo marcador, ou
      // sem marcador) incrementa o contador de stall; progresso o ZERA. N stalls
      // consecutivos ⇒ para/pergunta (não gira à toa queimando budget). Vale para
      // auto-pacing que "decide repetir" sobre o mesmo estado.
      if (madeProgress(lastProgress, outcome.progress)) {
        stalled = 0;
        lastProgress = outcome.progress;
      } else {
        stalled += 1;
        if (stalled >= this.stallTolerance) {
          return stopWith({ kind: 'no-progress', stalledCycles: stalled });
        }
      }

      // ── ESPERA até o próximo ciclo (os DOIS RITMOS — GS-L8) — ABORTÁVEL (GS-L5) ──
      const delayMs =
        this.ceilings.rhythm === 'auto-pace'
          ? Math.max(0, outcome.nextDelayMs ?? 0)
          : this.ceilings.intervalMs;
      if (delayMs > 0) {
        // Não espera ALÉM do deadline: se o intervalo passaria do relógio, espera só
        // até o deadline (e o portão de duração no topo encerra na volta).
        const remaining = Math.max(0, deadline - this.clock());
        await this.sleep(Math.min(delayMs, remaining), signal);
      }
    }
  }

  /**
   * EST-1158 — RECONFIGURA o ciclo em execução. Vale na PRÓXIMA iteração (NÃO reinicia:
   * contadores e budget agregado ACUMULAM através da edição). Só os campos passados
   * mudam. CLI-SEC-14: o CAP de iterações NUNCA some — `maxIterations` exige inteiro
   * ≥ 1 (editar não é porta dos fundos do runaway). Lança em valor inválido.
   */
  reconfigure(patch: { task?: string; intervalMs?: number; maxIterations?: number }): void {
    if (patch.task !== undefined && patch.task.trim() !== '') {
      this.currentTask = patch.task;
    }
    if (patch.maxIterations !== undefined) {
      if (!Number.isInteger(patch.maxIterations) || patch.maxIterations < 1) {
        throw new Error(
          'reconfigure: max-iter deve ser inteiro ≥ 1 (o teto não pode sumir).',
        );
      }
      this.ceilings = { ...this.ceilings, maxIterations: patch.maxIterations };
    }
    if (patch.intervalMs !== undefined) {
      if (!Number.isFinite(patch.intervalMs) || patch.intervalMs < 0) {
        throw new Error('reconfigure: intervalo deve ser um número ≥ 0 ms.');
      }
      this.ceilings = { ...this.ceilings, intervalMs: patch.intervalMs };
    }
  }

  /** EST-1158 — PAUSA o loop entre ciclos (sem matar; Esc ainda para). */
  pause(): void {
    this.paused = true;
  }

  /** EST-1158 — RETOMA um loop pausado. */
  resume(): void {
    this.paused = false;
  }

  /** Está pausado? (p/ a TUI/status). */
  get isPaused(): boolean {
    return this.paused;
  }

  /** Config corrente (task + tetos vigentes) — p/ a TUI mostrar o que vale agora. */
  get currentConfig(): { task: string; maxIterations: number; intervalMs: number } {
    return {
      task: this.currentTask,
      maxIterations: this.ceilings.maxIterations,
      intervalMs: this.ceilings.intervalMs,
    };
  }
}

/**
 * PROGRESSO entre ciclos (GS-L4/RES-L-3): houve progresso sse há um marcador NOVO e
 * DIFERENTE do anterior. Sem marcador (undefined) ⇒ NÃO progrediu (conservador: a
 * ausência de sinal de progresso conta como loop-vazio, p/ não girar à toa).
 */
function madeProgress(prev: string | undefined, next: string | undefined): boolean {
  if (next === undefined) return false;
  return next !== prev;
}

/**
 * Sleep ABORTÁVEL default: resolve após `ms` OU quando o signal aborta (o que vier
 * primeiro). Limpa o timer no abort (não vaza). Parável por construção (GS-L5).
 */
const defaultAbortableSleep: AbortableSleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
