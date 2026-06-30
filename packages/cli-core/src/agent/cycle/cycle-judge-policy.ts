// ADR-0137 (placeholder — confirmar nº livre em aluy-specs/01-arquitetura/) · Fatia 3 —
// POLÍTICA PURA de continuação de subciclo guiada pelo juiz (JudgeEngine).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ FRONTEIRA (ADR-0053 §8 · ADR-0137 §2): esta peça é KERNEL (código) — função  ║
// ║ PURA, provider-agnóstica. NÃO importa ollama, NÃO importa o JudgeEngine      ║
// ║ concreto, NÃO faz I/O. Recebe um `JudgeResult` JÁ CALCULADO (DADO) na borda  ║
// ║ (cli/wiring) e o traduz em `continue|stop`. O CycleEngine permanece PURO e   ║
// ║ IGNORANTE do juiz — ele só vê o `done` que a borda deriva desta política.    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// CLI-SEC-15-B: a saída do juiz é DADO envelopado, nunca instrução. Aqui o DADO
// vira uma DECISÃO de continuação — mas a EXTENSÃO de teto NUNCA acontece aqui
// (o juiz não toca os tetos): só o gate humano na borda estende (ADR-0137 §3).

import type { JudgeInput, JudgeOption, JudgeResult } from '../maestro/judge-engine.js';
import type { PlanBoxLike } from '../continuation.js';

// ─── Opções canônicas da pergunta de fronteira de subciclo ──────────────────

/** Id da opção "continuar" no JudgeInput de fronteira de subciclo. */
export const CYCLE_CONTINUE_OPTION_ID = 'continue';
/** Id da opção "parar" no JudgeInput de fronteira de subciclo. */
export const CYCLE_STOP_OPTION_ID = 'stop';

/** As duas opções fixas da pergunta de continuação (ADR-0137 §5). */
export const CYCLE_JUDGE_OPTIONS: readonly JudgeOption[] = Object.freeze([
  Object.freeze({
    id: CYCLE_CONTINUE_OPTION_ID,
    label: 'continuar este subciclo/ciclo (objetivo ainda não atingido)',
  }),
  Object.freeze({
    id: CYCLE_STOP_OPTION_ID,
    label: 'parar (o objetivo do subciclo foi atingido)',
  }),
]) as readonly JudgeOption[];

/** Pergunta fixa da fronteira de subciclo. */
export const CYCLE_JUDGE_QUESTION = 'Este subciclo/ciclo deve continuar?';

// ─── Construção do contexto REDIGIDO (C1) ───────────────────────────────────

/** Sinais (JÁ texto, ainda não redigidos) que resumem o estado do subciclo. */
export interface SubcycleSummaryInput {
  /** Objetivo/tarefa corrente do ciclo (texto cru — pode conter segredo). */
  readonly objective: string;
  /** Caixas do plano (ContextGraph) — rótulo + fechado? (rótulo é texto cru). */
  readonly boxes: readonly SubcycleBox[];
  /** Texto curto do último desfecho do ciclo (cru — pode conter segredo). */
  readonly lastOutcome?: string;
}

/** Forma mínima de caixa lida para o resumo: rótulo + fechado. */
export interface SubcycleBox extends PlanBoxLike {
  readonly label: string;
}

/**
 * Monta o RESUMO do subciclo (objetivo + caixas + último desfecho) e o REDIGE
 * com a função de redação INJETADA (CLI-SEC-6) ANTES de devolver. C1 do gate
 * `seguranca`: o texto que vira `JudgeInput.context` SAI desta função já redigido
 * — quem chama (a borda) NÃO precisa lembrar de redigir, e NÃO há caminho em que o
 * contexto cru chegue ao `fetch`. Diferente do precedente do Maestro (wiring.ts),
 * que faz `JSON.stringify` SEM redação — esta política é fail-safe por construção.
 *
 * @param input   sinais crus do estado do subciclo.
 * @param redact  a redação de CLI-SEC-6 (ex.: `redactOutputSecrets`). Aplicada a
 *                CADA campo textual antes de juntar — o resumo final é redigido.
 * @returns o resumo REDIGIDO, pronto p/ `JudgeInput.context`.
 */
export function buildRedactedSubcycleContext(
  input: SubcycleSummaryInput,
  redact: (text: string) => string,
): string {
  const lines: string[] = [];
  lines.push(`objetivo: ${redact(input.objective)}`);

  if (input.boxes.length > 0) {
    lines.push('subciclos (caixas do plano):');
    for (const box of input.boxes) {
      const mark = box.closed ? '[x]' : '[ ]';
      lines.push(`  ${mark} ${redact(box.label)}`);
    }
  }

  if (input.lastOutcome !== undefined && input.lastOutcome.trim() !== '') {
    lines.push(`último desfecho: ${redact(input.lastOutcome)}`);
  }

  // F-fail-safe: redige o AGREGADO de novo (idempotente). Um segredo partido entre
  // dois campos (improvável, mas conservador) é re-varrido no corpo final.
  return redact(lines.join('\n'));
}

/**
 * Monta o `JudgeInput` COMPLETO da fronteira de subciclo, com o `context` JÁ
 * REDIGIDO. Único ponto de construção do input do juiz do ciclo — garante que o
 * `context` que entra no juiz passou pela redação (C1). PURO: não chama o juiz.
 */
export function buildSubcycleJudgeInput(
  input: SubcycleSummaryInput,
  redact: (text: string) => string,
): JudgeInput {
  return {
    question: CYCLE_JUDGE_QUESTION,
    options: CYCLE_JUDGE_OPTIONS,
    context: buildRedactedSubcycleContext(input, redact),
    hint: 'Pare se o objetivo do subciclo foi atingido; continue só se há trabalho real restante.',
  };
}

// ─── Tradução do JudgeResult em continue/stop (autoridade de continuação) ────

/** A decisão de continuação derivada do JudgeResult (DADO → decisão). */
export interface CycleContinuation {
  /** `continue` ⇒ o juiz quer seguir; `stop` ⇒ o juiz quer parar. */
  readonly decision: 'continue' | 'stop';
  /** O motivo do juiz (cru, DADO não-confiável — a UI rotula/clampa). */
  readonly reason: string;
  /** Confiança do juiz (0..1). */
  readonly confidence: number;
  /**
   * `true` quando o juiz DEGRADOU (mode:'heuristic') — fail-open: a borda DEVE
   * ignorar a `decision` e cair no `done` DETERMINÍSTICO (ADR-0137 §4). Nunca
   * "continua pra sempre" na falta do juiz.
   */
  readonly degraded: boolean;
}

/**
 * Traduz o `JudgeResult` (DADO já calculado na borda) na decisão de continuação.
 *
 * - `mode:'heuristic'` ⇒ `degraded:true`: o juiz não respondeu de fato (ollama
 *   fora/timeout/parse inválido). A borda IGNORA a decisão e usa o `done`
 *   determinístico (fail-open p/ o lado seguro — §4). A `decision` reportada vira
 *   `stop` (nunca prolonga na degradação).
 * - `chosen === CYCLE_CONTINUE_OPTION_ID` ⇒ `continue`.
 * - qualquer outra escolha (incl. `stop` ou um id inesperado) ⇒ `stop` (fail-safe:
 *   na dúvida, PARA — só `continue` explícito prolonga).
 *
 * PURO: não toca tetos, não chama rede, não muta nada.
 */
export function judgeResultToContinuation(result: JudgeResult): CycleContinuation {
  const reason = result.reasons[0]?.rationale ?? '';
  if (result.mode === 'heuristic') {
    return { decision: 'stop', reason, confidence: result.confidence, degraded: true };
  }
  const decision = result.chosen === CYCLE_CONTINUE_OPTION_ID ? 'continue' : 'stop';
  return { decision, reason, confidence: result.confidence, degraded: false };
}

// ─── Clamp de 1 linha do motivo (C2 — anti-persuasão / não-vaza-da-tela) ─────

/**
 * Limite default de chars do motivo do juiz no gate do teto. Curto o bastante p/
 * `[c]`/`[n]` NUNCA saírem da tela (C2), mesmo num terminal estreito.
 */
export const DEFAULT_JUDGE_REASON_MAX_CHARS = 120;

/**
 * CLAMPA o motivo do juiz a UMA LINHA e a N chars (C2 do gate `seguranca`). O
 * motivo é DADO NÃO-CONFIÁVEL (prompt-injection pode tentar persuadir o humano a
 * apertar `c`): colapsa quebras de linha/whitespace num espaço e trunca, p/ que o
 * `reason` jamais empurre o prompt `[c]/[n]` p/ fora da tela nem injete um "texto
 * de sistema" multilinha. PURO, nunca lança. A UI ainda o rotula como dado.
 *
 * @param reason   o motivo cru do juiz.
 * @param maxChars limite de chars (default `DEFAULT_JUDGE_REASON_MAX_CHARS`).
 * @returns o motivo numa única linha, ≤ maxChars (com `…` se truncado).
 */
export function clampReasonToLine(
  reason: string,
  maxChars: number = DEFAULT_JUDGE_REASON_MAX_CHARS,
): string {
  // 1. Remove controles ASCII (0x00-0x1F, 0x7F DEL) p/ defesa contra escape-
  //    sequences/ANSI que mexeriam no cursor da TUI; \t\r\n caem no passo 2.
  // eslint-disable-next-line no-control-regex
  const noControl = reason.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  // 2. Colapsa QUALQUER whitespace restante (espaço, \t, \r, \n) num espaço — UMA linha.
  const oneLine = noControl.replace(/\s+/g, ' ').trim();
  const limit = Math.max(1, Math.floor(maxChars));
  if (oneLine.length <= limit) return oneLine;
  return oneLine.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}
