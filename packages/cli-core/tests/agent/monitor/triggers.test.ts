// EST-MON-3 · EST-MON-4 · ADR-0079 — testes dos gatilhos file-watch + process-wait.
// Usa injeção de dependências (watch/kill/schedule/clear/now) para testar sem I/O real.

import { describe, it, expect, vi } from 'vitest';
import { EventQueue } from '../../../src/agent/monitor/event-queue.js';
import {
  FileWatchTrigger,
  ProcessWaitTrigger,
  CommandWaitTrigger,
} from '../../../src/agent/monitor/triggers.js';
import type { MonitorEvent } from '../../../src/agent/monitor/event-queue.js';

// ─────────────────────────── helpers ───────────────────────────

function fakeNow(): string {
  return '2025-01-01T00:00:00.000Z';
}

/** Cria um EventQueue + um array de eventos drenados (conveniência). */
function makeQueue() {
  const queue = new EventQueue();
  return { queue };
}

// ─────────────────────── FileWatchTrigger ───────────────────────

describe('FileWatchTrigger', () => {
  it('enfileira evento "file-watch" quando o callback de watch dispara (change)', () => {
    const { queue } = makeQueue();
    // watch fake que chama o callback com "change"
    const fakeWatch = vi.fn(
      (_path: string, listener: (eventType: string) => void): { close: () => void } => {
        // dispara o callback síncrono para testar
        listener('change');
        return { close: vi.fn() };
      },
    );

    const trigger = new FileWatchTrigger({
      monitorId: 'mon-file-1',
      label: 'test-file',
      path: '/fake/path/file.txt',
      queue,
      now: fakeNow,
      watch: fakeWatch as unknown as typeof import('node:fs').watch,
    });

    trigger.start();

    const events = queue.drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      monitorId: 'mon-file-1',
      label: 'test-file',
      type: 'file-watch',
      condition: 'modificado',
      payload: '/fake/path/file.txt',
      firedAt: '2025-01-01T00:00:00.000Z',
    } satisfies Partial<MonitorEvent>);
    expect(trigger.running).toBe(true);
    trigger.stop();
    expect(trigger.running).toBe(false);
  });

  it('enfileira com condition "criado/removido" quando eventType é rename', () => {
    const { queue } = makeQueue();
    const fakeWatch = vi.fn(
      (_path: string, listener: (eventType: string) => void): { close: () => void } => {
        listener('rename');
        return { close: vi.fn() };
      },
    );

    const trigger = new FileWatchTrigger({
      monitorId: 'mon-file-2',
      label: 'test-rename',
      path: '/fake/path/other.txt',
      queue,
      now: fakeNow,
      watch: fakeWatch as unknown as typeof import('node:fs').watch,
    });

    trigger.start();
    const events = queue.drain();
    expect(events).toHaveLength(1);
    expect(events[0].condition).toBe('criado/removido');
    trigger.stop();
  });

  it('não derruba se o path não existe (fs.watch lança)', () => {
    const { queue } = makeQueue();
    const fakeWatch = vi.fn(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const trigger = new FileWatchTrigger({
      monitorId: 'mon-file-3',
      label: 'test-enoent',
      path: '/fake/not-exists',
      queue,
      now: fakeNow,
      watch: fakeWatch as unknown as typeof import('node:fs').watch,
    });

    // Não deve lançar
    expect(() => trigger.start()).not.toThrow();
    expect(trigger.running).toBe(false);
    const events = queue.drain();
    expect(events).toHaveLength(0);
  });

  it('start() duplicado é noop', () => {
    const { queue } = makeQueue();
    let callCount = 0;
    const fakeWatch = vi.fn((): { close: () => void } => {
      callCount++;
      return { close: vi.fn() };
    });

    const trigger = new FileWatchTrigger({
      monitorId: 'mon-file-4',
      label: 'test-noop',
      path: '/fake/path/x.txt',
      queue,
      now: fakeNow,
      watch: fakeWatch as unknown as typeof import('node:fs').watch,
    });

    trigger.start();
    trigger.start(); // segundo start não deve abrir outro watcher
    expect(callCount).toBe(1);
    trigger.stop();
  });
});

// ────────────────────── ProcessWaitTrigger ──────────────────────

describe('ProcessWaitTrigger', () => {
  it('dispara evento "process-wait" quando o PID morre (one-shot)', () => {
    const { queue } = makeQueue();
    const fakeKill = vi.fn();

    // Relógio manual: schedule recebe callback e ms, executa sob demanda
    let scheduledCb: (() => void) | null = null;
    let clearCalled = false;

    const fakeSchedule = vi.fn((cb: () => void) => {
      scheduledCb = cb;
      return 'timer-1';
    });
    const fakeClear = vi.fn(() => {
      clearCalled = true;
    });

    const trigger = new ProcessWaitTrigger({
      monitorId: 'mon-proc-1',
      label: 'test-proc',
      pid: 9999,
      queue,
      now: fakeNow,
      intervalMs: 100,
      schedule: fakeSchedule,
      clear: fakeClear,
      kill: fakeKill,
    });

    trigger.start();
    expect(trigger.running).toBe(true);
    expect(scheduledCb).not.toBeNull();

    // Tick 1: processo vivo (kill não lança)
    fakeKill.mockImplementationOnce(() => {});
    scheduledCb!();
    expect(queue.drain()).toHaveLength(0); // nenhum evento ainda
    expect(trigger.fired).toBe(false);
    expect(clearCalled).toBe(false);

    // Tick 2: processo vivo de novo
    fakeKill.mockImplementationOnce(() => {});
    scheduledCb!();
    expect(queue.drain()).toHaveLength(0);
    expect(trigger.fired).toBe(false);

    // Tick 3: processo morre (kill lança)
    fakeKill.mockImplementationOnce(() => {
      throw new Error('ESRCH');
    });
    scheduledCb!();

    const events = queue.drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      monitorId: 'mon-proc-1',
      label: 'test-proc',
      type: 'process-wait',
      condition: 'PID encerrou',
      payload: 'pid 9999',
      firedAt: '2025-01-01T00:00:00.000Z',
    } satisfies Partial<MonitorEvent>);
    expect(trigger.fired).toBe(true);
    expect(trigger.running).toBe(false);
    // clear foi chamado (one-shot parou o timer)
    expect(clearCalled).toBe(true);
  });

  it('start() após fired é noop', () => {
    const { queue } = makeQueue();
    let scheduledCb: (() => void) | null = null;
    let scheduleCount = 0;

    const fakeKill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    const fakeSchedule = vi.fn((cb: () => void) => {
      scheduleCount++;
      scheduledCb = cb;
      return 'timer-2';
    });
    const fakeClear = vi.fn();

    const trigger = new ProcessWaitTrigger({
      monitorId: 'mon-proc-2',
      label: 'test-noop-fired',
      pid: 8888,
      queue,
      now: fakeNow,
      intervalMs: 100,
      schedule: fakeSchedule,
      clear: fakeClear,
      kill: fakeKill,
    });

    trigger.start();
    expect(scheduleCount).toBe(1);
    // dispara
    scheduledCb!();
    expect(trigger.fired).toBe(true);

    // segundo start não deve criar novo schedule
    trigger.start();
    expect(scheduleCount).toBe(1);
  });

  it('stop() cancela o timer', () => {
    const { queue } = makeQueue();
    let clearCalled = false;

    const fakeSchedule = vi.fn(() => 'timer-3');
    const fakeClear = vi.fn(() => {
      clearCalled = true;
    });

    const trigger = new ProcessWaitTrigger({
      monitorId: 'mon-proc-3',
      label: 'test-stop',
      pid: 7777,
      queue,
      now: fakeNow,
      intervalMs: 100,
      schedule: fakeSchedule,
      clear: fakeClear,
      kill: vi.fn(),
    });

    trigger.start();
    expect(trigger.running).toBe(true);

    trigger.stop();
    expect(trigger.running).toBe(false);
    expect(clearCalled).toBe(true);
  });
});

// ────────────────────── CommandWaitTrigger ─────────────────────

describe('CommandWaitTrigger', () => {
  it('enfileira evento "command" com exit_code quando o processo termina com sucesso', () => {
    const { queue } = makeQueue();

    // spawnFn fake: retorna handle que chama onExit síncrono com code=0 e tail
    const killSpy = vi.fn();
    let exitCb: ((code: number | null, outTail: string) => void) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const fakeSpawnFn = vi.fn((_command: string) => ({
      onExit(cb: (code: number | null, outTail: string) => void) {
        exitCb = cb;
      },
      kill: killSpy,
    }));

    const trigger = new CommandWaitTrigger({
      monitorId: 'mon-cmd-1',
      label: 'my-build',
      command: 'npm run build',
      queue,
      now: fakeNow,
      spawnFn: fakeSpawnFn,
    });

    trigger.start();
    expect(trigger.running).toBe(true);
    expect(fakeSpawnFn).toHaveBeenCalledWith('npm run build');

    // Simula o processo terminar com exit code 0
    exitCb!(0, 'Build succeeded.\nDone.');

    const events = queue.drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      monitorId: 'mon-cmd-1',
      label: 'my-build',
      type: 'command',
      condition: 'exit_code=0',
      firedAt: '2025-01-01T00:00:00.000Z',
    } satisfies Partial<MonitorEvent>);
    expect(String(events[0].payload)).toContain('$ npm run build');
    expect(String(events[0].payload)).toContain('Build succeeded.');
    expect(trigger.fired).toBe(true);
    expect(trigger.running).toBe(false);
  });

  it('usa condition "signal" quando code é null (processo morto por sinal)', () => {
    const { queue } = makeQueue();

    let exitCb: ((code: number | null, outTail: string) => void) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const fakeSpawnFn = vi.fn((_command: string) => ({
      onExit(cb: (code: number | null, outTail: string) => void) {
        exitCb = cb;
      },
      kill: vi.fn(),
    }));

    const trigger = new CommandWaitTrigger({
      monitorId: 'mon-cmd-2',
      label: 'killed-proc',
      command: 'sleep 100',
      queue,
      now: fakeNow,
      spawnFn: fakeSpawnFn,
    });

    trigger.start();
    exitCb!(null, 'Killed\n');

    const events = queue.drain();
    expect(events).toHaveLength(1);
    expect(events[0].condition).toBe('signal');
    expect(String(events[0].payload)).toContain('$ sleep 100');
    expect(trigger.fired).toBe(true);
  });

  it('stop() chama kill() do handle', () => {
    const { queue } = makeQueue();
    const killSpy = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const fakeSpawnFn = vi.fn((_command: string) => ({
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      onExit(_cb: (code: number | null, outTail: string) => void) {},
      kill: killSpy,
    }));

    const trigger = new CommandWaitTrigger({
      monitorId: 'mon-cmd-3',
      label: 'stoppable',
      command: 'sleep 999',
      queue,
      now: fakeNow,
      spawnFn: fakeSpawnFn,
    });

    trigger.start();
    expect(trigger.running).toBe(true);

    trigger.stop();
    expect(trigger.running).toBe(false);
    expect(killSpy).toHaveBeenCalled();
  });

  it('start() após fired é noop (one-shot)', () => {
    const { queue } = makeQueue();
    let spawnCount = 0;

    let exitCb: ((code: number | null, outTail: string) => void) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const fakeSpawnFn = vi.fn((_command: string) => {
      spawnCount++;
      return {
        onExit(cb: (code: number | null, outTail: string) => void) {
          exitCb = cb;
        },
        kill: vi.fn(),
      };
    });

    const trigger = new CommandWaitTrigger({
      monitorId: 'mon-cmd-4',
      label: 'one-shot',
      command: 'true',
      queue,
      now: fakeNow,
      spawnFn: fakeSpawnFn,
    });

    trigger.start();
    expect(spawnCount).toBe(1);
    exitCb!(0, '');
    expect(trigger.fired).toBe(true);

    // segundo start não deve spawnar de novo
    trigger.start();
    expect(spawnCount).toBe(1);
  });
});
