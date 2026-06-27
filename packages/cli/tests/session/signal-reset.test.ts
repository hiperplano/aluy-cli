// EST-1010 (BUG-0022) — ciclo de vida dos handlers de SINAL de reset de terminal:
// `installSignalReset` adiciona EXATAMENTE um SIGINT + um SIGTERM e o `dispose()` os
// remove (idempotente). Re-instalar/dispor N vezes NÃO acumula listeners (a leak
// que o fix fecha). O callback de reset AINDA dispara no sinal (Ctrl-C funciona).
//
// Usa um `process` FAKE (sem tocar o real) p/ contar listeners de forma determinística.

import { describe, expect, it, vi } from 'vitest';
import { installSignalReset, type SignalProcessLike } from '../../src/session/signal-reset.js';

/** Process fake: mapa de listeners por sinal, com emit p/ disparar à mão. */
function fakeProcess(): SignalProcessLike & {
  count: (sig: 'SIGINT' | 'SIGTERM') => number;
  emit: (sig: 'SIGINT' | 'SIGTERM') => void;
} {
  const map = new Map<string, Array<() => void>>();
  return {
    on(event, listener) {
      const arr = map.get(event) ?? [];
      arr.push(listener);
      map.set(event, arr);
      return this;
    },
    removeListener(event, listener) {
      const arr = map.get(event) ?? [];
      map.set(
        event,
        arr.filter((l) => l !== listener),
      );
      return this;
    },
    count: (sig) => (map.get(sig) ?? []).length,
    emit: (sig) => {
      for (const l of [...(map.get(sig) ?? [])]) l();
    },
  };
}

describe('installSignalReset — ciclo de vida (EST-1010 BUG-0022)', () => {
  it('instala EXATAMENTE um SIGINT + um SIGTERM e dispose remove ambos', () => {
    const p = fakeProcess();
    expect(p.count('SIGINT')).toBe(0);
    expect(p.count('SIGTERM')).toBe(0);

    const h = installSignalReset(p, () => {});
    expect(p.count('SIGINT')).toBe(1);
    expect(p.count('SIGTERM')).toBe(1);

    h.dispose();
    expect(p.count('SIGINT')).toBe(0);
    expect(p.count('SIGTERM')).toBe(0);
  });

  it('NÃO vaza em re-entrância: install+dispose N vezes mantém a contagem em ZERO', () => {
    const p = fakeProcess();
    // simula um harness que chama runSession várias vezes (a leak original).
    for (let i = 0; i < 10; i++) {
      const h = installSignalReset(p, () => {});
      h.dispose();
    }
    expect(p.count('SIGINT')).toBe(0);
    expect(p.count('SIGTERM')).toBe(0);
  });

  it('dispose é IDEMPOTENTE — chamar 2× não remove listeners de outra instância', () => {
    const p = fakeProcess();
    const a = installSignalReset(p, () => {});
    const b = installSignalReset(p, () => {});
    expect(p.count('SIGINT')).toBe(2);

    a.dispose();
    a.dispose(); // 2ª chamada é no-op — NÃO toca o listener de `b`.
    expect(p.count('SIGINT')).toBe(1); // só o de `b` ficou
    expect(p.count('SIGTERM')).toBe(1);

    b.dispose();
    expect(p.count('SIGINT')).toBe(0);
  });

  it('o callback de reset AINDA dispara no sinal (Ctrl-C/SIGTERM continuam funcionando)', () => {
    const p = fakeProcess();
    const onSignal = vi.fn();
    const h = installSignalReset(p, onSignal);

    p.emit('SIGINT');
    expect(onSignal).toHaveBeenCalledTimes(1);
    p.emit('SIGTERM');
    expect(onSignal).toHaveBeenCalledTimes(2);

    // após dispose, o sinal não chama mais (não há listener pendurado).
    h.dispose();
    p.emit('SIGINT');
    expect(onSignal).toHaveBeenCalledTimes(2);
  });
});
