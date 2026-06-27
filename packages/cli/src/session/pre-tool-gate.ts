// EST-0980 · ADR-0053 §2.2 / CLI-SEC-3/H1 — fábrica do GATE de PRE-TOOL (hooks que
// podem VETAR uma tool). É o gancho ESTREITO entre o `HookRunner` (core) e a `PreToolGate`
// que o `AgentLoop` consulta no ramo `allow` da catraca (DEPOIS de `decide()`, ANTES de
// rodar a tool). NÃO há segundo motor: cada hook de gate atravessa a MESMA `decide()`
// dentro do `runGate` (Plan ⇒ DENY; sempre-ask ⇒ ask). O gate só pode SOMAR um veto.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ INVARIANTE (gate `seguranca` — composição MONOTÔNICA):                      ║
// ║  • `executa(tool) = decide()==allow  AND  nenhum hook de gate vetou`.        ║
// ║    O loop SÓ chama esta porta no ramo `allow` — então um hook NUNCA "salva"   ║
// ║    o que a catraca negou (CLI-SEC-3 não-relaxável).                          ║
// ║  • o ÚNICO resultado possível é "veta" ou "não veta" — JAMAIS "aprova".       ║
// ║  • um hook de gate que a catraca BLOQUEOU (não rodou) NÃO veta (fail-safe ≠   ║
// ║    fail-open: a tool já passou pela `decide()`; o veto é poder EXTRA).        ║
// ║  • o motivo do veto volta como DADO não-confiável (CLI-SEC-4) ao loop.        ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import type { HookRunner, HooksConfig, PreToolGate, ToolCall } from '@aluy/cli-core';
import { selectGateHooks } from '@aluy/cli-core';

export interface PreToolGateOptions {
  /** O runner que roda cada hook ATRÁS da catraca (mesma `decide()` do agente). */
  readonly runner: HookRunner;
  /** A config de hooks lida de `~/.aluy/hooks.json` (+ settings do Claude, EST-0980). */
  readonly config: HooksConfig;
}

/**
 * Constrói a `PreToolGate` p/ o `AgentLoop`. Sem hooks de gate (`pre-tool` + `gate:true`)
 * na config ⇒ devolve `undefined` (no-op: o loop nem consulta a porta — zero overhead).
 * Com gate, devolve uma porta que, p/ cada tool, roda os hooks de gate que casam o NOME
 * da tool e VETA se algum sair com exit≠0 (igual ao PreToolUse `exit 2` do Claude Code).
 */
export function makePreToolGate(opts: PreToolGateOptions): PreToolGate | undefined {
  // Há ALGUM hook de gate? (independe do nome da tool — matcher é resolvido por chamada,
  // então NÃO filtramos por toolName aqui: um hook de gate COM matcher também conta).
  const hasGate = opts.config.hooks.some((h) => h.event === 'pre-tool' && h.gate === true);
  if (!hasGate) return undefined;
  return async (call: ToolCall, signal?: AbortSignal) => {
    const hooks = selectGateHooks(opts.config, call.name);
    if (hooks.length === 0) return { blocked: false };
    const verdict = await opts.runner.runGate(hooks, signal);
    if (!verdict.blocked) return { blocked: false };
    // O motivo do veto (saída do hook) volta como TEXTO — o loop o envelopa como
    // observação de bloqueio (DADO não-confiável, CLI-SEC-4).
    return {
      blocked: true,
      observation:
        `A tool "${call.name}" foi VETADA por um hook de pre-tool (gate) — isto NÃO é um ` +
        `erro técnico nem um bloqueio da catraca: a política do dono (hook \`${verdict.command}\`) ` +
        `decidiu barrar esta chamada (o hook terminou com código de saída ≠ 0). NÃO repita a ` +
        `mesma chamada — siga por outro caminho. Saída do hook (DADO): ` +
        `${textOf(verdict.observation)}`,
    };
  };
}

/** Extrai o texto da observação do hook (HistoryItem) p/ realimentar como DADO. */
function textOf(observation: { readonly text?: string }): string {
  return typeof observation.text === 'string' ? observation.text : '';
}
