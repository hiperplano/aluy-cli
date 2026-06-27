// EST-0948 · CLI-SEC-3/9 — o AskResolver concreto da TUI (cravada do `seguranca`).
//
// Implementa o `AskResolver` do core (EST-0945): o loop chama `resolve()` quando
// o veredito é `ask`, e ESTE objeto pergunta ao usuário no terminal. Como o I/O
// é assíncrono e dirigido por eventos (Ink/useInput), o resolver usa um padrão de
// CONTROLADOR: `resolve()` publica o `AskRequest` pendente (a UI o renderiza via
// AskDialog) e devolve uma Promise que a UI resolve quando o usuário tecla.
//
// FAIL-SAFE (cravas, não-negociáveis):
//   - TIMEOUT ⇒ resolve `deny`. Nunca executa por inação (CLI-SEC-9).
//   - ABORT (Ctrl-C / signal) ⇒ resolve `deny`. Nunca executa por cancelamento.
//   - Default em QUALQUER caminho ambíguo ⇒ `deny`. Aprovar exige tecla EXPLÍCITA.
//
// REGRA de escopo (CLI-SEC-3): "sempre nesta sessão" (`approve-session`) SÓ é
// ofertável quando `req.alwaysAsk === false`. Mesmo que a UI mande
// `approve-session` p/ um sempre-ask (não deveria — o AskDialog esconde `[s]`),
// o resolver o REBAIXA para `approve-once` (defesa em profundidade — a TUI não
// contorna a engine). A engine ainda recusa o grant (grantSession devolve false).

import type { AskRequest, AskResolution, AskResolver } from '@aluy/cli-core';

/** Estado de uma confirmação pendente, observável pela UI. */
export interface PendingAskEntry {
  readonly request: AskRequest;
  /** A UI chama isto p/ resolver a confirmação (uma única vez). */
  resolve(resolution: AskResolution): void;
}

/** Observador da fila de asks (a App subscreve p/ re-renderizar). */
export type AskObserver = (pending: PendingAskEntry | null) => void;

export interface TuiAskResolverOptions {
  /**
   * Timeout (ms) p/ uma confirmação sem resposta ⇒ deny (fail-safe anti-hang).
   * `undefined`/0 ⇒ sem timeout por tempo (mas abort/Ctrl-C ainda nega).
   */
  readonly timeoutMs?: number;
  /** Relógio injetável (testes). Default: setTimeout/clearTimeout reais. */
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}

/**
 * O resolver concreto. Liga o loop (que chama `resolve`) à UI (que observa o
 * `pending` e chama `entry.resolve(...)`). Uma confirmação por vez (o loop é
 * sequencial; o box de ask captura o foco — handoff §10 regra 3).
 */
export class TuiAskResolver implements AskResolver {
  private observer: AskObserver | null = null;
  private current: PendingAskEntry | null = null;
  private readonly timeoutMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  // EST-0958 — modo NÃO-INTERATIVO (sem TTY/piped/CI): NÃO há UI p/ responder o ask,
  // então `resolve` NEGA de imediato (fail-safe "deny por inação" — nunca executa por
  // falta de resposta, nunca pendura o processo). Ligado pelo `runSession` quando não
  // há TTY. Vale p/ o ask do agente E do `!comando` (mesma catraca, mesmo fail-safe).
  private nonInteractive = false;

  constructor(opts: TuiAskResolverOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 0;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  }

  /**
   * EST-0958 — marca a sessão como NÃO-INTERATIVA (sem TTY). A partir daí todo ask
   * é NEGADO de imediato (deny por inação) em vez de aguardar uma UI que não existe —
   * impede o hang do piped/CI e mantém a catraca (efeito não-aprovado não roda).
   */
  setNonInteractive(on: boolean): void {
    this.nonInteractive = on;
  }

  /** A UI registra-se p/ observar a confirmação pendente. */
  subscribe(observer: AskObserver): void {
    this.observer = observer;
    observer(this.current);
  }

  /** A confirmação pendente atual (p/ render/teste). */
  get pending(): PendingAskEntry | null {
    return this.current;
  }

  /**
   * Invocado pelo loop (EST-0944) quando o veredito é `ask`. Publica o request e
   * aguarda a escolha do usuário. FAIL-SAFE: timeout E abort ⇒ `deny`.
   */
  resolve(request: AskRequest, signal?: AbortSignal): Promise<AskResolution> {
    // EST-0958 — sem TTY (não-interativo) ⇒ deny imediato: não há UI p/ aprovar e o
    // fail-safe é NUNCA executar por inação (CLI-SEC-9). Evita o hang do piped/CI.
    if (this.nonInteractive) {
      return Promise.resolve(deny('sessão não-interativa (sem TTY) — aprovação indisponível'));
    }
    // Já abortado antes de começar ⇒ deny imediato (nunca executa por inação).
    if (signal?.aborted) {
      return Promise.resolve(deny('cancelado antes da confirmação'));
    }

    return new Promise<AskResolution>((resolvePromise) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (resolution: AskResolution): void => {
        if (settled) return;
        settled = true;
        if (timer) this.clearTimeoutFn(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        this.current = null;
        this.notify();
        resolvePromise(resolution);
      };

      const onAbort = (): void => {
        // Ctrl-C/abort durante a confirmação ⇒ DENY (fail-safe). Nunca executa.
        settle(deny('confirmação cancelada (abort/Ctrl-C)'));
      };

      // A UI chama isto. Sanitiza a escolha (defesa em profundidade vs sempre-ask).
      const userResolve = (resolution: AskResolution): void => {
        settle(sanitize(resolution, request));
      };

      this.current = { request, resolve: userResolve };

      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      if (this.timeoutMs > 0) {
        timer = this.setTimeoutFn(() => {
          // Timeout sem resposta ⇒ DENY (fail-safe anti-hang).
          settle(deny('confirmação expirou sem resposta'));
        }, this.timeoutMs);
        // Não segurar o event loop por causa do timer.
        (timer as { unref?: () => void }).unref?.();
      }

      this.notify();
    });
  }

  private notify(): void {
    this.observer?.(this.current);
  }
}

function deny(reason: string): AskResolution {
  return { kind: 'deny', reason };
}

/**
 * Sanitiza a resolução vinda da UI. `approve-session` p/ um sempre-ask é
 * REBAIXADO a `approve-once` (CLI-SEC-3: a TUI não contorna a engine). Tudo o
 * mais passa como veio.
 */
function sanitize(resolution: AskResolution, request: AskRequest): AskResolution {
  if (resolution.kind === 'approve-session' && request.alwaysAsk === true) {
    return { kind: 'approve-once' };
  }
  return resolution;
}
