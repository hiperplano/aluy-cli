// EST-MON-6 — eviction de monitores MORTOS no MonitorStore: sem reuso, o cap viraria DoS
// auto-infligido numa sessão longa (process-wait one-shot dispara mas ficava no store).
// Mesma classe "recurso sem teto" (EST-1011) que mordeu as salas (#221).

import { describe, it, expect, vi } from 'vitest';
import { MonitorStore, EventQueue } from '../../../src/agent/index.js';

function manualTimer() {
  let cb: (() => void) | null = null;
  const schedule = vi.fn((fn: () => void) => {
    cb = fn;
    return 1;
  });
  const clear = vi.fn(() => {
    cb = null;
  });
  const kill = vi.fn(() => {}); // vivo por default
  return { schedule, clear, kill, tick: () => cb?.() };
}

function armPW(
  store: MonitorStore,
  queue: EventQueue,
  label: string,
  t: ReturnType<typeof manualTimer>,
) {
  return store.arm({
    type: 'process-wait',
    label,
    pid: 1,
    queue,
    now: () => 'T',
    schedule: t.schedule,
    clear: t.clear,
    kill: t.kill,
  });
}

function die(t: ReturnType<typeof manualTimer>) {
  t.kill.mockImplementation(() => {
    throw new Error('ESRCH');
  });
  t.tick(); // o poll vê o PID morto → enfileira + para (running=false)
}

describe('MonitorStore — eviction de monitores mortos (EST-MON-6)', () => {
  it('process-wait que disparou (running=false) é evictado por evictDead', () => {
    const queue = new EventQueue();
    const store = new MonitorStore();
    const t = manualTimer();
    armPW(store, queue, 'pw', t);
    expect(store.size()).toBe(1);
    die(t);
    expect(queue.pending()).toBe(1); // disparou
    expect(store.evictDead()).toBe(1); // morto → evictado
    expect(store.size()).toBe(0);
  });

  it('arm acima do cap com monitores MORTOS NÃO lança (evicta antes)', () => {
    const queue = new EventQueue();
    const store = new MonitorStore({ maxMonitors: 2 });
    const t1 = manualTimer();
    const t2 = manualTimer();
    armPW(store, queue, 'a', t1);
    armPW(store, queue, 'b', t2);
    die(t1);
    die(t2);
    // o 3º arm NÃO lança — evicta os 2 mortos antes de checar o teto.
    const t3 = manualTimer();
    expect(() => armPW(store, queue, 'c', t3)).not.toThrow();
    expect(store.size()).toBe(1);
  });

  it('arm acima do cap com monitores VIVOS ainda lança (cap real respeitado)', () => {
    const queue = new EventQueue();
    const store = new MonitorStore({ maxMonitors: 2 });
    armPW(store, queue, 'a', manualTimer());
    armPW(store, queue, 'b', manualTimer());
    // ambos vivos (não dispararam) ⇒ nada a evictar ⇒ o cap morde.
    expect(() => armPW(store, queue, 'c', manualTimer())).toThrow(/limite de monitores/);
  });
});
