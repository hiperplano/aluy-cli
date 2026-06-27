// EST — anti-flicker: THROTTLE de flush do streaming. Sem isto, cada token do
// stream dispara um `patch()` → notifica os observers → re-render do Ink. Num
// stream rápido isso é dezenas de re-renders por segundo da REGIÃO VIVA — supérfluo
// (o olho não lê char-a-char) e cúmplice do tremor. Aqui acumulamos as mudanças e
// damos UM flush por janela (~`intervalMs`), como um requestAnimationFrame.
//
// Contrato: `request()` agenda um flush (no máx. 1 por janela); `flushNow()` força
// o flush pendente imediatamente (usado no fim do turno / transições de fase, p/
// nunca "engolir" o último token); `cancel()` limpa o timer (desmontar/abortar).
// PURO quanto a tempo: o timer é injetável (`schedule`/`clear`) p/ teste sem relógio.

/** Janela default de flush (ms). ~40ms ⇒ ~25fps: suave, sem tremor. */
export const DEFAULT_FLUSH_MS = 40;

export interface FlushThrottleOptions {
  /** Janela entre flushes (ms). Default `DEFAULT_FLUSH_MS`. */
  readonly intervalMs?: number;
  /** Agenda um callback após `ms` (injetável p/ teste). Default `setTimeout`. */
  readonly schedule?: (cb: () => void, ms: number) => unknown;
  /** Cancela um agendamento (injetável p/ teste). Default `clearTimeout`. */
  readonly clear?: (handle: unknown) => void;
}

/**
 * Coalescedor de flushes: chame `request()` a cada token; o `onFlush` roda no
 * máximo 1×/janela. `flushNow()` esvazia na hora se há flush pendente.
 */
export class FlushThrottle {
  private readonly intervalMs: number;
  private readonly schedule: (cb: () => void, ms: number) => unknown;
  private readonly clear: (handle: unknown) => void;
  private handle: unknown = null;
  private pending = false;

  constructor(
    private readonly onFlush: () => void,
    opts: FlushThrottleOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_FLUSH_MS;
    this.schedule = opts.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    this.clear = opts.clear ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Marca que há mudança a publicar; agenda um flush se ainda não houver um. */
  request(): void {
    this.pending = true;
    if (this.handle !== null) return;
    this.handle = this.schedule(() => {
      this.handle = null;
      if (this.pending) this.flushNow();
    }, this.intervalMs);
  }

  /** Esvazia AGORA o flush pendente (fim de turno / transição). No-op se nada pende. */
  flushNow(): void {
    if (!this.pending) return;
    this.pending = false;
    this.onFlush();
  }

  /** Cancela o timer pendente sem flush (desmontar / abortar). */
  cancel(): void {
    if (this.handle !== null) {
      this.clear(this.handle);
      this.handle = null;
    }
    this.pending = false;
  }
}
