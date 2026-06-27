// EST-MON-5 · ADR-0079 (APR-0084) — MonitorStore: orquestração CONTIDA dos gatilhos
// do monitor. Armazena os ActiveMonitors (file-watch / process-wait), controla o
// limite de concorrência (ADR-0079 §7) e expõe arm/cancel/list/cancelAll. PURA:
// relógio injetado (`now`), sem I/O direto — os triggers fazem o I/O com suas
// dependências injetadas.

import type { EventQueue } from './event-queue.js';
import { CommandWaitTrigger, FileWatchTrigger, ProcessWaitTrigger } from './triggers.js';
import type { CommandSpawnHandle } from './triggers.js';

// ─────────────────────────── ActiveMonitor ───────────────────────────

export type ActiveMonitor = {
  monitorId: string;
  label: string;
  type: 'file-watch' | 'process-wait' | 'command';
  trigger: FileWatchTrigger | ProcessWaitTrigger | CommandWaitTrigger;
};

// ─────────────────────────── MonitorStore ───────────────────────────

export interface MonitorStoreOptions {
  /** Número máximo de monitores ativos simultâneos (ADR-0079 §7). Default 10. */
  maxMonitors?: number;
  /**
   * Gerador de IDs injetável para testes determinísticos.
   * Default: contador incremental "mon-1", "mon-2", …
   */
  genId?: () => string;
}

type FileWatchSpec = {
  label: string;
  queue: EventQueue;
  now: () => string;
  type: 'file-watch';
  path: string;
  /** `fs.watch` injetável (repassado ao FileWatchTrigger). */
  watch?: typeof import('node:fs').watch;
};

type ProcessWaitSpec = {
  label: string;
  queue: EventQueue;
  now: () => string;
  type: 'process-wait';
  pid: number;
  intervalMs?: number;
  /** `setInterval` injetável (repassado ao ProcessWaitTrigger). */
  schedule?: (cb: () => void, ms: number) => unknown;
  /** `clearInterval` injetável (repassado ao ProcessWaitTrigger). */
  clear?: (h: unknown) => void;
  /** `process.kill` injetável (repassado ao ProcessWaitTrigger). */
  kill?: (pid: number, signal: number | string | undefined) => void;
};

type CommandSpec = {
  label: string;
  queue: EventQueue;
  now: () => string;
  type: 'command';
  command: string;
  /** `spawnFn` injetável (obrigatório — cli-core não tem `child_process`). */
  spawnFn: (command: string) => CommandSpawnHandle;
};

export type ArmSpec = FileWatchSpec | ProcessWaitSpec | CommandSpec;

export class MonitorStore {
  private readonly active = new Map<string, ActiveMonitor>();
  private readonly maxMonitors: number;
  private readonly genId: () => string;
  private counter = 0;

  constructor(opts?: MonitorStoreOptions) {
    this.maxMonitors = opts?.maxMonitors ?? 10;
    this.genId =
      opts?.genId ??
      (() => {
        this.counter += 1;
        return `mon-${this.counter}`;
      });
  }

  /**
   * Arma um novo monitor (file-watch ou process-wait).
   *
   * - Gera um `monitorId` via `genId`.
   * - Cria o trigger correspondente com `{ monitorId, label, queue, now, … }`.
   * - Chama `trigger.start()`.
   * - Guarda no map e retorna o `monitorId`.
   *
   * @throws Error se o número de monitores ativos já atingiu `maxMonitors`.
   */
  arm(spec: ArmSpec): string {
    // EST-MON-6 — antes de bater no teto, EVICTA os monitores MORTOS (gatilho não mais
    // ativo: um process-wait one-shot que JÁ disparou fica com `running=false` mas
    // permanecia no store). Sem isto, o cap (maxMonitors) sem reuso virava DoS auto-
    // infligido: 10 process-waits que disparam enchem o teto com monitores mortos e o 11º
    // `arm` lança numa sessão longa — a MESMA classe "recurso sem teto" (EST-1011) que
    // mordeu as salas (#221). Espelha aquele fix.
    this.evictDead();
    if (this.active.size >= this.maxMonitors) {
      throw new Error(`limite de monitores (${this.maxMonitors})`);
    }

    const monitorId = this.genId();

    let trigger: FileWatchTrigger | ProcessWaitTrigger | CommandWaitTrigger;

    if (spec.type === 'file-watch') {
      trigger = new FileWatchTrigger({
        monitorId,
        label: spec.label,
        path: spec.path,
        queue: spec.queue,
        now: spec.now,
        ...(spec.watch !== undefined ? { watch: spec.watch } : {}),
      });
    } else if (spec.type === 'process-wait') {
      trigger = new ProcessWaitTrigger({
        monitorId,
        label: spec.label,
        pid: spec.pid,
        queue: spec.queue,
        now: spec.now,
        ...(spec.intervalMs !== undefined ? { intervalMs: spec.intervalMs } : {}),
        ...(spec.schedule !== undefined ? { schedule: spec.schedule } : {}),
        ...(spec.clear !== undefined ? { clear: spec.clear } : {}),
        ...(spec.kill !== undefined ? { kill: spec.kill } : {}),
      });
    } else {
      // type === 'command'
      trigger = new CommandWaitTrigger({
        monitorId,
        label: spec.label,
        command: spec.command,
        queue: spec.queue,
        now: spec.now,
        spawnFn: spec.spawnFn,
      });
    }

    trigger.start();

    this.active.set(monitorId, {
      monitorId,
      label: spec.label,
      type: spec.type,
      trigger,
    });

    return monitorId;
  }

  /**
   * Cancela um monitor ativo pelo ID.
   * @returns `true` se o monitor existia e foi removido; `false` caso contrário.
   */
  cancel(monitorId: string): boolean {
    const entry = this.active.get(monitorId);
    if (!entry) return false;
    entry.trigger.stop();
    this.active.delete(monitorId);
    return true;
  }

  /**
   * EST-MON-6 — Remove os monitores MORTOS (gatilho não mais ativo: `running === false`,
   * ex.: process-wait one-shot que já disparou). Fecha o gatilho (idempotente) e libera o
   * slot do cap. Idempotente. @returns quantos foram evictados.
   */
  evictDead(): number {
    let evicted = 0;
    for (const [id, m] of this.active) {
      if (!m.trigger.running) {
        m.trigger.stop();
        this.active.delete(id);
        evicted += 1;
      }
    }
    return evicted;
  }

  /** Projeção dos monitores ativos (sem o trigger interno). */
  list(): readonly { monitorId: string; label: string; type: string }[] {
    return [...this.active.values()].map(({ monitorId, label, type }) => ({
      monitorId,
      label,
      type,
    }));
  }

  /** Número de monitores ativos. */
  size(): number {
    return this.active.size;
  }

  /** Para todos os monitores ativos e limpa o map (fim de sessão). */
  cancelAll(): void {
    for (const entry of this.active.values()) {
      entry.trigger.stop();
    }
    this.active.clear();
  }
}
