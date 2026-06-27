// EST-1018 (BUG-0021) · ADR-0053 §2.2 / CLI-SEC-3 — OBSERVADOR de HOOKS de TOOL: o
// gancho ESTREITO entre o ciclo-de-vida de tool do loop (via `controller.addToolObserver`)
// e o `HookRunner` (core). É o irmão do `attachHooksObserver` (`turn-end`): consome os
// sinais que o loop JÁ emite (`onToolStart`/`onToolEnd`, ambos ATRÁS da catraca —
// CLI-SEC-H1) e dispara os hooks `pre-tool` (ANTES da tool rodar) e `post-tool` (DEPOIS),
// SEM tocar a catraca/budget (observação pura).
//
// Por que um observador externo (e não dentro do controller): igual ao notify-observer e
// ao hooks-observer de turn-end — o controller é a máquina de estado; o disparo de hooks é
// EFEITO de borda (comando atrás da catraca). A fronteira fica limpa: o controller só
// expõe `addToolObserver`; quem sabe de hooks é este módulo.
//
// O disparo é best-effort e NÃO bloqueia o loop: agenda o `runAll` (async) e segue (cada
// comando do hook RE-PASSA a MESMA `decide()` dentro do runner — em Plan/não-interativo é
// NEGADO; nunca relaxa nada). Espelha o `void runner.runAll(...)` do turn-end.

import type { HookRunner, HooksConfig, ToolCall, ToolLifecycleObserver } from '@hiperplano/aluy-cli-core';
import { selectHooks } from '@hiperplano/aluy-cli-core';

export interface ToolHooksObserverOptions {
  /** O runner que executa cada hook ATRÁS da catraca (mesma `decide()` do agente). */
  readonly runner: HookRunner;
  /** A config de hooks lida de `~/.aluy/hooks.json` (DADO). */
  readonly config: HooksConfig;
}

/**
 * Constrói o `ToolLifecycleObserver` que dispara `pre-tool` (no `onToolStart`) e
 * `post-tool` (no `onToolEnd`) via o `HookRunner`, casando o NOME da tool (matcher
 * opcional dos hooks — `selectHooks(..., call.name)`). Best-effort: `void runner.runAll`
 * (não bloqueia o loop). Sem hooks de pre/post-tool na config ⇒ devolve `undefined`
 * (no-op: o chamador NÃO registra observador algum — zero overhead).
 *
 * Acoplado ao controller via `controller.addToolObserver(obs)` (que devolve o detach).
 */
export function makeToolHooksObserver(
  opts: ToolHooksObserverOptions,
): ToolLifecycleObserver | undefined {
  const hasPre = selectHooks(opts.config, 'pre-tool').length > 0;
  const hasPost = selectHooks(opts.config, 'post-tool').length > 0;
  if (!hasPre && !hasPost) return undefined; // nada a observar.

  const observer: ToolLifecycleObserver = {};
  if (hasPre) {
    observer.onToolStart = (call: ToolCall): void => {
      const hooks = selectHooks(opts.config, 'pre-tool', call.name);
      if (hooks.length > 0) void opts.runner.runAll(hooks);
    };
  }
  if (hasPost) {
    observer.onToolEnd = (call: ToolCall): void => {
      const hooks = selectHooks(opts.config, 'post-tool', call.name);
      if (hooks.length > 0) void opts.runner.runAll(hooks);
    };
  }
  return observer;
}
