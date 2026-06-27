// EST-1000 · ADR-0076 §2 — ALT-SCREEN à prova de tudo (o INVARIANTE CRÍTICO do cockpit).
//
// O modo cockpit toma a TELA INTEIRA via o alternate-screen buffer do terminal
// (`\x1b[?1049h`). O byte de ENTRAR é trivial; toda a robustez está na SAÍDA
// GARANTIDA (`\x1b[?1049l`) + cursor visível (`\x1b[?25h`) + raw-mode restaurado, em
// TODO caminho de término — exit normal, crash/exceção, SIGINT, SIGTERM, unmount,
// resize-degenerado. Sem isso o produto é PIOR que o inline: deixa o terminal do
// usuário preso na tela alternativa, cursor sumido, raw mode travado (ADR-0076 §2 /
// alternativa C recusada).
//
// CONTRATO (ADR-0076 §2):
//  · `enterAltScreen(stdout)` emite `?1049h` + esconde o cursor (`?25l`).
//  · `restoreScreen()` é a função ÚNICA, IDEMPOTENTE de restauração: emite `?1049l`
//    + `?25h` (cursor visível) e tenta sair de raw-mode. Chamar 2× é INÓCUO.
//  · `registerRestoreHandlers()` registra `restoreScreen` em process.on(
//    'exit'|'SIGINT'|'SIGTERM'|'uncaughtException'|'unhandledRejection'), DE FORMA
//    que NENHUM `process.exit`/throw escape sem passar por ela. Devolve um `dispose()`
//    que solta os handlers (sem vazar listener entre sessões) — mas SEMPRE chamando a
//    restauração uma última vez.
//
// ESCOPO/SEGURANÇA: só bytes de controle de terminal (`@aluy/cli`). NÃO toca engine,
// catraca, egress, broker nem auth (ADR-0076 §Decisão: o cockpit é superfície de
// RENDER, não decide invariante). Sem `node:*` além do que o tipo do stream/process
// já oferece.

/** `\x1b[?1049h` — ENTRA no alternate-screen buffer (salva a tela primária). */
export const ENTER_ALT_SCREEN = '\x1b[?1049h';
/** `\x1b[?1049l` — SAI do alternate-screen (restaura a tela primária + scrollback). */
export const LEAVE_ALT_SCREEN = '\x1b[?1049l';
/** `\x1b[?25l` — esconde o cursor (no cockpit a posição é gerida pelo layout). */
export const HIDE_CURSOR = '\x1b[?25l';
/** `\x1b[?25h` — REEXIBE o cursor (restauração — NUNCA deixar o cursor sumido). */
export const SHOW_CURSOR = '\x1b[?25h';

/** Um stream mínimo p/ escrever os bytes de controle (process.stdout em prod, fake em teste). */
export interface AltScreenStream {
  write(chunk: string): boolean;
  /** raw-mode (TTY): restaurado p/ false na saída. Ausente em não-TTY (no-op). */
  setRawMode?: (mode: boolean) => void;
  readonly isTTY?: boolean;
}

/** Um subconjunto mínimo do `process` p/ registrar/soltar os handlers (injetável p/ teste). */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Eventos onde a restauração TEM de rodar (ADR-0076 §2: todo caminho de término). */
export const RESTORE_EVENTS = [
  'exit',
  'SIGINT',
  'SIGTERM',
  'uncaughtException',
  'unhandledRejection',
] as const;

/** Um dos eventos de restauração (derivado de `RESTORE_EVENTS` — fonte única). */
export type RestoreEvent = (typeof RESTORE_EVENTS)[number];

/**
 * ENTRA no alt-screen: emite `?1049h` (tela alternativa) + esconde o cursor. NÃO mexe
 * em raw-mode aqui (o Ink/composer gere a entrada em raw quando monta) — a restauração
 * é que GARANTE o raw-mode OFF na saída. Best-effort: stream fechado ⇒ silêncio (não
 * derruba o boot). Só deve ser chamado quando o caller confirmou TTY + piso (run.tsx).
 */
export function enterAltScreen(stream: AltScreenStream): void {
  try {
    stream.write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}`);
  } catch {
    /* stream fechado — nada a fazer; nunca derruba o boot */
  }
}

/** O controlador de alt-screen de UMA sessão de cockpit (estado encapsulado + idempotência). */
export interface AltScreenSession {
  /**
   * A restauração ÚNICA IDEMPOTENTE: emite `?1049l` + `?25h` (cursor visível) e tenta
   * sair de raw-mode. Chamar 2× (sinal + exit, ou exit + dispose) é INÓCUO — só o 1º
   * escreve os bytes. É o GATE de robustez do ADR-0076 §2.
   */
  restoreScreen(): void;
  /**
   * Solta os handlers de process (sem vazar listener entre sessões) e GARANTE uma
   * última restauração. Idempotente. Chamado no caminho de saída LIMPA (toggle de volta
   * ao inline, unmount normal) — os handlers de sinal/crash já não são mais necessários.
   */
  dispose(): void;
}

/**
 * Cria o controlador de alt-screen e REGISTRA a restauração em TODO caminho de término
 * (exit/SIGINT/SIGTERM/uncaughtException/unhandledRejection). É a ÚNICA fonte de
 * restauração (ADR-0076 §2): nenhum `process.exit`/throw escapa sem passar por
 * `restoreScreen`.
 *
 * Em SIGINT/SIGTERM, após restaurar, NÃO engolimos o sinal: re-emitimos o término p/ o
 * processo de fato encerrar (o Ink instala o próprio handler de SIGINT/`exitOnCtrlC`
 * que desmonta; aqui garantimos que a TELA volta ANTES do encerramento). Em
 * uncaughtException/unhandledRejection, restauramos e RE-LANÇAMOS (re-throw via
 * process.exit(1)) p/ o crash não ser silenciado — mas a tela já está limpa.
 *
 * `proc` e `stream` são injetáveis (teste sem mexer no process real). Em prod:
 * `registerRestoreHandlers(process.stdout, process)`.
 */
export function registerRestoreHandlers(
  stream: AltScreenStream,
  proc: ProcessLike,
): AltScreenSession {
  let restored = false;
  let disposed = false;

  const restoreScreen = (): void => {
    if (restored) return; // IDEMPOTENTE: 2ª chamada (sinal + exit) é inócua.
    restored = true;
    // raw-mode OFF no STDIN (best-effort): é o stdin que tem o raw-mode do Ink/prompt,
    // não o stdout. Sem isto, um crash antes do cleanup do Ink deixa o stdin em raw-mode
    // e bloqueia TODOS os terminais que partilham o mesmo conhost (Windows/Cmder).
    try {
      const stdin =
        (
          proc as {
            stdin?: { isTTY?: boolean; setRawMode?: (b: boolean) => void; pause?: () => void };
          }
        ).stdin ??
        (
          globalThis as {
            process?: {
              stdin?: { isTTY?: boolean; setRawMode?: (b: boolean) => void; pause?: () => void };
            };
          }
        ).process?.stdin;
      if (stdin?.isTTY === true) {
        stdin.setRawMode?.(false);
        stdin.pause?.();
      }
    } catch {
      /* best-effort — stdin pode já estar fechado */
    }
    // raw-mode no stdout (legacy — streams que expõem setRawMode no stdout).
    try {
      if (stream.isTTY === true) stream.setRawMode?.(false);
    } catch {
      /* setRawMode pode lançar em stream fechado — segue p/ os bytes de tela */
    }
    // `?1049l` (tela primária + scrollback) + `?25h` (cursor visível). UM write.
    // GUARDADO por `isTTY`: estes bytes de controle SÓ fazem sentido num terminal.
    // Sem o guard, num caminho NÃO-TTY (headless `-p`, stdout em pipe) eles VAZAM no
    // stream de dados e poluem a saída limpa do headless (regressão EST-1007 — o
    // `registerRestoreHandlers` passou a armar antes do splash, inclusive no headless).
    try {
      if (stream.isTTY === true) stream.write(`${LEAVE_ALT_SCREEN}${SHOW_CURSOR}`);
    } catch {
      /* stream fechado no exit — nada a fazer; o terminal já está sendo desmontado */
    }
  };

  // Handler que restaura E propaga o término (sinais/crash). Para `exit`, só restaura
  // (o processo já está saindo — não há o que propagar). Listeners nomeados p/ poder
  // removê-los no dispose (sem vazar entre sessões).
  const onExit = (): void => restoreScreen();
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => (): void => {
    restoreScreen();
    // re-emite o término: solta NOSSO handler e re-mata o processo com o sinal, p/ o
    // código de saída/efeito do sinal ser o esperado (o Ink também desmonta no SIGINT).
    cleanupListeners();
    try {
      (proc as unknown as { kill?: (pid: number, sig: string) => void }).kill?.(
        (proc as unknown as { pid?: number }).pid ?? 0,
        signal,
      );
    } catch {
      /* sem kill (proc fake/teste) — a restauração já rodou; segue */
    }
  };
  const onCrash = (err: unknown): void => {
    restoreScreen();
    cleanupListeners();
    // Re-lança no próximo tick p/ o crash NÃO ser silenciado (tela já limpa). Usa o
    // `nextTick` do `proc` injetado (teste/prod) e cai no `process.nextTick` real, ou no
    // throw direto se nenhum existir (teste fake sem nextTick ⇒ capturável).
    const fail = (): never => {
      throw err instanceof Error ? err : new Error(String(err));
    };
    const nt =
      (proc as { nextTick?: (cb: () => void) => void }).nextTick ??
      (globalThis as { process?: { nextTick?: (cb: () => void) => void } }).process?.nextTick;
    if (typeof nt === 'function') nt(fail);
    else fail();
  };

  const onSigint = onSignal('SIGINT');
  const onSigterm = onSignal('SIGTERM');

  const byEvent: Record<RestoreEvent, (...a: unknown[]) => void> = {
    exit: onExit as (...a: unknown[]) => void,
    SIGINT: onSigint as (...a: unknown[]) => void,
    SIGTERM: onSigterm as (...a: unknown[]) => void,
    uncaughtException: onCrash as (...a: unknown[]) => void,
    unhandledRejection: onCrash as (...a: unknown[]) => void,
  };
  // Deriva a lista de [evento, handler] de RESTORE_EVENTS (fonte única — ADR-0076 §2).
  const handlers: Array<[RestoreEvent, (...a: unknown[]) => void]> = RESTORE_EVENTS.map((event) => [
    event,
    byEvent[event],
  ]);

  let listenersAttached = true;
  const cleanupListeners = (): void => {
    if (!listenersAttached) return;
    listenersAttached = false;
    for (const [event, listener] of handlers) {
      try {
        proc.removeListener(event, listener);
      } catch {
        /* best-effort */
      }
    }
  };

  for (const [event, listener] of handlers) {
    proc.on(event, listener);
  }

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cleanupListeners();
    // saída LIMPA: garante a restauração final (idempotente — no-op se já restaurou).
    restoreScreen();
  };

  return { restoreScreen, dispose };
}
