// EST-MON-5 · ADR-0079 — Testes do MonitorStore: arm/cancel/list/size/cancelAll,
// limite de monitores, genId injetável, e integração com ProcessWaitTrigger
// (schedule/kill fakes) verificando que o evento entra na queue ao disparar.

import { describe, it, expect, vi } from 'vitest';
import { MonitorStore, EventQueue } from '../../../src/agent/index.js';
import type { MonitorEvent } from '../../../src/agent/monitor/event-queue.js';

// ─────────────────────────── helpers ───────────────────────────

/** Cria uma queue + now fake para os testes. */
function makeFixture() {
  const queue = new EventQueue();
  const now = () => '2025-01-01T00:00:00.000Z';
  return { queue, now };
}

/**
 * Retorna um trio de fakes para schedule/clear/kill que NÃO disparam
 * automaticamente — o teste controla o timer manualmente.
 */
function makeManualTimer() {
  let cb: (() => void) | null = null;
  let handle = 0;

  const schedule = vi.fn((fn: () => void) => {
    cb = fn;
    handle += 1;
    return handle;
  });

  const clear = vi.fn(() => {
    cb = null;
  });

  const kill = vi.fn(() => {
    // default: processo existe (não lança)
  });

  /** Dispara o callback agendado (simula o timer batendo). */
  function tick(): void {
    cb?.();
  }

  return { schedule, clear, kill, tick };
}

// ─────────────────────────── testes ───────────────────────────

describe('MonitorStore', () => {
  describe('arm / list / size', () => {
    it('arma um process-wait e retorna monitorId', () => {
      const { queue, now } = makeFixture();
      const { schedule, clear, kill } = makeManualTimer();
      const store = new MonitorStore();

      const id = store.arm({
        type: 'process-wait',
        label: 'meu-processo',
        pid: 9999,
        queue,
        now,
        schedule,
        clear,
        kill,
      });

      expect(id).toBe('mon-1');
      expect(store.size()).toBe(1);
      expect(store.list()).toEqual([
        { monitorId: 'mon-1', label: 'meu-processo', type: 'process-wait' },
      ]);
    });

    it('genId injetado produz ids determinísticos', () => {
      const { queue, now } = makeFixture();
      const { schedule, clear, kill } = makeManualTimer();
      let seq = 0;
      const store = new MonitorStore({ genId: () => `custom-${++seq}` });

      const id1 = store.arm({
        type: 'process-wait',
        label: 'a',
        pid: 1,
        queue,
        now,
        schedule,
        clear,
        kill,
      });
      const id2 = store.arm({
        type: 'process-wait',
        label: 'b',
        pid: 2,
        queue,
        now,
        schedule,
        clear,
        kill,
      });

      expect(id1).toBe('custom-1');
      expect(id2).toBe('custom-2');
      expect(store.size()).toBe(2);
    });
  });

  describe('disparo do trigger (process-wait)', () => {
    it('quando o PID morre, o evento entra na queue', () => {
      const { queue, now } = makeFixture();
      const { schedule, clear, kill, tick } = makeManualTimer();

      const store = new MonitorStore();
      const id = store.arm({
        type: 'process-wait',
        label: 'espera-pid',
        pid: 42,
        queue,
        now,
        schedule,
        clear,
        kill,
      });

      // Antes de disparar: fila vazia
      expect(queue.pending()).toBe(0);

      // Simula o PID morrer: kill(42, 0) lança → trigger enfileira
      kill.mockImplementation(() => {
        throw new Error('ESRCH');
      });
      tick();

      // Fila tem 1 evento
      expect(queue.pending()).toBe(1);
      const events = queue.drain();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        monitorId: id,
        label: 'espera-pid',
        type: 'process-wait',
        condition: 'PID encerrou',
        payload: 'pid 42',
        firedAt: '2025-01-01T00:00:00.000Z',
      } satisfies Partial<MonitorEvent>);

      // ONE-SHOT: o trigger disparou e PAROU sozinho (_fired=true), mas o STORE ainda
      // mantém o monitor no map — o store só remove no `cancel()` explícito. Então size
      // continua 1 (limpar monitores one-shot já disparados é refinamento follow-up).
      expect(store.size()).toBe(1);
    });
  });

  describe('cancel', () => {
    it('cancela um monitor ativo e retorna true', () => {
      const { queue, now } = makeFixture();
      const { schedule, clear, kill } = makeManualTimer();
      const store = new MonitorStore();

      const id = store.arm({
        type: 'process-wait',
        label: 'cancelavel',
        pid: 100,
        queue,
        now,
        schedule,
        clear,
        kill,
      });

      expect(store.size()).toBe(1);

      const removed = store.cancel(id);
      expect(removed).toBe(true);
      expect(store.size()).toBe(0);
      expect(store.list()).toEqual([]);
      // clear foi chamado (trigger.stop)
      expect(clear).toHaveBeenCalled();
    });

    it('retorna false para id inexistente', () => {
      const store = new MonitorStore();
      expect(store.cancel('nao-existe')).toBe(false);
    });
  });

  describe('cancelAll', () => {
    it('para todos os monitores e limpa o map', () => {
      const { queue, now } = makeFixture();
      const { schedule: s1, clear: c1, kill: k1 } = makeManualTimer();
      const { schedule: s2, clear: c2, kill: k2 } = makeManualTimer();
      const store = new MonitorStore();

      store.arm({
        type: 'process-wait',
        label: 'a',
        pid: 1,
        queue,
        now,
        schedule: s1,
        clear: c1,
        kill: k1,
      });
      store.arm({
        type: 'process-wait',
        label: 'b',
        pid: 2,
        queue,
        now,
        schedule: s2,
        clear: c2,
        kill: k2,
      });

      expect(store.size()).toBe(2);

      store.cancelAll();

      expect(store.size()).toBe(0);
      expect(c1).toHaveBeenCalled();
      expect(c2).toHaveBeenCalled();
    });
  });

  describe('limite de monitores (cap)', () => {
    it('lança erro ao exceder maxMonitors', () => {
      const { queue, now } = makeFixture();
      const { schedule, clear, kill } = makeManualTimer();
      const store = new MonitorStore({ maxMonitors: 2 });

      store.arm({ type: 'process-wait', label: 'a', pid: 1, queue, now, schedule, clear, kill });
      store.arm({ type: 'process-wait', label: 'b', pid: 2, queue, now, schedule, clear, kill });

      expect(() =>
        store.arm({ type: 'process-wait', label: 'c', pid: 3, queue, now, schedule, clear, kill }),
      ).toThrow('limite de monitores (2)');
    });

    it('maxMonitors default é 10', () => {
      const { queue, now } = makeFixture();
      const { schedule, clear, kill } = makeManualTimer();
      const store = new MonitorStore();

      // Arma 10 monitores — deve funcionar
      for (let i = 0; i < 10; i++) {
        store.arm({
          type: 'process-wait',
          label: `m${i}`,
          pid: i,
          queue,
          now,
          schedule,
          clear,
          kill,
        });
      }
      expect(store.size()).toBe(10);

      // O 11º lança
      expect(() =>
        store.arm({
          type: 'process-wait',
          label: 'overflow',
          pid: 99,
          queue,
          now,
          schedule,
          clear,
          kill,
        }),
      ).toThrow('limite de monitores (10)');
    });
  });
});
