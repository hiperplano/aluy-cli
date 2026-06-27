// EST-MON-3 · EST-MON-4 · ADR-0079 (APR-0084) — Gatilhos read-only do MONITOR:
// FileWatchTrigger (fs.watch) + ProcessWaitTrigger (pid watch ONE-SHOT). Ambos
// OBSERVAM algo e chamam queue.enqueue(evento) quando a condição dispara. As
// dependências de I/O/relógio SÃO INJETÁVEIS (determinismo/testabilidade).

import { type FSWatcher, watch as defaultWatch } from 'node:fs';
import type { EventQueue, MonitorEvent } from './event-queue.js';

// ─────────────────────────── FileWatchTrigger ───────────────────────────

export interface FileWatchTriggerOptions {
  monitorId: string;
  label: string;
  path: string;
  queue: EventQueue;
  /** Fonte de timestamp INJETÁVEL — NÃO usar `new Date()` direto. */
  now: () => string;
  /** `fs.watch` injetável (default: `import('node:fs').watch`). */
  watch?: typeof defaultWatch;
}

/**
 * Vigia um PATH do sistema de arquivos com `fs.watch`.
 *
 * - `start()`: abre o watcher; enfileira evento "file-watch" em cada alteração.
 * - `stop()`: fecha o watcher.
 *
 * Se o path não existir, `fs.watch` lança → o erro é capturado (não derruba).
 * O callback de `fs.watch` chama `queue.enqueue()`, que coalesce pelo `monitorId`.
 */
export class FileWatchTrigger {
  private readonly opts: FileWatchTriggerOptions;
  private watcher: FSWatcher | null = null;
  private _running = false;

  constructor(opts: FileWatchTriggerOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this._running;
  }

  start(): void {
    if (this._running) return;
    const { monitorId, label, path, queue, now, watch } = this.opts;
    const doWatch = watch ?? defaultWatch;

    try {
      this.watcher = doWatch(path, (eventType) => {
        const condition =
          eventType === 'rename'
            ? 'criado/removido'
            : eventType === 'change'
              ? 'modificado'
              : eventType;
        queue.enqueue({
          monitorId,
          label,
          type: 'file-watch',
          condition,
          payload: path,
          firedAt: now(),
        } satisfies MonitorEvent);
      });
      this._running = true;
    } catch {
      // path inexistente ou permissão negada — não derruba o agente
      this._running = false;
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this._running = false;
  }
}

// ────────────────────────── ProcessWaitTrigger ──────────────────────────

export interface ProcessWaitTriggerOptions {
  monitorId: string;
  label: string;
  pid: number;
  queue: EventQueue;
  /** Fonte de timestamp INJETÁVEL. */
  now: () => string;
  /** Intervalo de polling (ms). Default 1000. */
  intervalMs?: number;
  /** `setInterval` injetável (default: global setInterval). */
  schedule?: (cb: () => void, ms: number) => unknown;
  /**
   * `clearInterval` injetável (default: global clearInterval). Handle OPACO (`unknown`)
   * p/ casar com o retorno do `schedule` injetável — no teste, `schedule` devolve um
   * handle fake (ex.: um número/objeto), não um `NodeJS.Timeout`.
   */
  clear?: (h: unknown) => void;
  /** `process.kill` injetável para mock. Default: process.kill. */
  kill?: (pid: number, signal: number | string | undefined) => void;
}

/**
 * Vigia um PID até ele encerrar. **ONE-SHOT**: dispara 1 evento quando o processo
 * morre e PARA o timer interno.
 *
 * - `start()`: inicia o polling (schedule).
 * - `stop()`: cancela o timer (clear).
 *
 * O teste de vida usa `process.kill(pid, 0)` (lança ESRCH se não existir) —
 * injetável via `kill` para mock.
 */
export class ProcessWaitTrigger {
  private readonly opts: ProcessWaitTriggerOptions;
  private timerHandle: unknown = null;
  private _running = false;
  private _fired = false;

  constructor(opts: ProcessWaitTriggerOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this._running;
  }

  get fired(): boolean {
    return this._fired;
  }

  start(): void {
    if (this._running || this._fired) return;

    const {
      monitorId,
      label,
      pid,
      queue,
      now,
      intervalMs = 1000,
      schedule = setInterval,
      clear = (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
      kill = process.kill,
    } = this.opts;

    this._running = true;

    this.timerHandle = schedule(() => {
      try {
        kill(pid, 0);
        // processo ainda vive — nada a fazer
      } catch {
        // ESRCH ou outro erro → processo não está mais vivo
        queue.enqueue({
          monitorId,
          label,
          type: 'process-wait',
          condition: 'PID encerrou',
          payload: `pid ${pid}`,
          firedAt: now(),
        } satisfies MonitorEvent);
        this._fired = true;
        this._running = false;
        // ONE-SHOT: para o timer
        clear(this.timerHandle);
        this.timerHandle = null;
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timerHandle != null) {
      const { clear = (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>) } =
        this.opts;
      clear(this.timerHandle);
      this.timerHandle = null;
    }
    this._running = false;
  }
}

// ────────────────────────── CommandWaitTrigger ──────────────────────────

/**
 * Face MÍNIMA e PORTÁVEL do spawn de processo — `cli-core` NÃO importa
 * `node:child_process`. O concreto (`@hiperplano/aluy-cli`) a implementa com `spawn`.
 */
export interface CommandSpawnHandle {
  /**
   * Registra callback chamado quando o processo encerra.
   * @param code exit code (0..255) ou `null` se morto por sinal.
   * @param outTail tail da stdout/stderr capturada (buffer truncado ~4KB).
   */
  onExit(cb: (code: number | null, outTail: string) => void): void;
  /** Mata o processo (SIGTERM). Idempotente. */
  kill(): void;
}

export interface CommandWaitTriggerOptions {
  monitorId: string;
  label: string;
  command: string;
  queue: EventQueue;
  /** Fonte de timestamp INJETÁVEL. */
  now: () => string;
  /**
   * Spawn do comando INJETÁVEL (default: lança erro claro — cli-core não tem
   * `child_process`). O concreto no `@hiperplano/aluy-cli` injeta `spawn('/bin/sh', ...)`.
   */
  spawnFn: (command: string) => CommandSpawnHandle;
}

/**
 * Roda um comando em background (spawn detached) e enfileira UM evento `command`
 * quando ele encerrar. **ONE-SHOT**: não re-dispara.
 *
 * - `start()`: chama `spawnFn(command)` e registra `onExit`.
 * - `stop()`: chama `kill()` do handle (mata o processo se ainda vivo).
 */
export class CommandWaitTrigger {
  private readonly opts: CommandWaitTriggerOptions;
  private handle: CommandSpawnHandle | null = null;
  private _running = false;
  private _fired = false;

  constructor(opts: CommandWaitTriggerOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this._running;
  }

  get fired(): boolean {
    return this._fired;
  }

  start(): void {
    if (this._running || this._fired) return;

    const { monitorId, label, command, queue, now, spawnFn } = this.opts;

    this._running = true;
    this.handle = spawnFn(command);
    this.handle.onExit((code, outTail) => {
      const exitLabel = code === null ? 'signal' : `exit_code=${code}`;
      const payload = `$ ${command}\n${outTail}`;
      queue.enqueue({
        monitorId,
        label,
        type: 'command',
        condition: exitLabel,
        payload,
        firedAt: now(),
      } satisfies MonitorEvent);
      this._fired = true;
      this._running = false;
      this.handle = null;
    });
  }

  stop(): void {
    if (this.handle) {
      this.handle.kill();
      this.handle = null;
    }
    this._running = false;
  }
}
