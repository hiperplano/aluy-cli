// EST-1106 · ADR-workflows — MOTOR DO /workflows run (FATIA 2).
// Roda CADA atividade do workflow EM ORDEM, via um `WorkflowActivityRunner`
// injetado (o locus concreto @hiperplano/aluy-cli executa o turno pela MESMA catraca).
// PARA na 1ª que falhar/for cancelada/limite (não segue cega).
//
// PORTÁVEL (ADR-0053 §8): orquestração PURA (sem I/O, sem Ink, sem modelo).
// O efeito de turno é do runner injetado.

import type { WorkflowActivity } from './workflow-parse.js';

/**
 * PORTA de execução de UMA atividade. O locus concreto (@hiperplano/aluy-cli) injeta o
 * turno agêntico real (pela MESMA catraca `decide()`). O workflow-runner é
 * um ORQUESTRADOR que chama esta porta uma vez por atividade.
 */
export interface WorkflowActivityRunner {
  runActivity(args: {
    /** Índice 0-based da atividade na lista. */
    readonly index: number;
    /** Total de atividades no workflow. */
    readonly total: number;
    /** id da atividade (slug curto). */
    readonly id: string;
    /** Objetivo da atividade (vira o `goal` do turno). */
    readonly goal: string;
    /** AbortSignal da raiz (parável entre atividades). */
    readonly signal: AbortSignal;
  }): Promise<WorkflowActivityOutcome>;
}

/** Desfecho de UMA atividade, devolvido pelo runner. */
export interface WorkflowActivityOutcome {
  /** `true` se a atividade concluiu com sucesso. */
  readonly ok: boolean;
  /**
   * Se `ok === false`, por que parou. `'error'` = erro no turno, `'cancelled'` =
   * abortado pelo usuário, `'limit'` = teto/budget estourado. `'final'` = o
   * agente declarou conclusão ANTES do fim do workflow (ex.: tarefa já resolvida).
   * `undefined` com `ok === true` = atividade normal concluída.
   */
  readonly stop?: 'final' | 'error' | 'cancelled' | 'limit';
}

/** Resultado FINAL do `runWorkflow`. */
export interface WorkflowRunResult {
  /** Quantas atividades foram executadas (≥1, ≤ total). */
  readonly activitiesRun: number;
  /** O workflow PAROU? (teve falha/abort/limite/conclusão precoce). */
  readonly stopped: boolean;
  /** Se `stopped`, o MOTIVO da parada. */
  readonly lastStop?: WorkflowActivityOutcome['stop'];
}

/**
 * Roda as atividades do workflow EM ORDEM, via `runner.runActivity`.
 * PARA na 1ª que falhar/for cancelada/limite — não segue cega.
 * PARÁVEL: respeita `signal.aborted` ENTRE atividades (não inicia a próxima
 * se abortado). PURO (sem I/O, sem modelo).
 */
export async function runWorkflow(
  activities: readonly WorkflowActivity[],
  runner: WorkflowActivityRunner,
  signal: AbortSignal,
): Promise<WorkflowRunResult> {
  const total = activities.length;
  for (let i = 0; i < total; i++) {
    // PARÁVEL: abortado ENTRE atividades ⇒ para.
    if (signal.aborted) {
      return { activitiesRun: i, stopped: true, lastStop: 'cancelled' };
    }

    const activity = activities[i]!;
    const outcome = await runner.runActivity({
      index: i,
      total,
      id: activity.id,
      goal: activity.goal,
      signal,
    });

    if (!outcome.ok) {
      return {
        activitiesRun: i + 1,
        stopped: true,
        lastStop: outcome.stop ?? 'error',
      };
    }

    // Atividade concluiu: segue p/ a próxima (se houver).
  }

  return { activitiesRun: total, stopped: false };
}
