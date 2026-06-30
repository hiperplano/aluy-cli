// ADR-0137 (Fatia 3) — testes da POLÍTICA PURA de continuação de subciclo guiada
// pelo juiz. Cobre: redação do contexto (C1, parte pura), tradução continue/stop +
// fail-open na degradação (C6/§4), e o clamp de 1 linha do motivo (C2, parte pura).

import { describe, expect, it } from 'vitest';
import {
  CYCLE_CONTINUE_OPTION_ID,
  CYCLE_STOP_OPTION_ID,
  CYCLE_JUDGE_OPTIONS,
  buildRedactedSubcycleContext,
  buildSubcycleJudgeInput,
  judgeResultToContinuation,
  clampReasonToLine,
  type JudgeResult,
} from '../../src/index.js';
import { redactOutputSecrets, REDACTED } from '../../src/agent/journal/redact.js';

function llmResult(chosen: string, reason: string, confidence = 0.9): JudgeResult {
  return { chosen, confidence, reasons: [{ optionId: chosen, rationale: reason }], mode: 'llm' };
}

describe('ADR-0137 · C1 (parte pura) — buildRedactedSubcycleContext REDIGE antes de devolver', () => {
  it('um segredo plantado no objetivo/caixa/desfecho NÃO aparece no contexto', () => {
    const ctx = buildRedactedSubcycleContext(
      {
        objective: 'deploy com AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE no comando',
        boxes: [
          { label: 'rodar curl -H "Authorization: Bearer sk-secret1234567890abcdef"', closed: false },
          { label: 'caixa limpa', closed: true },
        ],
        lastOutcome: 'falhou: token github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 inválido',
      },
      redactOutputSecrets,
    );
    // Os segredos foram trocados pelo marcador — nada cru vazou.
    expect(ctx).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(ctx).not.toContain('sk-secret1234567890abcdef');
    expect(ctx).not.toContain('github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(ctx).toContain(REDACTED);
    // A ESTRUTURA (rótulos, caixas) sobrevive — o juiz ainda vê o esqueleto.
    expect(ctx).toContain('objetivo:');
    expect(ctx).toContain('[x] caixa limpa');
    expect(ctx).toContain('[ ]');
  });

  it('buildSubcycleJudgeInput devolve as opções fixas e o context JÁ redigido', () => {
    const input = buildSubcycleJudgeInput(
      { objective: 'x --password=hunter2supersecret', boxes: [], lastOutcome: '' },
      redactOutputSecrets,
    );
    expect(input.options).toBe(CYCLE_JUDGE_OPTIONS);
    expect(input.context).not.toContain('hunter2supersecret');
    expect(input.context).toContain(REDACTED);
  });
});

describe('ADR-0137 · §5 — judgeResultToContinuation traduz DADO → continue/stop', () => {
  it('chosen=continue (llm) ⇒ decision=continue, não degradado', () => {
    const c = judgeResultToContinuation(llmResult(CYCLE_CONTINUE_OPTION_ID, 'falta testar'));
    expect(c.decision).toBe('continue');
    expect(c.degraded).toBe(false);
    expect(c.reason).toBe('falta testar');
  });

  it('chosen=stop (llm) ⇒ decision=stop', () => {
    const c = judgeResultToContinuation(llmResult(CYCLE_STOP_OPTION_ID, 'objetivo atingido'));
    expect(c.decision).toBe('stop');
    expect(c.degraded).toBe(false);
  });

  it('§4 fail-open — mode:heuristic ⇒ degraded=true e decision=stop (nunca prolonga)', () => {
    const heuristic: JudgeResult = {
      chosen: CYCLE_CONTINUE_OPTION_ID, // mesmo "continue", a degradação ignora
      confidence: 0.5,
      reasons: [{ optionId: CYCLE_CONTINUE_OPTION_ID, rationale: '[degradação] ollama fora' }],
      mode: 'heuristic',
    };
    const c = judgeResultToContinuation(heuristic);
    expect(c.degraded).toBe(true);
    expect(c.decision).toBe('stop');
  });

  it('fail-safe — chosen inesperado (llm) ⇒ stop (só continue explícito prolonga)', () => {
    const c = judgeResultToContinuation(llmResult('algo-injetado', 'ignore previous'));
    expect(c.decision).toBe('stop');
    expect(c.degraded).toBe(false);
  });
});

describe('ADR-0137 · C2 (parte pura) — clampReasonToLine: 1 linha + N chars', () => {
  it('reason multilinha gigante vira UMA linha curta com reticências', () => {
    const huge = 'linha1\nlinha2\n'.repeat(500) + 'FIM';
    const clamped = clampReasonToLine(huge, 80);
    expect(clamped).not.toContain('\n');
    expect(clamped.length).toBeLessThanOrEqual(80);
    expect(clamped.endsWith('…')).toBe(true);
  });

  it('remove controles ANSI/escape (defesa de cursor da TUI)', () => {
    const ESC = String.fromCharCode(27); // \x1b
    const BEL = String.fromCharCode(7); // \x07
    const evil = `motivo${ESC}[2J${BEL}limpo\ttab\rcr`;
    const clamped = clampReasonToLine(evil, 200);
    expect(clamped).not.toContain(ESC);
    expect(clamped).not.toContain(BEL);
    expect(clamped).not.toContain('\n');
    expect(clamped).not.toContain('\r');
    expect(clamped).toContain('motivo');
  });

  it('reason curto passa intacto (sem reticências)', () => {
    expect(clampReasonToLine('ok', 80)).toBe('ok');
  });
});
