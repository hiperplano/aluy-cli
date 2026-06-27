// EST-0958 · CLI-SEC-3/4/9 — `!comando` (atalho de shell do composer).
//
// O `!comando` é exec de shell GUIADO PELO USUÁRIO (fora do raciocínio do modelo),
// mas NÃO é um bypass da catraca. A trava central da estória (gate `seguranca`):
// `!comando` PASSA PELO MESMO ponto de interceptação (CLI-SEC-H1) que o `run_command`
// do agente. Por isso este executor NÃO toca o shell direto: ele constrói o MESMO
// `ToolCall { name:'run_command', input:{command} }`, consulta a MESMA `decide()`
// (engine concreta da EST-0945/0959) e, em `ask`, usa o MESMO `AskResolver` (TUI da
// EST-0948). Só executa via a MESMA `runCommandTool` (porta de shell confinada,
// cwd-preso + timeout da EST-0948) DEPOIS do veredito permitir.
//
// CONSEQUÊNCIA (prova de não-bypass — por construção, não por convenção):
//   - como o `name` é `run_command`, o veredito é BIT-A-BIT o mesmo que a tool do
//     agente teria recebido: Plan ⇒ DENY (efeito); categorias sempre-ask
//     (destrutivo/rede/exec-pacote/escalada/config) ⇒ ASK não-relaxável; `--unsafe`
//     bypassa IGUAL a qualquer efeito; `journal-read-deny` ⇒ DENY acima do unsafe.
//   - `!rm -rf build` recebe o MESMO veredito que `run_command {command:'rm -rf build'}`.
//
// CLI-SEC-4 — a SAÍDA realimentada ao modelo entra como `observation` (canal
// CONTEÚDO, role `user`, ENVELOPADA por `buildMessages` como DADO_NAO_CONFIAVEL),
// NUNCA como instrução. Este executor produz o `HistoryItem` de observação; quem
// o realimenta é o chamador (controller), via o mesmo caminho de uma tool.
//
// PORTÁVEL (ADR-0053 §8): sem Ink/IO de terminal. O shell concreto (timeout/cwd) é
// injetado por `ToolPorts.shell` (EST-0948); a catraca por `PermissionEngine`.

import {
  decide,
  type PermissionEngine,
  type PermissionVerdict,
  type ToolCall,
} from '../permission/gate.js';
import type { AskResolver } from '../permission/ask.js';
import { PolicyPermissionEngine } from '../permission/engine.js';
import { runCommandTool } from './tools/native.js';
import type { ShellChunk, ToolPorts, ToolRunContext } from './tools/types.js';
import type { HistoryItem } from './context.js';

/** O `name` da tool reusada — a MESMA do agente. NÃO é um caminho próprio de shell. */
export const BANG_TOOL_NAME = 'run_command';

/** Rótulo de origem do `!comando` na observação (auditoria — ação do USUÁRIO, CLI-SEC-10). */
export const BANG_SOURCE_LABEL = '!comando';

/** Resultado de um `!comando` avaliado pela catraca. */
export type BangOutcome =
  /** A catraca BLOQUEOU (deny direto, ou ask negado/não-aprovado). NÃO executou. */
  | {
      readonly kind: 'blocked';
      /** O veredito exato da catraca (mesmo da tool `run_command`). */
      readonly verdict: PermissionVerdict;
      /** Observação ACIONÁVEL p/ realimentar ao modelo (se o turno for ao modelo). */
      readonly observation: HistoryItem;
    }
  /** A catraca PERMITIU (allow direto ou ask aprovado) e o comando executou. */
  | {
      readonly kind: 'ran';
      /** O veredito exato (allow, ou ask-aprovado). */
      readonly verdict: PermissionVerdict;
      /** `exitCode === 0`? (p/ a TUI pintar ok/err). */
      readonly ok: boolean;
      /** O corpo bruto da saída (exit/stdout/stderr) — já clipado pela tool. */
      readonly output: string;
      /** Observação ENVELOPÁVEL (CLI-SEC-4) p/ realimentar ao modelo. */
      readonly observation: HistoryItem;
    };

export interface BangExecutorOptions {
  /** A MESMA engine de permissão da sessão (EST-0945/0959). Fonte do veredito. */
  readonly permission: PermissionEngine;
  /** As MESMAS portas (shell confinado/cwd-preso/timeout — EST-0948). */
  readonly ports: ToolPorts;
  /**
   * O MESMO `AskResolver` da TUI (EST-0948). Em `ask`, pergunta ao usuário com o
   * efeito EXATO (CLI-SEC-9). SEM resolver ⇒ fail-safe: `ask` vira BLOQUEIO (nunca
   * auto-aprova) — idêntico ao loop do agente.
   */
  readonly askResolver?: AskResolver;
}

/**
 * Executa um `!comando` ATRÁS da catraca. Espelha EXATAMENTE o caminho do loop
 * (`AgentLoop.executeToolCall`/`resolveAsk`) p/ um único tool-call — sem duplicar a
 * política: a decisão vem de `decide()`, a pergunta do `askResolver`, o efeito da
 * `runCommandTool`. A ÚNICA diferença vs o agente é a ORIGEM (usuário, não modelo) —
 * que NÃO relaxa nada da catraca.
 */
export class BangExecutor {
  private readonly permission: PermissionEngine;
  private readonly ports: ToolPorts;
  private readonly askResolver?: AskResolver;

  constructor(opts: BangExecutorOptions) {
    this.permission = opts.permission;
    this.ports = opts.ports;
    if (opts.askResolver) this.askResolver = opts.askResolver;
  }

  /**
   * Avalia + (se permitido) executa o `command`. `signal` propaga Ctrl-C ao ask
   * (fail-safe deny) E — EST-0982 — ao EFEITO: ao abortar durante o comando, a porta
   * MATA o processo (grupo) em vez de esperar o timeout. `onChunk` (EST-0982) recebe
   * a saída ao vivo (JÁ redigida pela tool, CLI-SEC-6) p/ a TUI streamar o bloco do
   * `!comando`. NUNCA lança por veredito/efeito — devolve um `BangOutcome`.
   */
  async run(
    command: string,
    signal?: AbortSignal,
    onChunk?: (chunk: ShellChunk) => void,
  ): Promise<BangOutcome> {
    // O MESMO tool-call do agente — é isto que garante o MESMO veredito (não-bypass).
    const call: ToolCall = { name: BANG_TOOL_NAME, input: { command } };

    // PONTO ÚNICO DE INTERCEPTAÇÃO (CLI-SEC-H1) — a MESMA `decide()` do loop.
    const verdict = decide(this.permission, call);

    if (verdict.decision === 'deny') {
      return this.blocked(command, verdict);
    }

    if (verdict.decision === 'ask') {
      const approved = await this.resolveAsk(call, verdict, signal);
      if (!approved) return this.blocked(command, verdict);
    }

    // Veredito `allow`, ou `ask` aprovado: o efeito acontece — via a MESMA tool, que
    // usa a MESMA porta de shell confinada (cwd-preso + timeout, EST-0948). EST-0982:
    // o MESMO `signal` (abort/kill) e o `onShellChunk` (stream) passam pelo MESMO ctx
    // que o loop do agente injeta — o `!comando` ganha matar-ao-esc e stream idênticos.
    const ctx: ToolRunContext = {
      ...(signal ? { signal } : {}),
      ...(onChunk ? { onShellChunk: onChunk } : {}),
    };
    const result = await runCommandTool.run({ command }, this.ports, ctx);
    return {
      kind: 'ran',
      verdict,
      ok: result.ok,
      output: result.observation,
      observation: {
        role: 'observation',
        // Auditoria (CLI-SEC-10): a observação carrega a ORIGEM `!comando` no nome da
        // ferramenta, distinguindo no histórico que veio do atalho do USUÁRIO — não
        // de um tool-call do modelo. Continua sendo CONTEÚDO não-confiável (CLI-SEC-4):
        // `buildMessages` a envelopa como DADO_NAO_CONFIAVEL ao montar o prompt.
        toolName: `${BANG_TOOL_NAME} (${BANG_SOURCE_LABEL})`,
        text: result.observation,
      },
    };
  }

  /**
   * Resolve um veredito `ask` via o MESMO `AskResolver` da TUI — idêntico ao
   * `AgentLoop.resolveAsk`. `approve-session` grava o grant SÓ p/ não-sempre-ask (a
   * engine recusa p/ sempre-ask: CLI-SEC-3 intacta). Sem resolver/efeito ⇒ deny.
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

  /** Monta o `BangOutcome` de um comando NÃO executado pela catraca. */
  private blocked(command: string, verdict: PermissionVerdict): BangOutcome {
    return {
      kind: 'blocked',
      verdict,
      observation: {
        role: 'observation',
        toolName: `${BANG_TOOL_NAME} (${BANG_SOURCE_LABEL})`,
        text: blockedObservation(command, verdict),
      },
    };
  }
}

/**
 * Observação ACIONÁVEL p/ um `!comando` bloqueado pela catraca, realimentada ao
 * modelo como DADO (CLI-SEC-4). Espelha a redação do loop (`loop.ts:blocked`):
 * deixa explícito que é BLOQUEIO DE POLÍTICA (não erro técnico) p/ o modelo não
 * re-tentar em laço. O comando é do USUÁRIO (não do modelo) — a observação só
 * informa o resultado da catraca, nunca pede que o modelo o re-execute.
 */
export function blockedObservation(command: string, verdict: PermissionVerdict): string {
  const decisao = verdict.decision === 'deny' ? 'deny' : 'ask';
  const motivo = verdict.reason;
  return (
    `O usuário tentou rodar \`!${command}\` pelo atalho de shell do composer, mas a ` +
    `política de permissão BLOQUEOU (catraca: ${decisao}) — isto NÃO é um erro técnico. ` +
    `${
      decisao === 'deny'
        ? 'A ação foi NEGADA pela política de segurança e não foi executada.'
        : 'A ação EXIGE aprovação do usuário, que não foi concedida (negada ou modo não-interativo).'
    } ` +
    `NÃO tente re-executar este comando você mesmo. Motivo: ${motivo}`
  );
}
