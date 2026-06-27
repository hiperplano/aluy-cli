// EST-1110 · ADR-0114 — o QuestionPort concreto da TUI (espelha o TuiAskResolver da
// EST-0948, mas para PERGUNTA, não permissão).
//
// Implementa o `QuestionPort` do core: a tool `perguntar` chama `ask(spec)`, e ESTE
// objeto pergunta ao usuário no terminal. Como o I/O é assíncrono e dirigido por
// eventos (Ink/useInput), usa o padrão CONTROLADOR: `ask()` publica a pergunta pendente
// (a UI a renderiza via <QuestionDialog>) e devolve uma Promise que a UI resolve quando
// o usuário confirma.
//
// FAIL-SAFE NÃO-PENDURA (ADR-0114 §4 — distinto do ask de permissão):
//   - NÃO-INTERATIVO (sem TTY/-p/piped) ⇒ resolve `{ kind:'unavailable' }` NA HORA (não
//     há UI; o processo NUNCA pendura). A tool converte isso em erro acionável.
//   - ABORT (Ctrl-C/signal) ⇒ resolve `{ kind:'unavailable' }`. (≠ ask: não há "deny" a
//     dar — uma pergunta cancelada simplesmente não foi respondida.)
//   - SEM timeout por tempo aqui: uma pergunta pode esperar o usuário pensar. O abort
//     (esc/Ctrl-C) é a saída; o controller também a cancela ao encerrar o turno.

import type { QuestionAnswer, QuestionPort, QuestionSpec } from '@aluy/cli-core';

/** Estado de uma pergunta pendente, observável pela UI. */
export interface PendingQuestionEntry {
  readonly spec: QuestionSpec;
  /** A UI chama isto p/ resolver a pergunta (uma única vez). */
  resolve(answer: QuestionAnswer): void;
}

/** Observador da pergunta pendente (a App subscreve p/ re-renderizar). */
export type QuestionObserver = (pending: PendingQuestionEntry | null) => void;

/**
 * O resolver concreto. Liga a tool (que chama `ask`) à UI (que observa o `pending` e
 * chama `entry.resolve(...)`). Uma pergunta por vez (o loop é sequencial; o box de
 * pergunta captura o foco — mesmo handoff do ask).
 */
export class TuiQuestionResolver implements QuestionPort {
  private observer: QuestionObserver | null = null;
  private current: PendingQuestionEntry | null = null;
  // Modo NÃO-INTERATIVO (sem TTY/piped/CI): NÃO há UI p/ responder, então `ask` resolve
  // `unavailable` de imediato (fail-safe não-pendura). Ligado pelo `runSession` quando
  // não há TTY — espelha o `setNonInteractive` do TuiAskResolver.
  private nonInteractive = false;

  /**
   * Marca a sessão como NÃO-INTERATIVA (sem TTY). A partir daí toda pergunta resolve
   * `unavailable` de imediato em vez de aguardar uma UI que não existe.
   */
  setNonInteractive(on: boolean): void {
    this.nonInteractive = on;
  }

  /** A UI registra-se p/ observar a pergunta pendente. */
  subscribe(observer: QuestionObserver): void {
    this.observer = observer;
    observer(this.current);
  }

  /** A pergunta pendente atual (p/ render/teste). */
  get pending(): PendingQuestionEntry | null {
    return this.current;
  }

  /**
   * Invocado pela tool `perguntar` (via `ports.question`). Publica o spec e aguarda a
   * resposta do usuário. FAIL-SAFE: não-interativo E abort ⇒ `unavailable` (nunca pendura).
   */
  ask(spec: QuestionSpec, signal?: AbortSignal): Promise<QuestionAnswer> {
    if (this.nonInteractive) {
      return Promise.resolve(unavailable('sessão não-interativa (sem terminal)'));
    }
    if (signal?.aborted) {
      return Promise.resolve(unavailable('cancelado antes da pergunta'));
    }

    return new Promise<QuestionAnswer>((resolvePromise) => {
      let settled = false;

      const settle = (answer: QuestionAnswer): void => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        this.current = null;
        this.notify();
        resolvePromise(answer);
      };

      const onAbort = (): void => {
        // Ctrl-C/abort durante a pergunta ⇒ unavailable (não foi respondida).
        settle(unavailable('pergunta cancelada (abort/Ctrl-C)'));
      };

      // A UI chama isto com a resposta escolhida.
      const userResolve = (answer: QuestionAnswer): void => settle(answer);

      this.current = { spec, resolve: userResolve };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.notify();
    });
  }

  private notify(): void {
    this.observer?.(this.current);
  }
}

function unavailable(reason: string): QuestionAnswer {
  return { kind: 'unavailable', reason };
}
