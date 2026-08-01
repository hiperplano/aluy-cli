// ADR-0158 §5 pt.4/§8.1/§8.2 — `runOneWorkflow` decide o `startOffset` de uma
// RETOMADA (`resolveResumeSlice`) e monta o `WorkflowOutcome` final a partir do
// `WorkflowRunResult` do `runWorkflow` (`buildWorkflowOutcome`) — as duas PURAS,
// extraídas de dentro de `runOneWorkflow` p/ serem testáveis sem rodar um
// workflow/turno de verdade (mesmo racional de `buildActivityGoal`/`buildActivityEnv`
// em `runner-activity-goal.test.ts`).
import { describe, expect, it } from 'vitest';
import { resolveResumeSlice, buildWorkflowOutcome } from '../../src/service/runner.js';
import type { WorkflowRunResult } from '@hiperplano/aluy-cli-core';

describe('resolveResumeSlice — PURA (ADR-0158 §5 pt.4)', () => {
  it('resumeActivityIndex undefined (turno normal, não é retomada) ⇒ ok, startOffset 0', () => {
    expect(resolveResumeSlice(5, undefined)).toEqual({ ok: true, startOffset: 0 });
  });

  it('resumeActivityIndex dentro do range ⇒ ok, startOffset = o índice pedido', () => {
    expect(resolveResumeSlice(5, 2)).toEqual({ ok: true, startOffset: 2 });
  });

  it('resumeActivityIndex == última atividade válida (total-1) ⇒ ok (fronteira)', () => {
    expect(resolveResumeSlice(5, 4)).toEqual({ ok: true, startOffset: 4 });
  });

  it('resumeActivityIndex == total (fronteira exata, 1 além do último válido) ⇒ NÃO ok', () => {
    expect(resolveResumeSlice(5, 5)).toEqual({ ok: false, startOffset: 5 });
  });

  it('resumeActivityIndex > total ⇒ NÃO ok (workflow encolheu bem mais que 1 atividade)', () => {
    expect(resolveResumeSlice(5, 99)).toEqual({ ok: false, startOffset: 99 });
  });

  it('workflow com 1 atividade só, resumeActivityIndex 0 ⇒ ok (único índice válido)', () => {
    expect(resolveResumeSlice(1, 0)).toEqual({ ok: true, startOffset: 0 });
  });

  it('resumeActivityIndex 0 explícito (retomando a 1ª atividade) ⇒ ok, startOffset 0', () => {
    expect(resolveResumeSlice(3, 0)).toEqual({ ok: true, startOffset: 0 });
  });
});

function runResult(overrides: Partial<WorkflowRunResult> = {}): WorkflowRunResult {
  return { activitiesRun: 1, stopped: false, ...overrides };
}

describe('buildWorkflowOutcome — PURA (ADR-0158 §5 pt.4/§8.1/§8.2)', () => {
  it('res.lastStop === "awaiting-owner" ⇒ kind "awaiting-owner", usa pendingQuestionText/pendingActivityIndex', () => {
    const outcome = buildWorkflowOutcome({
      res: runResult({ stopped: true, lastStop: 'awaiting-owner', activitiesRun: 2 }),
      startOffset: 0,
      totalActivities: 5,
      pendingQuestionText: 'Aumento a posição?',
      pendingActivityIndex: 1,
    });
    expect(outcome).toEqual({ kind: 'awaiting-owner', question: 'Aumento a posição?', activityIndex: 1 });
  });

  it('awaiting-owner TEM PRIORIDADE sobre "stopped" mesmo quando ambos são verdadeiros', () => {
    const outcome = buildWorkflowOutcome({
      res: runResult({ stopped: true, lastStop: 'awaiting-owner' }),
      startOffset: 0,
      totalActivities: 3,
      pendingQuestionText: 'x',
      pendingActivityIndex: 0,
    });
    expect(outcome.kind).toBe('awaiting-owner');
  });

  it('awaiting-owner: pendingQuestionText undefined ⇒ cai no placeholder "(ver runner.log)"', () => {
    const outcome = buildWorkflowOutcome({
      res: runResult({ stopped: true, lastStop: 'awaiting-owner' }),
      startOffset: 0,
      totalActivities: 3,
      pendingQuestionText: undefined,
      pendingActivityIndex: 0,
    });
    expect(outcome).toMatchObject({ kind: 'awaiting-owner', question: '(ver runner.log)' });
  });

  it('awaiting-owner: pendingActivityIndex undefined ⇒ cai pro startOffset', () => {
    const outcome = buildWorkflowOutcome({
      res: runResult({ stopped: true, lastStop: 'awaiting-owner' }),
      startOffset: 7,
      totalActivities: 10,
      pendingQuestionText: 'q',
      pendingActivityIndex: undefined,
    });
    expect(outcome).toMatchObject({ activityIndex: 7 });
  });

  it('res.stopped:true, lastStop:"error" ⇒ kind "stopped", critical:true, resumo com contagem+motivo', () => {
    const outcome = buildWorkflowOutcome({
      res: runResult({ stopped: true, lastStop: 'error', activitiesRun: 2 }),
      startOffset: 0,
      totalActivities: 5,
      pendingQuestionText: undefined,
      pendingActivityIndex: undefined,
    });
    expect(outcome).toEqual({
      kind: 'stopped',
      critical: true,
      summary: 'parou em 2/5 atividades (error).',
    });
  });

  it('res.stopped:true, lastStop:"limit"/"cancelled"/"final" ⇒ critical:false (parada NEUTRA)', () => {
    for (const lastStop of ['limit', 'cancelled', 'final'] as const) {
      const outcome = buildWorkflowOutcome({
        res: runResult({ stopped: true, lastStop, activitiesRun: 1 }),
        startOffset: 0,
        totalActivities: 3,
        pendingQuestionText: undefined,
        pendingActivityIndex: undefined,
      });
      expect(outcome).toMatchObject({ kind: 'stopped', critical: false });
    }
  });

  it('res.stopped:true, lastStop:undefined ⇒ critical:false, summary usa "motivo desconhecido"', () => {
    const outcome = buildWorkflowOutcome({
      res: runResult({ stopped: true, lastStop: undefined, activitiesRun: 1 }),
      startOffset: 0,
      totalActivities: 4,
      pendingQuestionText: undefined,
      pendingActivityIndex: undefined,
    });
    expect(outcome).toEqual({
      kind: 'stopped',
      critical: false,
      summary: 'parou em 1/4 atividades (motivo desconhecido).',
    });
  });

  it('startOffset soma com activitiesRun no resumo (retomada parcial — não conta as anteriores 2x)', () => {
    const outcome = buildWorkflowOutcome({
      res: runResult({ stopped: true, lastStop: 'error', activitiesRun: 1 }),
      startOffset: 3,
      totalActivities: 5,
      pendingQuestionText: undefined,
      pendingActivityIndex: undefined,
    });
    expect(outcome).toMatchObject({ summary: 'parou em 4/5 atividades (error).' });
  });

  it('res.stopped:false ⇒ kind "ok", resumo "N/total atividades concluídas."', () => {
    const outcome = buildWorkflowOutcome({
      res: runResult({ stopped: false, activitiesRun: 3 }),
      startOffset: 0,
      totalActivities: 3,
      pendingQuestionText: undefined,
      pendingActivityIndex: undefined,
    });
    expect(outcome).toEqual({ kind: 'ok', summary: '3/3 atividades concluídas.' });
  });

  it('res.stopped:false com startOffset > 0 (turno todo concluído após retomada parcial)', () => {
    const outcome = buildWorkflowOutcome({
      res: runResult({ stopped: false, activitiesRun: 2 }),
      startOffset: 3,
      totalActivities: 5,
      pendingQuestionText: undefined,
      pendingActivityIndex: undefined,
    });
    expect(outcome).toEqual({ kind: 'ok', summary: '5/5 atividades concluídas.' });
  });
});
