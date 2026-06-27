// Anti-flicker (DoD) — o THROTTLE de flush limita a FREQUÊNCIA de notificação do
// stream: muitos `request()` (um por token) ⇒ no máx. 1 flush por janela. Timer
// FAKE injetado (sem relógio real) p/ ser determinístico.

import { describe, expect, it } from 'vitest';
import { FlushThrottle } from '../../src/session/flush-throttle.js';

/** Relógio fake: agenda callbacks e os dispara em ordem com `tick()`. */
function fakeClock() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    schedule(cb: () => void): number {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    clear(id: unknown): void {
      pending.delete(id as number);
    },
    /** Dispara TODOS os callbacks agendados (uma "virada" de janela). */
    tick(): void {
      const cbs = [...pending.values()];
      pending.clear();
      for (const cb of cbs) cb();
    },
    get size(): number {
      return pending.size;
    },
  };
}

function makeThrottle() {
  const clock = fakeClock();
  let flushes = 0;
  const t = new FlushThrottle(() => flushes++, {
    schedule: (cb) => clock.schedule(cb),
    clear: (h) => clock.clear(h),
  });
  return { t, clock, flushes: () => flushes };
}

describe('FlushThrottle — coalesce de flushes do stream', () => {
  it('N requests numa janela ⇒ UM flush (não N)', () => {
    const { t, clock, flushes } = makeThrottle();
    for (let i = 0; i < 50; i++) t.request(); // 50 "tokens"
    expect(flushes()).toBe(0); // nada flushou ainda (agendado)
    clock.tick(); // vira a janela
    expect(flushes()).toBe(1); // UM flush p/ os 50 tokens
  });

  it('requests em janelas diferentes ⇒ um flush por janela', () => {
    const { t, clock, flushes } = makeThrottle();
    t.request();
    t.request();
    clock.tick();
    expect(flushes()).toBe(1);
    t.request();
    t.request();
    t.request();
    clock.tick();
    expect(flushes()).toBe(2);
  });

  it('flushNow() esvazia o pendente na hora (fim de turno não atrasa o último token)', () => {
    const { t, flushes } = makeThrottle();
    t.request();
    t.flushNow();
    expect(flushes()).toBe(1);
    // flushNow sem pendência é no-op
    t.flushNow();
    expect(flushes()).toBe(1);
  });

  it('cancel() descarta o pendente sem flush (desmontar/abortar)', () => {
    const { t, clock, flushes } = makeThrottle();
    t.request();
    t.cancel();
    clock.tick();
    expect(flushes()).toBe(0);
  });

  it('sem request, a virada da janela não flusha (nada pendente)', () => {
    const { clock, flushes } = makeThrottle();
    clock.tick();
    expect(flushes()).toBe(0);
  });
});
