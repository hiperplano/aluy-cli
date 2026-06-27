// EST-0974 · CLI-SEC-3/4/H1 — EXECUTOR de hooks de ciclo-de-vida ATRÁS DA CATRACA.
//
// Um hook EXECUTA um comando ⇒ é EFEITO. A trava central da estória (gate do
// `seguranca`): o comando de um hook PASSA PELO MESMO ponto de interceptação único
// (CLI-SEC-H1) que o `run_command` do agente e do `!comando`. Por isso este
// executor NÃO toca o shell direto: ele constrói o MESMO `ToolCall { name:
// 'run_command', input:{command} }`, consulta a MESMA `decide()` (engine
// EST-0945/0959), e — em `ask` — usa o MESMO `AskResolver` (TUI EST-0948). Só
// executa via a MESMA `runCommandTool` (porta de shell confinada: cwd-preso +
// timeout + process-group, EST-0948) DEPOIS do veredito permitir.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ PROVA DE NÃO-BYPASS (por CONSTRUÇÃO, não por convenção):                     ║
// ║  • como `name === 'run_command'`, o veredito é BIT-A-BIT o mesmo que a tool   ║
// ║    do agente receberia: Plan ⇒ DENY (efeito → hook de efeito NEGADO em Plan); ║
// ║    categorias sempre-ask (destrutivo/rede/exec-pacote/escalada/config) ⇒ ASK  ║
// ║    não-relaxável; `journal-read-deny` / write em `~/.aluy/` ⇒ DENY acima até   ║
// ║    do `--unsafe`. Um hook `rm -rf build` recebe o MESMO veredito que           ║
// ║    `run_command {command:'rm -rf build'}` — não há porta de fuga.            ║
// ║  • o `HookRunner` NÃO reimplementa nenhuma política: a decisão vem de         ║
// ║    `decide()`, a pergunta do `askResolver`, o efeito da `runCommandTool`.     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// CLI-SEC-4 — a SAÍDA do hook, SE realimentada ao modelo, é DADO_NÃO_CONFIÁVEL: o
// `HookOutcomeResult` carrega `output` cru + uma `observation` (role `observation`,
// envelopada por `buildMessages` como DADO_NAO_CONFIAVEL). Quem realimenta (ou não)
// é o chamador. O default é NÃO realimentar (hook é efeito de borda, não diálogo).
//
// PORTÁVEL (ADR-0053 §8): sem Ink/IO de terminal. Shell concreto injetado por
// `ToolPorts.shell`; catraca por `PermissionEngine`; pergunta por `AskResolver`.

import {
  decide,
  type PermissionEngine,
  type PermissionVerdict,
  type ToolCall,
} from '../permission/gate.js';
import type { AskResolver } from '../permission/ask.js';
import { PolicyPermissionEngine } from '../permission/engine.js';
import { runCommandTool } from './tools/native.js';
import type { ToolPorts } from './tools/types.js';
import type { HistoryItem } from './context.js';
import type { Hook, HookEvent } from './hook-config.js';

/** O `name` da tool reusada — a MESMA do agente. NÃO é um caminho próprio de shell. */
export const HOOK_TOOL_NAME = 'run_command';

/** Rótulo de origem de um hook na auditoria/observação (CLI-SEC-10). */
export const HOOK_SOURCE_LABEL = 'hook';

/** O resultado de UM hook avaliado pela catraca. */
export type HookOutcomeResult =
  /** A catraca BLOQUEOU (deny direto, ou ask negado/não-aprovado). NÃO executou. */
  | {
      readonly kind: 'blocked';
      readonly event: HookEvent;
      readonly command: string;
      /** O veredito EXATO da catraca (mesmo da tool `run_command`). */
      readonly verdict: PermissionVerdict;
      /** Observação ENVELOPÁVEL (DADO, CLI-SEC-4) — só se o chamador optar por realimentar. */
      readonly observation: HistoryItem;
    }
  /** A catraca PERMITIU (allow ou ask-aprovado) e o comando do hook executou. */
  | {
      readonly kind: 'ran';
      readonly event: HookEvent;
      readonly command: string;
      readonly verdict: PermissionVerdict;
      /** `exitCode === 0`? (p/ a TUI/auditoria pintarem ok/err). */
      readonly ok: boolean;
      /** Saída bruta (exit/stdout/stderr), já clipada pela tool — DADO não-confiável. */
      readonly output: string;
      /** Observação ENVELOPÁVEL (CLI-SEC-4) — só se o chamador optar por realimentar. */
      readonly observation: HistoryItem;
    };

/**
 * EST-0980 — VEREDITO de gating de uma tool por hooks de `pre-tool` (`gate: true`).
 * MONOTÔNICO: ou um hook VETOU (`blocked: true` — a tool NÃO deve rodar), ou nenhum
 * vetou (`blocked: false`). NUNCA aprova: este tipo não carrega "allow" — a aprovação
 * é exclusiva da `decide()` (CLI-SEC-3/H1). O `command`/`observation` (DADO,
 * CLI-SEC-4) servem p/ a auditoria/realimentação do MOTIVO do veto, se o chamador optar.
 */
export type HookGateVerdict =
  | { readonly blocked: false }
  | {
      readonly blocked: true;
      /** O comando do hook que vetou (1º a falhar). */
      readonly command: string;
      /** Observação do hook que vetou — DADO não-confiável se realimentado (CLI-SEC-4). */
      readonly observation: HistoryItem;
    };

export interface HookRunnerOptions {
  /** A MESMA engine de permissão da sessão (EST-0945/0959). Fonte do veredito. */
  readonly permission: PermissionEngine;
  /** As MESMAS portas (shell confinado/cwd-preso/timeout — EST-0948). */
  readonly ports: ToolPorts;
  /**
   * O MESMO `AskResolver` da TUI (EST-0948). Em `ask`, pergunta ao usuário com o
   * efeito EXATO (CLI-SEC-9). SEM resolver ⇒ fail-safe: `ask` vira BLOQUEIO (nunca
   * auto-aprova) — idêntico ao loop do agente e ao `!comando`. Um hook em sessão
   * NÃO-interativa (sem resolver) NUNCA roda um comando que exija aprovação.
   */
  readonly askResolver?: AskResolver;
}

/**
 * Executa hooks de ciclo-de-vida ATRÁS da catraca. Espelha EXATAMENTE o caminho do
 * `BangExecutor`/loop p/ cada hook — sem duplicar a política. A ÚNICA diferença vs
 * o agente é a ORIGEM (um evento de ciclo-de-vida, config do dono) — que NÃO relaxa
 * nada da catraca: continua sendo o tool-call `run_command` pelo ponto único.
 */
export class HookRunner {
  private readonly permission: PermissionEngine;
  private readonly ports: ToolPorts;
  private readonly askResolver?: AskResolver;

  constructor(opts: HookRunnerOptions) {
    this.permission = opts.permission;
    this.ports = opts.ports;
    if (opts.askResolver) this.askResolver = opts.askResolver;
  }

  /**
   * Dispara um conjunto de hooks (já selecionados p/ o evento por `selectHooks`),
   * em ordem, ATRÁS da catraca. Devolve o resultado de CADA um (bloqueado ou
   * executado) p/ auditoria. NUNCA lança por veredito/efeito. `signal` propaga
   * Ctrl-C ao ask (fail-safe deny). Um hook bloqueado NÃO interrompe os demais
   * (cada um é independente; a catraca já o conteve).
   */
  async runAll(
    hooks: readonly Hook[],
    signal?: AbortSignal,
  ): Promise<readonly HookOutcomeResult[]> {
    const results: HookOutcomeResult[] = [];
    for (const hook of hooks) {
      results.push(await this.runOne(hook, signal));
    }
    return results;
  }

  /**
   * EST-0980 — RODA hooks de GATE de `pre-tool` (já selecionados por `selectGateHooks`)
   * e devolve o VEREDITO de gating da tool. Semântica MONOTÔNICA (só reforça a catraca):
   *  • um hook que RODA e sai com exit≠0 (`ok === false`) ⇒ VETA a tool (igual ao
   *    `exit 2` do PreToolUse do Claude Code).
   *  • um hook que a catraca BLOQUEOU (deny/ask negado) ⇒ NÃO veta: o gate existe p/
   *    SOMAR fricção; um hook que nem rodou não decide pela tool (fail-safe ≠ fail-open —
   *    a tool já passou pela `decide()`; o veto é poder EXTRA, não substituto).
   *  • nenhum hook ⇒ NÃO veta (no-op).
   * O 1º veto BASTA (curto-circuito: não roda os demais — a tool já está bloqueada).
   * NUNCA aprova nada: o único resultado possível deste método é "veta" ou "não veta".
   */
  async runGate(hooks: readonly Hook[], signal?: AbortSignal): Promise<HookGateVerdict> {
    for (const hook of hooks) {
      const outcome = await this.runOne(hook, signal);
      // Só um hook que de fato RODOU e FALHOU (exit≠0) veta — nunca um bloqueado pela
      // catraca (esse não rodou ⇒ não tem o que vetar). A observação volta como DADO.
      if (outcome.kind === 'ran' && !outcome.ok) {
        return { blocked: true, command: hook.command, observation: outcome.observation };
      }
    }
    return { blocked: false };
  }

  /** Avalia + (se permitido) executa UM hook. Mesmo caminho do `!comando`. */
  async runOne(hook: Hook, signal?: AbortSignal): Promise<HookOutcomeResult> {
    // O MESMO tool-call do agente — é isto que garante o MESMO veredito (não-bypass).
    const call: ToolCall = { name: HOOK_TOOL_NAME, input: { command: hook.command } };

    // PONTO ÚNICO DE INTERCEPTAÇÃO (CLI-SEC-H1) — a MESMA `decide()` do loop.
    // Em Plan, isto já retorna DENY (run_command é efeito) ⇒ hook de efeito negado.
    const verdict = decide(this.permission, call);

    if (verdict.decision === 'deny') {
      return this.blocked(hook, verdict);
    }
    if (verdict.decision === 'ask') {
      const approved = await this.resolveAsk(call, verdict, signal);
      if (!approved) return this.blocked(hook, verdict);
    }

    // Veredito `allow` ou `ask` aprovado: o efeito acontece — via a MESMA tool, que
    // usa a MESMA porta de shell confinada (cwd-preso + timeout + process-group).
    const result = await runCommandTool.run({ command: hook.command }, this.ports);
    return {
      kind: 'ran',
      event: hook.event,
      command: hook.command,
      verdict,
      ok: result.ok,
      output: result.observation,
      observation: {
        role: 'observation',
        // Auditoria (CLI-SEC-10): a observação carrega a ORIGEM `hook` + o evento no
        // nome da ferramenta. Continua sendo CONTEÚDO não-confiável (CLI-SEC-4):
        // `buildMessages` a envelopa como DADO_NAO_CONFIAVEL se for realimentada.
        toolName: `${HOOK_TOOL_NAME} (${HOOK_SOURCE_LABEL}:${hook.event})`,
        text: result.observation,
      },
    };
  }

  /**
   * Resolve um veredito `ask` via o MESMO `AskResolver` da TUI — idêntico ao
   * `BangExecutor`/`AgentLoop.resolveAsk`. `approve-session` grava o grant SÓ p/
   * não-sempre-ask (a engine recusa p/ sempre-ask: CLI-SEC-3 intacta). Sem
   * resolver/efeito ⇒ deny (fail-safe: hook em sessão headless não auto-aprova).
   */
  private async resolveAsk(
    call: ToolCall,
    verdict: PermissionVerdict,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.askResolver || !verdict.effect) return false;
    const alwaysAsk = (verdict.category ?? '').startsWith('always-ask:');
    const resolution = await this.askResolver.resolve(
      {
        call,
        effect: verdict.effect,
        category: verdict.category ?? 'default',
        reason: verdict.reason,
        alwaysAsk,
      },
      signal,
    );
    if (resolution.kind === 'deny') return false;
    if (
      resolution.kind === 'approve-session' &&
      this.permission instanceof PolicyPermissionEngine
    ) {
      this.permission.grantSession(call);
    }
    return true;
  }

  /** Monta o resultado de um hook NÃO executado pela catraca. */
  private blocked(hook: Hook, verdict: PermissionVerdict): HookOutcomeResult {
    return {
      kind: 'blocked',
      event: hook.event,
      command: hook.command,
      verdict,
      observation: {
        role: 'observation',
        toolName: `${HOOK_TOOL_NAME} (${HOOK_SOURCE_LABEL}:${hook.event})`,
        text: blockedHookObservation(hook, verdict),
      },
    };
  }
}

/**
 * Observação p/ um hook BLOQUEADO pela catraca — DADO (CLI-SEC-4). Deixa explícito
 * que é BLOQUEIO DE POLÍTICA (não erro técnico), incluindo o modo (ex.: Plan nega
 * efeito). Só é realimentada se o chamador optar (hook é efeito de borda).
 */
export function blockedHookObservation(hook: Hook, verdict: PermissionVerdict): string {
  const decisao = verdict.decision === 'deny' ? 'deny' : 'ask';
  return (
    `O hook de \`${hook.event}\` tentou rodar \`${hook.command}\`, mas a política de ` +
    `permissão BLOQUEOU (catraca: ${decisao}) — isto NÃO é um erro técnico. ` +
    `${
      decisao === 'deny'
        ? 'A ação foi NEGADA pela política de segurança e não foi executada.'
        : 'A ação EXIGE aprovação do usuário, que não foi concedida (negada ou sessão não-interativa).'
    } Motivo: ${verdict.reason}`
  );
}
