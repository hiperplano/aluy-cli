// REDE DE SEGURANÇA: registra em `~/.aluy/logs/crash.log` TODO término fatal do processo
// antes de ele sumir. Motivo (UX review): o `aluy` morreu logo após aprovar o bash de um
// sub-agente, o pane do tmux sumiu e NADA ficou em `~/.aluy/logs` — impossível diagnosticar.
//
// O que cobre:
//  - `uncaughtExceptionMonitor` (inclui unhandledRejection convertido pelo Node): só OBSERVA, não
//    muda o comportamento (não "engole" o crash nem suprime o stack padrão);
//  - `exit` com código ≠ 0 (process.exit(1) direto em qualquer ponto);
//  - SIGHUP vindo de fora (terminal/tmux fechou): loga e mantém o encerramento (exit 129);
//  - no PAI do re-exec de heap-limit (`logChildExit`): o filho morto por sinal ou por OOM nativo
//    (SIGABRT/SIGKILL), que nenhum handler JS do filho consegue registrar.
//
// Best-effort: nunca lança, nunca bloqueia, arquivo 0600, tamanho limitado, sem segredos (só a
// mensagem/stack do erro; o stack do Node não carrega o conteúdo das mensagens do usuário).

import { secretVault } from '@hiperplano/aluy-cli-core';
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { aluyHomeDir } from '../sandbox/aluy-home.js';

const MAX_LOG_BYTES = 512 * 1024;
const MAX_DETAIL = 8 * 1024;

export interface FatalLogOptions {
  /** Diretório de logs (default `~/.aluy/logs`). Injetável p/ teste. */
  readonly dir?: string;
  readonly now?: () => Date;
  readonly pid?: number;
}

/** Acrescenta uma entrada ao crash.log. Nunca lança. Devolve `true` se gravou. */
export function appendFatalLog(kind: string, detail: unknown, opts: FatalLogOptions = {}): boolean {
  try {
    const dir = opts.dir ?? join(aluyHomeDir(), 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'crash.log');
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
    } catch {
      /* ainda não existe */
    }
    const text =
      detail instanceof Error
        ? (detail.stack ?? `${detail.name}: ${detail.message}`)
        : typeof detail === 'string'
          ? detail
          : (() => {
              try {
                return JSON.stringify(detail);
              } catch {
                return String(detail);
              }
            })();
    const ts = (opts.now?.() ?? new Date()).toISOString();
    const pid = opts.pid ?? process.pid;
    appendFileSync(
      file,
      secretVault.redact(`[${ts}] pid=${String(pid)} ${kind}: ${text.slice(0, MAX_DETAIL)}\n`),
      {
        mode: 0o600,
      },
    );
    return true;
  } catch {
    return false;
  }
}

/** Subconjunto de `process` usado (injetável p/ teste). */
export interface FatalProcessLike {
  on(event: string, listener: (...a: never[]) => void): unknown;
  exit(code?: number): never;
}

/**
 * Instala os observadores. Idempotente por chamada (devolve `uninstall`). NÃO registra
 * `uncaughtException`/`unhandledRejection` (isso mudaria o comportamento padrão do Node).
 */
export function installFatalLogger(
  proc: FatalProcessLike = process as unknown as FatalProcessLike,
  opts: FatalLogOptions = {},
): void {
  const seen = new WeakSet<object>();
  proc.on('uncaughtExceptionMonitor', ((err: unknown, origin: unknown) => {
    // O alt-screen RE-LANÇA o MESMO erro no próximo tick (p/ não silenciar o crash) ⇒ o Node
    // dispara o monitor 2× p/ o mesmo objeto (achado do dono: entrada duplicada no crash.log).
    // Dedupe por identidade do Error.
    if (err !== null && typeof err === 'object') {
      if (seen.has(err)) return;
      seen.add(err);
    }
    appendFatalLog(`uncaughtException(${String(origin)})`, err, opts);
  }) as never);
  proc.on('exit', ((code: number) => {
    if (code !== 0) appendFatalLog('exit', `código ${String(code)}`, opts);
  }) as never);
  // SIGHUP (terminal/tmux fechou): ter um listener tira o encerramento padrão do Node, então
  // reproduzimos o default (exit 129). SIGTERM/SIGINT NÃO são tocados: o alt-screen já os trata
  // e, nos demais modos, registrar listener aqui impediria o processo de morrer.
  proc.on('SIGHUP', (() => {
    appendFatalLog('signal', 'SIGHUP', opts);
    proc.exit(129);
  }) as never);
}

/** No PAI do re-exec: registra um filho que morreu por sinal / OOM nativo / código fatal. */
export function logChildExit(
  code: number | null,
  signal: string | null,
  opts: FatalLogOptions = {},
): void {
  if (signal !== null || (code !== null && code !== 0 && code !== 130 && code !== 143)) {
    appendFatalLog('filho-encerrou', `code=${String(code)} signal=${String(signal)}`, opts);
  }
}
