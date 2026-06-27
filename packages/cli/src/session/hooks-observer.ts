// EST-0974 · ADR-0053 §2.2 / CLI-SEC-3 — OBSERVADOR de HOOKS de ciclo-de-vida: o
// gancho ESTREITO entre o SessionController e o `HookRunner` (core). NÃO reescreve o
// controller — consome o stream de estado que ele JÁ publica (`controller.subscribe`)
// e dispara os hooks de `turn-end` quando a fase TRANSICIONA de ATIVIDADE p/ repouso
// (o agente terminou um turno).
//
// Por que um observador externo (e não dentro do controller): igual ao
// notify-observer (EST-0963) — o controller é a máquina de estado PORTÁVEL; o disparo
// de hooks é EFEITO de borda (execução de comando atrás da catraca). A fronteira fica
// limpa: o controller não sabe que hooks existem; o observador só LÊ as transições e
// delega ao `HookRunner`, que passa CADA comando pela MESMA `decide()` (não-bypass).
//
// O disparo é best-effort e NÃO bloqueia o stream: agenda o `runAll` (async) e segue.
// Em Plan, os hooks de efeito serão NEGADOS pela catraca dentro do runner (DENY) —
// este observador não precisa saber do modo; a catraca é a fronteira.

import type { SessionState } from './model.js';
import type { HookRunner, HooksConfig } from '@hiperplano/aluy-cli-core';
import { selectHooks } from '@hiperplano/aluy-cli-core';

/** Fases em que o turno está em ATIVIDADE. */
function isActivePhase(phase: SessionState['phase']): boolean {
  return phase === 'thinking' || phase === 'streaming' || phase === 'asking';
}

export interface HooksObserverOptions {
  /** O runner que executa cada hook ATRÁS da catraca (mesma `decide()` do agente). */
  readonly runner: HookRunner;
  /** A config de hooks lida de `~/.aluy/hooks.json` (DADO). */
  readonly config: HooksConfig;
}

/**
 * Liga o observador de `turn-end` ao controller. Devolve o `unsubscribe`. Dispara os
 * hooks de `turn-end` quando a fase vai de ATIVA → REPOUSO `done`/`budget` (o agente
 * acabou de trabalhar) — não em `idle`/`error` inicial nem em transições sem
 * atividade prévia (anti-ruído, espelha o notify-observer). Sem hooks de `turn-end`
 * na config ⇒ no-op (não assina nem dispara nada).
 */
export function attachHooksObserver(
  subscribe: (observer: (state: SessionState) => void) => () => void,
  opts: HooksObserverOptions,
): () => void {
  const turnEndHooks = selectHooks(opts.config, 'turn-end');
  // EST-0980 — `notification` (Claude: Notification): dispara quando o turno ENTRA em
  // `asking` (a catraca pediu aprovação e o agente espera o usuário — "precisa de
  // atenção"). MESMA base de fase do notify-observer; observe-only (atrás da catraca).
  const notificationHooks = selectHooks(opts.config, 'notification');
  if (turnEndHooks.length === 0 && notificationHooks.length === 0) {
    return () => {}; // nada a observar.
  }

  let prevPhase: SessionState['phase'] | null = null;
  const onState = (state: SessionState): void => {
    const phase = state.phase;
    if (prevPhase === null) {
      prevPhase = phase;
      return; // 1º estado: só registra a base, sem disparar.
    }
    if (phase === prevPhase) return;
    // ATIVA → done/budget ⇒ o turno terminou: dispara os hooks de turn-end. Cada um
    // passa pela catraca dentro do runner (Plan ⇒ DENY; sempre-ask ⇒ ask).
    if (
      turnEndHooks.length > 0 &&
      (phase === 'done' || phase === 'budget') &&
      isActivePhase(prevPhase)
    ) {
      void opts.runner.runAll(turnEndHooks);
    }
    // → asking ⇒ NOTIFICAÇÃO (precisa de atenção do usuário). Borda (não nível).
    if (notificationHooks.length > 0 && phase === 'asking' && prevPhase !== 'asking') {
      void opts.runner.runAll(notificationHooks);
    }
    prevPhase = phase;
  };
  return subscribe(onState);
}
