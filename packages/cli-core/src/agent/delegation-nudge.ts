// DICA DE DELEGAÇÃO (ADR 0002 + medição do eval) — a regra de prompt sozinha não fez o modelo
// (glm) delegar: ele escrevia um plano de N passos independentes e os executava um a um.
// Este módulo é a parte PURA do empurrão no loop: detecta "plano com >= 3 passos independentes
// + o modelo começou a executar sozinho" e redige UMA dica curta.
//
// SEGURANÇA (CLI-SEC-4): o texto é AUTORADO POR NÓS e entra como `reanchor` (auto-lembrete do
// agente, canal `assistant`) — a MESMA via do self-check; nunca `user_inject` (não é o humano)
// nem `system`. Não amplia escopo: `spawn_agent` continua passando por `decide()` e cada filho
// passa pela catraca para tudo que faz. É só uma sugestão; o modelo pode ignorá-la.
//
// Limites: no máximo UMA dica por execução do loop (turno), só com >= 3 passos independentes
// (tarefa trivial nunca dispara) e desligável (`ALUY_DELEGATION_NUDGE=0`, resolvido fora).

import type { PlanStep } from './tools/plan.js';
import { PLAN_TOOL_NAME, normalizePlanInput } from './tools/plan.js';

/** Marcador estável do texto (asserções e UX). */
export const DELEGATION_NUDGE_MARKER = 'DICA — passos independentes no seu plano';

/** Mínimo de passos independentes para valer a dica. */
export const MIN_INDEPENDENT_STEPS = 3;

/** `true` se o env liga a dica (default LIGADA; `0/false/off/no` desliga). PURO. */
export function delegationNudgeEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Tokens que parecem caminho/arquivo (têm `/` ou extensão curta). */
const PATH_TOKEN_RE = /[\w.-]+\/[\w./-]+|[\w-]+\.[a-z]{1,5}\b/gi;

function pathTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const m of title.matchAll(PATH_TOKEN_RE)) out.add(m[0].toLowerCase());
  return out;
}

/**
 * Conta os passos ainda não concluídos que parecem INDEPENDENTES:
 *  - marcados `parallel`/`owner:'subagente'`; OU
 *  - com alvos (arquivos/áreas) próprios, sem nenhum alvo em comum com os outros passos.
 * Heurística conservadora: na dúvida, não conta. PURO.
 */
export function countIndependentSteps(steps: readonly PlanStep[]): number {
  const open = steps.filter((s) => s.status !== 'completed');
  const marked = open.filter((s) => s.parallel === true).length;
  const targets = open.map((s) => pathTokens(s.title));
  const freq = new Map<string, number>();
  for (const t of targets) for (const k of t) freq.set(k, (freq.get(k) ?? 0) + 1);
  const distinct = targets.filter((t) => t.size > 0 && [...t].every((k) => freq.get(k) === 1));
  return Math.max(marked, distinct.length);
}

/** O texto da dica. PURO. */
export function buildDelegationNudge(independent: number): string {
  return (
    `${DELEGATION_NUDGE_MARKER}: seu plano tem ${String(independent)} passos que não dependem ` +
    `uns dos outros e você começou a executá-los em série. Considere delegar: dispare um ` +
    `\`spawn_agent\` em segundo plano para cada passo independente (um objetivo claro e os ` +
    `arquivos de cada um), continue no que sobrar e junte os resultados quando voltarem. ` +
    `Se os passos na verdade são pequenos ou acoplados, siga sozinho — é só uma sugestão.`
  );
}

/** Tools que NÃO contam como "executar o plano" (meta, leitura, delegação). */
const NON_EXECUTING: ReadonlySet<string> = new Set([
  PLAN_TOOL_NAME,
  'spawn_agent',
  'agent_send',
  'agents_status',
  'agents_stop',
  'perguntar',
  'read_file',
  'grep',
  'glob',
  'change_dir',
  'capabilities',
]);

/**
 * Estado por execução do loop. `note()` é chamado a cada tool-call concluída; devolve o texto
 * da dica UMA vez (ou `undefined`).
 */
export class DelegationNudger {
  private independent = 0;
  private fired = false;
  private delegated = false;

  note(name: string, input: unknown, ok: boolean): string | undefined {
    if (this.fired) return undefined;
    if (name === 'spawn_agent') {
      this.delegated = true; // o modelo já delega: nada a sugerir.
      return undefined;
    }
    if (name === PLAN_TOOL_NAME) {
      if (!ok || typeof input !== 'object' || input === null) return undefined;
      const parsed = normalizePlanInput(input as Record<string, unknown>);
      this.independent = 'steps' in parsed ? countIndependentSteps(parsed.steps) : 0;
      return undefined;
    }
    if (this.delegated || this.independent < MIN_INDEPENDENT_STEPS) return undefined;
    if (NON_EXECUTING.has(name)) return undefined;
    this.fired = true;
    return buildDelegationNudge(this.independent);
  }
}
