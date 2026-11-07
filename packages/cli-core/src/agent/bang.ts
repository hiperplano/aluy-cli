// EST-0958 · CLI-SEC-3/4/9 — `!comando` (atalho de shell do composer).
//
// F15 (docs/decisions/0003): `ask` NÃO abre caixa — o usuário digitou o comando (ação
// explícita); `deny` (Plan, pisos de ~/.aluy, hooks) segue bloqueando. O texto abaixo é o
// desenho original (EST-0958).
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
import type { DetachHub, ShellChunk, ToolPorts, ToolRunContext } from './tools/types.js';
import type { HistoryItem } from './context.js';
import { redactCommandSecrets } from './journal/redact.js';

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
      /**
       * O que o BLOCO mostra: a saída em texto simples (stdout; stderr só se houver; `exit N`
       * só se ≠ 0) — sem o envelope `exit=/stdout:/stderr:` que existe para o modelo.
       * JÁ redigida (CLI-SEC-6 + valor exato do `/secret`).
       */
      readonly output: string;
      /** Código de saída (0 em `cd`). */
      readonly exitCode: number;
      /**
       * Aviso quando o comando provavelmente PEDIA terminal (stdin do `!` é fechado — não há
       * TTY). Heurística honesta: ver {@link detectNonInteractive}. Ausente = nada detectado.
       */
      readonly hint?: string;
      /**
       * Observação ENVELOPÁVEL (CLI-SEC-4) p/ realimentar ao modelo: o comando + a saída
       * (limitada; diz quando truncou). O chamador decide entregar (`!`) ou não (`!!`).
       */
      readonly observation: HistoryItem;
    };

export interface BangExecutorOptions {
  /** A MESMA engine de permissão da sessão (EST-0945/0959). Fonte do veredito. */
  readonly permission: PermissionEngine;
  /** As MESMAS portas (shell confinado/cwd-preso/timeout — EST-0948). */
  readonly ports: ToolPorts;
  /** F-BG — o canal do Ctrl+B. Ausente ⇒ soltar não existe no `!comando` (como antes). */
  readonly detachHub?: DetachHub;
  /**
   * O MESMO `AskResolver` da TUI (EST-0948). Em `ask`, pergunta ao usuário com o
   * efeito EXATO (CLI-SEC-9). SEM resolver ⇒ fail-safe: `ask` vira BLOQUEIO (nunca
   * auto-aprova) — idêntico ao loop do agente.
   */
  readonly askResolver?: AskResolver;
  /**
   * F15 (ADR 0003) — o `!comando` é uma AÇÃO EXPLÍCITA DO USUÁRIO: um veredito `ask` NÃO
   * abre a caixa de permissão (quem digitou já decidiu). Default `true`. `deny` continua
   * bloqueando (pisos duros: `~/.aluy`, hooks que negam, modo Plan, escopo). `false` restaura
   * o comportamento antigo (ask via resolver). Isto vale SÓ para este executor (origem
   * usuário); o `run_command` do MODELO segue 100% por `decide()` no loop.
   */
  readonly userExplicit?: boolean;
  /** HOME do usuário (injetado pelo locus concreto — o core não lê `process.env`) p/ `cd ~/x`. */
  readonly homeDir?: string;
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
  private readonly userExplicit: boolean;
  /** `cd -` — o diretório anterior da sessão (só do `!cd`). */
  private prevCwd: string | undefined;
  private readonly homeDir: string | undefined;
  /**
   * F-BG — o canal do Ctrl+B, o MESMO que o loop do agente usa.
   *
   * O `!comando` é onde o dono mais provavelmente se prende: é ELE quem digita
   * `!npm run dev`. Deixar o soltar só no caminho do agente faria a tecla parecer
   * quebrada justamente no uso mais deliberado.
   */
  private readonly detachHub?: DetachHub;

  constructor(opts: BangExecutorOptions) {
    this.permission = opts.permission;
    this.ports = opts.ports;
    this.userExplicit = opts.userExplicit ?? true;
    this.homeDir = opts.homeDir;
    if (opts.askResolver) this.askResolver = opts.askResolver;
    if (opts.detachHub) this.detachHub = opts.detachHub;
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

    // F15 — `ask` + ação explícita do usuário ⇒ executa direto (sem caixa). Só `deny` bloqueia.
    if (verdict.decision === 'ask' && !this.userExplicit) {
      const approved = await this.resolveAsk(call, verdict, signal);
      if (!approved) return this.blocked(command, verdict);
    }

    // Veredito `allow`, ou `ask` aprovado: o efeito acontece — via a MESMA tool, que
    // usa a MESMA porta de shell confinada (cwd-preso + timeout, EST-0948). EST-0982:
    // o MESMO `signal` (abort/kill) e o `onShellChunk` (stream) passam pelo MESMO ctx
    // que o loop do agente injeta — o `!comando` ganha matar-ao-esc e stream idênticos.
    // F-BG — o `!comando` ganha o SOLTAR pelo mesmo canal do agente: um sinal novo por
    // execução, e o `onDetached` que adota o processo vivo num monitor.
    // `cd` simples PERSISTE (move o cwd da sessão, mesmas cercas da porta de cwd) — um shell
    // de um comando só perderia o `cd` ao terminar. Passa pelo mesmo `decide()` (change_dir).
    const cd = parseSimpleCd(command);
    if (cd !== undefined && this.ports.cwd) {
      return this.runCd(command, cd, verdict);
    }

    const detachSignal = this.detachHub?.arm();
    const ctx: ToolRunContext = {
      // ADR 0005 — o `!` do DONO exporta TODOS os segredos do `/secret` como env var (ação
      // explícita, ADR 0003/0005); a saída segue redigida por valor exato.
      secretEnv: 'all',
      ...(signal ? { signal } : {}),
      ...(onChunk ? { onShellChunk: onChunk } : {}),
      ...(detachSignal ? { detachSignal } : {}),
      ...(this.detachHub ? { onDetached: (info): void => this.detachHub?.onDetached(info) } : {}),
    };
    const result = await runCommandTool.run({ command }, this.ports, ctx);
    const sh = result.shell;
    // Sem `shell` (falha antes de executar: ex. input inválido) cai no texto da tool.
    const output = sh ? formatBangOutput(sh) : result.observation;
    const hint = sh ? detectNonInteractive(command, sh.exitCode, sh.stdout, sh.stderr) : undefined;
    return {
      kind: 'ran',
      verdict,
      ok: result.ok,
      output: hint ? `${output}${output === '' ? '' : '\n'}${hint}` : output,
      exitCode: sh?.exitCode ?? (result.ok ? 0 : 1),
      ...(hint ? { hint } : {}),
      observation: bangFeedObservation(command, output),
    };
  }

  /** `cd` persistente: move o cwd de sessão pela porta de cwd (confinada às raízes). */
  private runCd(command: string, target: string, verdict: PermissionVerdict): BangOutcome {
    const cwd = this.ports.cwd!;
    // Mesmo seam: a navegação é um `change_dir` — Plan/deny/hook negam como negariam ao modelo.
    const cdVerdict = decide(this.permission, { name: 'change_dir', input: { path: target } });
    if (cdVerdict.decision === 'deny') return this.blocked(command, cdVerdict);
    const prev = cwd.cwd;
    let requested = target;
    if (target === '-') requested = this.prevCwd ?? prev;
    else if (target === '' || target === '~') requested = cwd.root;
    else if (target.startsWith('~/')) {
      if (this.homeDir) requested = `${this.homeDir}${target.slice(1)}`;
    }
    let output: string;
    let ok = true;
    try {
      const next = cwd.setCwd(requested);
      if (next !== prev) this.prevCwd = prev;
      const rel = relativeTo(cwd.root, next);
      const mesmo = next === prev && !['.', './', ''].includes(target);
      // Destino ABSOLUTO que não é onde paramos ⇒ a porta o CLAMPOU numa raiz autorizada.
      const clamped = requested.startsWith('/') && next !== requested.replace(/\/+$/, '');
      output = mesmo
        ? `o diretório continua ${rel}: o destino é o próprio diretório ou cai fora das raízes ` +
          `autorizadas do projeto (a sessão não sai delas; /add-dir autoriza outra raiz)`
        : clamped
          ? `diretório da sessão agora: ${rel} — "${target}" fica fora das raízes autorizadas do ` +
            `projeto, então a sessão ficou na raiz mais próxima (/add-dir autoriza outra)`
          : `diretório da sessão agora: ${rel}`;
    } catch (e) {
      ok = false;
      output =
        `não consegui entrar em "${target}": ${(e instanceof Error ? e.message : String(e)).replace(/[.\s]+$/, '')}. ` +
        `O diretório da sessão não mudou (${relativeTo(cwd.root, prev)}).`;
    }
    return {
      kind: 'ran',
      verdict,
      ok,
      output,
      exitCode: ok ? 0 : 1,
      observation: {
        role: 'observation',
        toolName: `${BANG_TOOL_NAME} (${BANG_SOURCE_LABEL})`,
        text:
          `O usuário rodou \`!${redactCommandSecrets(command)}\` no terminal. ` +
          `${output}. (Isto muda o diretório de trabalho da sessão — caminhos relativos e ` +
          `comandos seguintes partem dele.)`,
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

// ───────────────────────────── helpers do `!` ─────────────────────────────

/** `cd`/`cd X`/`cd -` SIMPLES (sem `&&`, `;`, pipe, redirecionamento, expansão). */
export function parseSimpleCd(command: string): string | undefined {
  const m = /^cd(?:\s+(.*))?$/.exec(command.trim());
  if (!m) return undefined;
  let arg = (m[1] ?? '').trim();
  if (/[;&|<>`$()\n*?[\]{}!]/.test(arg)) return undefined;
  const q = /^(["'])(.*)\1$/.exec(arg);
  if (q) arg = q[2] ?? '';
  else if (/\s/.test(arg) || /["']/.test(arg)) return undefined;
  return arg;
}

function relativeTo(root: string, cwd: string): string {
  if (cwd === root) return '.';
  return cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : cwd;
}

/**
 * Saída do bloco do `!`: stdout puro; stderr só se houver (rotulado quando há stdout
 * também); `exit N` só se ≠ 0. Sem saída e exit 0 ⇒ vazio (o cabeçalho já diz `ok`).
 */
export function formatBangOutput(r: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted?: boolean;
}): string {
  const so = r.stdout.replace(/\s+$/, '');
  const se = r.stderr.replace(/\s+$/, '');
  const parts: string[] = [];
  if (so !== '') parts.push(so);
  if (se !== '') parts.push(so !== '' ? `stderr:\n${se}` : se);
  if (r.aborted) parts.push('[interrompido pelo usuário]');
  else if (r.exitCode !== 0) parts.push(`exit ${r.exitCode}`);
  return parts.join('\n');
}

/** Teto do que o `!` devolve ao modelo (a tela mostra tudo o que a tool devolveu). */
export const BANG_FEED_MAX_CHARS = 12_000;
const BANG_FEED_HEAD = 8_000;
const BANG_FEED_TAIL = 3_000;

/**
 * A observação que leva o `!` ao modelo: o comando + a saída, LIMITADOS (cabeça+cauda) e
 * dizendo quando cortou. Canal CONTEÚDO (CLI-SEC-4): `buildMessages` a envelopa como dado
 * não-confiável. O comando é redigido (o dono pode ter digitado um token na linha).
 */
export function bangFeedObservation(command: string, output: string): HistoryItem {
  let body = output === '' ? '(sem saída)' : output;
  if (body.length > BANG_FEED_MAX_CHARS) {
    const omitted = body.length - BANG_FEED_HEAD - BANG_FEED_TAIL;
    body =
      `${body.slice(0, BANG_FEED_HEAD)}\n[… ${omitted} caracteres omitidos no meio — a saída ` +
      `completa só está na tela do usuário]\n${body.slice(body.length - BANG_FEED_TAIL)}`;
  }
  return {
    role: 'observation',
    // Auditoria (CLI-SEC-10): a ORIGEM `!comando` vai no nome — ação do USUÁRIO, não tool-call.
    toolName: `${BANG_TOOL_NAME} (${BANG_SOURCE_LABEL})`,
    text:
      `O usuário rodou no terminal, pelo atalho \`!\` (ele mesmo digitou; não foi você): ` +
      `$ ${redactCommandSecrets(command)}\n${body}`,
  };
}

const INTERACTIVE_PROGRAMS: ReadonlySet<string> = new Set([
  'vim',
  'vi',
  'nvim',
  'nano',
  'emacs',
  'less',
  'more',
  'top',
  'htop',
  'man',
  'passwd',
]);

export const NON_INTERACTIVE_HINT =
  'dica: o `!` não é interativo (o comando não tem terminal nem teclado). ' +
  'Rode este em outro terminal.';

/**
 * Detecta, SEM TTY, um comando que provavelmente esperava o teclado. Heurística, não prova:
 * o stdin do `!` é fechado (EOF), então `read` não bloqueia — só devolve falha, sem
 * mensagem. Cobre (1) o builtin `read` no texto; (2) mensagens típicas de "preciso de TTY"
 * no stderr (sudo/ssh/docker/etc.); (3) programas de tela cheia sem argumentos úteis
 * (vim, less, top…). NÃO detecta um programa próprio que leia stdin e saia calado.
 */
export function detectNonInteractive(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): string | undefined {
  const cmd = command.trim();
  if (/(?:^|[;&|(]\s*)read(?:\s|$)/.test(cmd)) return NON_INTERACTIVE_HINT;
  if (
    exitCode !== 0 &&
    /(?:a terminal is required|no tty present|not a tty|stdin is not a tty|input device is not a tty|inappropriate ioctl|must be run (?:in|from) a terminal)/i.test(
      stderr + stdout,
    )
  ) {
    return NON_INTERACTIVE_HINT;
  }
  const first = /^(?:sudo\s+)?([\w./-]+)/.exec(cmd)?.[1]?.split('/').pop();
  if (first !== undefined && INTERACTIVE_PROGRAMS.has(first)) return NON_INTERACTIVE_HINT;
  return undefined;
}
