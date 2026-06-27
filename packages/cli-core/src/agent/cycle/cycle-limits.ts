// EST-0981 · ADR-0062 (APR-0067) · CLI-SEC-14 (GS-L2/L3/L8 · RES-L-1) —
// PARADAS DURAS de `/cycle` (autonomia REPETIDA) — o coração anti-runaway.
//
// `/cycle` re-dispara a MESMA sessão agêntica em ciclos SEM confirmação humana
// por-ciclo. O furo que esta peça fecha é o RUNAWAY DE AUTONOMIA (CLI-T5 elevado
// à enésima potência): um loop que se re-dispara sozinho queima tokens/dinheiro/
// recurso PARA SEMPRE se não for cercado. A disciplina do ADR-0062 §2:
//
//   • `/cycle` NUNCA roda para sempre. Termina SEMPRE por: teto de DURAÇÃO
//     (relógio de parede) + teto de ITERAÇÕES (nº de ciclos) + teto de BUDGET
//     AGREGADO (soma de TODOS os ciclos incl. sub-agentes — SharedBudget/E-A2)
//     + detecção de CONCLUSÃO (anti-loop-vazio).
//   • Sem NENHUM teto ⇒ `/cycle` NÃO INICIA (falha-fechada, inclusive auto-pacing
//     — auto-pacing sem teto = runaway puro). Esta é a regra que `resolveCycleCeilings`
//     codifica: ela RECUSA configurações sem teto, em vez de assumir "infinito".
//   • DEFAULTS CONSERVADORES CODIFICADOS: um intervalo sem duração-total recai num
//     default DURO de duração total; não dá para configurar infinito.
//   • Os tetos são ANTI-RUNAWAY, NÃO confirmação de efeito ⇒ NÃO-relaxáveis por
//     `--unsafe`/`--yolo`. `--unsafe` relaxa confirmação (categorias não-sempre-ask),
//     não o anti-runaway. Um loop `--unsafe` ainda PARA nos tetos (GS-L3).
//
// PORTÁVEL (ADR-0053 §8): só números + relógio injetável. Sem Ink, sem I/O.

import { DEFAULT_LIMITS, type SessionLimits } from '../limits.js';

/**
 * TETO-TETO DURO de duração total: o limite ACIMA do qual nem `--por` explícito do
 * usuário pode ir (ADR-0062 §5 — "não dá para configurar infinito"). Mesmo um
 * `/cycle --por 999h` é clampado aqui. Conservador por construção (2h).
 */
export const MAX_CYCLE_DURATION_MS = 2 * 60 * 60 * 1000;

/**
 * TETO-TETO DURO de iterações (nº de ciclos): o limite ACIMA do qual nem
 * `--max-iter` explícito pode ir. Conservador (200 ciclos).
 */
export const MAX_CYCLE_ITERATIONS = 200;

/**
 * DEFAULT DURO de duração total quando o usuário só deu INTERVALO (`/cycle 5m "…"`)
 * e nenhuma duração-total/iterações: um intervalo sem duração-total NÃO é "para
 * sempre" (ADR-0062 §2(a)/Q-L1) — recai neste default conservador (30min).
 */
export const DEFAULT_CYCLE_DURATION_MS = 30 * 60 * 1000;

/**
 * DEFAULT conservador de iterações (nº de ciclos) quando o usuário não deu
 * `--max-iter`. Espelha a postura conservadora de DEFAULT_LIMITS (CLI-SEC-8).
 */
export const DEFAULT_CYCLE_ITERATIONS = 20;

/**
 * DEFAULT do intervalo entre ciclos no ritmo FIXO quando a forma usada foi só
 * duração (`/cycle --por 30m "…"`) sem intervalo explícito: re-dispara assim que
 * o ciclo anterior termina, respeitando os tetos. `0` = sem espera fixa (back-to-back).
 */
export const DEFAULT_CYCLE_INTERVAL_MS = 0;

/**
 * Os DOIS RITMOS (ADR-0062 §0/GS-L8 — ⭐ Tiago, Q-L3). Ambos na v1, MESMOS TETOS:
 *  • `fixed`     — intervalo/duração explícitos (`/cycle 5m "…"`, `/cycle --por 1h "…"`).
 *  • `auto-pace` — o agente decide o ritmo entre ciclos (re-dispara quando achar).
 * Auto-pacing é o caso mais delicado (o modelo decide *quando* repetir) e continua
 * preso aos MESMOS tetos duros — sem teto ⇒ não inicia, inclusive em auto-pace.
 */
export type CycleRhythm = 'fixed' | 'auto-pace';

/**
 * Os tetos DUROS RESOLVIDOS de um `/cycle` — já validados (não-vazios) e clampados
 * aos teto-tetos. Construído SÓ por `resolveCycleCeilings`, que FALHA quando não há
 * nenhum teto (a regra "sem teto ⇒ não inicia"). Ter uma instância destes ⇒ os tetos
 * existem e são duros.
 */
export interface CycleCeilings {
  /** Duração total máx em ms (relógio de parede). SEMPRE presente e ≤ MAX_CYCLE_DURATION_MS. */
  readonly maxDurationMs: number;
  /** Nº máx de ciclos. SEMPRE presente e ≤ MAX_CYCLE_ITERATIONS. */
  readonly maxIterations: number;
  /** Budget AGREGADO (tokens) — soma de TODOS os ciclos + sub-agentes. SEMPRE presente. */
  readonly maxTokens: number;
  /** Intervalo entre ciclos no ritmo `fixed` (ms). Irrelevante em `auto-pace`. */
  readonly intervalMs: number;
  /** O ritmo escolhido (não muda os tetos — GS-L8). */
  readonly rhythm: CycleRhythm;
}

/** O que o usuário PEDIU (flags/sintaxe) — antes de resolver/validar/clampar. */
export interface CycleRequest {
  /** Intervalo entre ciclos em ms (ritmo fixo). `undefined` ⇒ não deu intervalo. */
  readonly intervalMs?: number;
  /** Duração total em ms (`--por`). `undefined` ⇒ não deu duração total. */
  readonly maxDurationMs?: number;
  /** Nº máx de ciclos (`--max-iter`). `undefined` ⇒ não deu. */
  readonly maxIterations?: number;
  /** Budget agregado de tokens (`--budget`). `undefined` ⇒ não deu. */
  readonly maxTokens?: number;
  /** Ritmo: `auto-pace` quando o usuário não fixou intervalo/duração e optou por auto. */
  readonly rhythm: CycleRhythm;
}

/**
 * Erro de "sem teto ⇒ não inicia" (ADR-0062 §2 / GS-L2 / RES-L-1). Falha-FECHADA:
 * NÃO assume default infinito — RECUSA iniciar. Distinto de erro de sintaxe.
 */
export class NoCeilingError extends Error {
  readonly code = 'NO_CEILING';
  constructor(message: string) {
    super(message);
    this.name = 'NoCeilingError';
  }
}

/**
 * RESOLVE os tetos DUROS de um `/cycle` a partir do que o usuário pediu — a porta
 * onde a regra "sem teto ⇒ não inicia" (GS-L2/RES-L-1) é codificada.
 *
 * INVARIANTES (gate FORTE — CLI-SEC-14):
 *  • Se o usuário não deu NENHUM teto temporal/iterações (nem duração, nem
 *    iterações, nem intervalo) ⇒ LANÇA `NoCeilingError`: `/cycle` NÃO inicia.
 *    Vale inclusive para `auto-pace` (auto-pace sem teto = runaway puro — GS-L8).
 *  • Um INTERVALO sem duração-total recai no `DEFAULT_CYCLE_DURATION_MS` (intervalo
 *    sozinho NÃO é "para sempre" — ADR-0062 §2(a)/Q-L1).
 *  • Os tetos do usuário são CLAMPADOS aos teto-tetos duros (não dá p/ configurar
 *    infinito — `--por 999h`/`--max-iter 99999` são clampados).
 *  • O budget agregado SEMPRE existe: o `--budget` explícito, ou o default
 *    conservador de tokens da sessão (DEFAULT_LIMITS.maxTokens). NUNCA undefined
 *    (auto-pacing multiplica volume — budget é obrigatório).
 *  • `--unsafe`/`--yolo` NÃO entram aqui: as paradas duras independem do modo.
 */
export function resolveCycleCeilings(req: CycleRequest): CycleCeilings {
  const hasDuration = isPositive(req.maxDurationMs);
  const hasIterations = isPositive(req.maxIterations);
  const hasInterval = isPositive(req.intervalMs);

  // GS-L2/RES-L-1 — SEM TETO ⇒ NÃO INICIA (falha-fechada). Um teto TEMPORAL/ITERAÇÕES
  // é obrigatório: nem duração, nem iterações, nem sequer um intervalo (que recairia
  // num default de duração) ⇒ recusa. Vale para auto-pace (GS-L8: sem teto ⇒ não inicia).
  if (!hasDuration && !hasIterations && !hasInterval) {
    throw new NoCeilingError(
      '/cycle exige pelo menos um teto (duração, iterações ou intervalo) — ' +
        'sem teto, NÃO inicia (proteção contra autonomia sem limite). ' +
        'Use ex.: `/cycle 5m "tarefa"`, `/cycle --por 30m "tarefa"` ou `--max-iter N`.',
    );
  }

  // DEFAULTS CONSERVADORES CODIFICADOS: um intervalo sem duração-total recai num
  // default DURO de duração total (intervalo sozinho ≠ infinito). Se nem intervalo
  // nem duração, mas há iterações, a duração cai no default também (cinto+suspensório).
  const maxDurationMs = clampPositive(
    hasDuration ? req.maxDurationMs! : DEFAULT_CYCLE_DURATION_MS,
    MAX_CYCLE_DURATION_MS,
  );
  const maxIterations = clampPositiveInt(
    hasIterations ? req.maxIterations! : DEFAULT_CYCLE_ITERATIONS,
    MAX_CYCLE_ITERATIONS,
  );
  // BUDGET AGREGADO sempre existe (obrigatório — ADR-0062 §2(c)). Default conservador
  // = o teto de tokens da sessão (CLI-SEC-8). Não-relaxável por --unsafe.
  const maxTokens = isPositive(req.maxTokens)
    ? req.maxTokens!
    : (DEFAULT_LIMITS.maxTokens ?? 200_000);

  const intervalMs =
    req.rhythm === 'fixed'
      ? hasInterval
        ? Math.max(0, req.intervalMs!)
        : DEFAULT_CYCLE_INTERVAL_MS
      : 0; // auto-pace não tem intervalo fixo.

  return { maxDurationMs, maxIterations, maxTokens, intervalMs, rhythm: req.rhythm };
}

/**
 * Constrói os `SessionLimits` do budget AGREGADO da sessão de `/cycle` a partir dos
 * tetos resolvidos. O teto de tokens vem dos ceilings (agregado, soma de todos os
 * ciclos + sub-agentes). Iterações/tool-calls do budget AGREGADO usam um teto
 * generoso *interno* ao SharedBudget (os tetos DUROS de ciclos/duração são do
 * CycleEngine; o que importa do SharedBudget aqui é o TOKEN agregado e a atomicidade).
 *
 * NOTA: o SharedBudget também conta iterações/tool-calls do loop INTERNO de cada
 * ciclo; deixamos esses tetos no default conservador da sessão (DEFAULT_LIMITS) —
 * eles complementam, não substituem, o teto de ITERAÇÕES-DE-CICLO do CycleEngine.
 */
export function aggregateLimitsOf(ceilings: CycleCeilings): SessionLimits {
  return {
    maxIterations: DEFAULT_LIMITS.maxIterations * Math.max(1, ceilings.maxIterations),
    maxToolCalls: DEFAULT_LIMITS.maxToolCalls * Math.max(1, ceilings.maxIterations),
    maxTokens: ceilings.maxTokens,
  };
}

function isPositive(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function clampPositive(n: number, max: number): number {
  return Math.min(Math.max(1, n), max);
}

function clampPositiveInt(n: number, max: number): number {
  return Math.min(Math.max(1, Math.floor(n)), max);
}
