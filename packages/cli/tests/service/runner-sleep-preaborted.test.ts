// ADR-0158 §5 — `sleepUntil` (PURA o bastante — sem I/O externo, só timer): o guard
// `if (stop.aborted) return 'stopped';` NO TOPO do laço (antes de calcular a
// primeira fatia) nunca era exercitado por `runner-sleep.test.ts` (arquivo alheio,
// NÃO editado aqui) — todos os cenários de lá abortam DEPOIS de a espera já ter
// começado. Aqui o `stop` já chega ABORTADO — a função tem que devolver "stopped"
// na hora, sem nunca chamar `setTimeout`.
import { describe, expect, it, vi } from 'vitest';
import { sleepUntil } from '../../src/service/runner.js';

describe('sleepUntil — `stop` JÁ abortado ANTES da chamada ⇒ "stopped" imediato, nenhum timer agendado', () => {
  it('devolve "stopped" sem nunca chamar setTimeout (o guard do topo do laço, não o de dentro de sleepOnce)', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const stop = new AbortController();
      stop.abort(); // já abortado ANTES de `sleepUntil` sequer começar.
      const target = new Date(Date.now() + 60_000);

      const outcome = await sleepUntil(target, stop.signal);

      expect(outcome).toBe('stopped');
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
