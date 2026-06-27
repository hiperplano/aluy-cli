// EST-1123 · ADR-0123 §7 Q-MA1 + §6.1 CA-MA5 · MAESTRO-REGENTE —
// O regente: ponto único de decisão de turno com precedência canônica.
//
// Dado os sinais coletados pelo barramento (EST-1122), o regente aplica a
// precedência RATIFICADA Q-MA1 e emite UMA SupervisorDecision por turno.
//
// Fail-safe CA-MA5: na dúvida (zero sinais, ambiguidade irresolvível),
// a decisão padrão é 'continuar' (segura, não-destrutiva).
//
// INVARIANTES:
//   CA-REG-1 — exatamente 1 decisão por chamada
//   CA-REG-2 — precedência Q-MA1: human-cancel > mem-pressure > budget >
//              degeneração > stuck > weak-yolo > self-check
//   CA-REG-3 — determinismo: mesma entrada ⇒ mesma saída
//
// PORTÁVEL (ADR-0053 §8): SEM Ink, SEM I/O de terminal. Função pura.
// SÓ lógica de regência — NÃO os emissores (EST-1124), NÃO o motor (EST-1127).

import type { DecisionAction, SupervisorDecision, SupervisorSignal } from './contract.js';
import { createDecision, createSignal } from './contract.js';

// ─── Precedência Q-MA1 (ADR-0123 §7) ─────────────────────────────────────────
//
// Ordem canônica: menor índice = maior prioridade.
// human-cancel é o TOPO ABSOLUTO (Q-MA1 ratificada pelo dono).
// self-check é o mais fraco — sinal de "tudo normal".
//
// Se novas origens surgirem, recebem índice 99 (após self-check) até
// que a precedência seja explicitamente definida (fail-safe).

const PRECEDENCE: Record<string, number> = {
  'human-cancel': 0,
  'mem-pressure': 1,
  budget: 2,
  degeneration: 3,
  stuck: 4,
  'weak-yolo': 5,
  'self-check': 6,
};

/** Prioridade de uma origem (menor = mais prioritário). Fallback: 99. */
function priority(origin: string): number {
  return PRECEDENCE[origin] ?? 99;
}

// ─── Resolução de ação por origem + severidade ────────────────────────────────
//
// Cada origem tem uma semântica de severidade diferente. A tabela abaixo
// define a AÇÃO resultante para o sinal de MAIOR precedência do turno.
//
// Fail-safe CA-MA5 embutido: qualquer combinação não mapeada cai em 'continuar'.

function resolveAction(origin: string, severity: string): DecisionAction {
  switch (origin) {
    // ── Q-MA1 topo: cancelamento humano ──────────────────────────────────
    case 'human-cancel':
      // Qualquer severidade de cancelamento humano PARA o loop.
      // (critical = ctrl-c, warning/info = pedido de pausa pelo usuário)
      return 'parar';

    // ── Pressão de memória ───────────────────────────────────────────────
    case 'mem-pressure':
      if (severity === 'critical') return 'recuperar'; // compactar já
      if (severity === 'warning') return 'recuperar'; // antecipar compactação
      return 'continuar'; // info: monitorando

    // ── Orçamento (tokens/custo) ─────────────────────────────────────────
    case 'budget':
      if (severity === 'critical') return 'pausar'; // sem budget → pausa
      if (severity === 'warning') return 'continuar'; // alerta, mas segue
      return 'continuar';

    // ── Degeneração de resposta ──────────────────────────────────────────
    case 'degeneration':
      if (severity === 'critical') return 'recuperar'; // loop degenerativo grave
      if (severity === 'warning') return 'recuperar'; // sinais de repetição
      return 'continuar';

    // ── Loop travado (stuck) ─────────────────────────────────────────────
    case 'stuck':
      if (severity === 'critical') return 'recuperar'; // travado há muitos turnos
      if (severity === 'warning') return 'pausar'; // potencial travamento
      return 'continuar';

    // ── Weak-yolo (combo yolo + tier-fraco + dado não-confiável) ─────────
    case 'weak-yolo':
      if (severity === 'critical') return 'parar'; // yolo perigoso → parar
      // F62 — warning NÃO pausa. O veredito de segurança AG-0008
      // (weak-yolo-guardrail.ts §15-23) é EXPLÍCITO: "NÃO forçar tier, NÃO
      // bloquear, NÃO promptar — um prompt penduraria o headless". A resposta
      // ao combo já é dada no loop (WARN one-shot no stderr + reforço `reanchor`),
      // independente do Maestro. Mapear warning→pausar CONTRADIZIA esse veredito e
      // causava o F62: como o mem0-recall (e qualquer `@anexo`) injeta um
      // `observation` (DADO não-confiável) JÁ na 1ª iteração, sob YOLO+tier-fraco
      // o Maestro pausava ANTES do agente agir, toda tarefa. O regente segue.
      return 'continuar';

    // ── Self-check (tudo normal) ────────────────────────────────────────
    case 'self-check':
    default:
      return 'continuar';
  }
}

// ─── Construção de razão auditável (CLI-SEC-10) ──────────────────────────────

function buildReason(
  topSignal: SupervisorSignal,
  allSignals: readonly SupervisorSignal[],
  action: DecisionAction,
): string {
  const { origin, severity } = topSignal;
  const total = allSignals.length;

  if (total === 1) {
    return `Sinal único: ${origin} (${severity}) → ${action}`;
  }

  // Lista as origens dos sinais para rastreabilidade completa
  const origins = allSignals.map((s) => s.origin).join(', ');
  return `${total} sinais [${origins}] — topo ${origin} (${severity}) → ${action}`;
}

// ─── Regente — ponto único de decisão de turno ───────────────────────────────

/**
 * Decide a ação de regência do turno a partir dos sinais coletados.
 *
 * Aplica a precedência canônica Q-MA1 (ADR-0123 §7):
 * **human-cancel > mem-pressure > budget > degeneração > stuck >
 * weak-yolo > self-check**.
 *
 * Fail-safe CA-MA5: se `signals` for vazio, emite `continuar` com um
 * sinal `self-check` sintético — decisão segura e não-destrutiva.
 *
 * Determinístico (CA-REG-3): mesma entrada de sinais + mesmo `ts` ⇒
 * mesma `SupervisorDecision`.
 *
 * @param signals - Sinais coletados pelo barramento neste turno.
 * @param ts - Timestamp da decisão (ms epoch). Se omitido, usa `Date.now()`.
 * @returns Exatamente UMA `SupervisorDecision`.
 */
export function regentDecide(
  signals: readonly SupervisorSignal[],
  ts?: number,
): SupervisorDecision {
  const now = ts ?? Date.now();

  // ── CA-MA5: fail-safe — zero sinais → continuar ───────────────────────
  if (signals.length === 0) {
    const safeSig = createSignal('self-check', 'info', now, {
      reason: 'fail-safe: nenhum sinal no turno',
    });
    return createDecision(
      'continuar',
      [safeSig],
      'Fail-safe CA-MA5: nenhum sinal no turno — continuando',
      now,
    );
  }

  // ── Ordena por precedência Q-MA1 (menor índice = maior prioridade) ────
  //
  // Spread + sort é determinístico para arrays de mesmo conteúdo porque
  // o critério de desempate é estável (mantém ordem relativa de sinais
  // com mesma precedência — não afeta o resultado já que o topo é único).
  const sorted = [...signals].sort((a, b) => priority(a.origin) - priority(b.origin));

  const topSignal = sorted[0];
  const action = resolveAction(topSignal.origin, topSignal.severity);
  const reason = buildReason(topSignal, signals, action);

  return createDecision(action, signals, reason, now);
}
