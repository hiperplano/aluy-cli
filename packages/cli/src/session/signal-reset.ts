// EST-1010 (BUG-0022) — ciclo de vida dos handlers de SINAL de RESET de terminal.
//
// O ramo TTY do `runSession` registra `SIGINT`/`SIGTERM` p/ soltar o frame-sync e
// RESETAR o fundo do terminal (OSC 11) se o processo for interrompido no meio de um
// frame. ANTES, o registro era `process.once(...)` cru e a remoção morava SÓ no
// `finally` do `waitUntilExit`: se o `render`/boot lançasse ANTES daquele `try`, ou
// se um harness chamasse `runSession` MAIS DE UMA VEZ (re-entrância de teste), os
// listeners VAZAVAM — acúmulo entre sessões e o aviso `MaxListenersExceededWarning`.
//
// Este helper centraliza o ciclo: `installSignalReset` adiciona EXATAMENTE um
// listener por sinal e devolve um `dispose()` IDEMPOTENTE que remove só os SEUS.
// O caller chama `dispose()` no `finally` (rede de segurança em TODA saída). NÃO
// engole o sinal: o Ink instala o próprio handler de SIGINT (exitOnCtrlC) que
// desmonta e encerra — aqui só rodamos o reset best-effort do terminal.
//
// PORTÁVEL? NÃO — é I/O de processo (sinais do SO), por isso mora no @aluy/cli.

/** Subconjunto do `process` que tocamos — injetável p/ teste (sem mexer no real). */
export interface SignalProcessLike {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** Solta os handlers instalados. Idempotente: chamar 2× remove UMA vez (no-op depois). */
export interface SignalResetHandle {
  dispose(): void;
}

/**
 * Instala `onSignal` em SIGINT e SIGTERM (um listener por sinal) e devolve o handle
 * de remoção. `onSignal` é best-effort (reset de terminal) e NÃO deve lançar — se
 * lançar, o erro não é engolido aqui (o caller/Node decide). O `dispose` removо
 * EXATAMENTE os listeners adicionados (não toca handlers de terceiros).
 */
export function installSignalReset(
  proc: SignalProcessLike,
  onSignal: () => void,
): SignalResetHandle {
  // `on` (não `once`): se um SIGINT chegar e o Ink NÃO encerrar (caso raro), um 2º
  // ainda dispara o reset. O `dispose` no `finally` garante que não vaza entre sessões.
  proc.on('SIGINT', onSignal);
  proc.on('SIGTERM', onSignal);
  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return; // idempotente — re-remoção é no-op.
      disposed = true;
      proc.removeListener('SIGINT', onSignal);
      proc.removeListener('SIGTERM', onSignal);
    },
  };
}
