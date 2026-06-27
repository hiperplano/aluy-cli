// EST-MON-5 · ADR-0079 — buildMonitorTools: validação de input + integração com o
// MonitorStore (arm/list/cancel). O file-watch usa um dir REAL temporário (cancelado no
// fim p/ não vazar o watcher).

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMonitorTools } from '../../../src/agent/monitor/monitor-tools.js';
import { MonitorStore } from '../../../src/agent/monitor/monitor-store.js';
import { EventQueue } from '../../../src/agent/monitor/event-queue.js';

const NOW = (): string => '2026-01-01T00:00:00Z';

/** Cria o toolset COMPLETO (4 tools) SEM spawnFn (watch_command sem suporte). */
function setup() {
  const store = new MonitorStore();
  const queue = new EventQueue();
  const [monitor, monitors, monitorCancel, watchCommand] = buildMonitorTools(store, queue, NOW);
  return {
    store,
    queue,
    monitor: monitor!,
    monitors: monitors!,
    monitorCancel: monitorCancel!,
    watchCommand: watchCommand!,
  };
}

/** Cria o toolset com spawnFn fake para testar watch_command. */
function setupWithSpawn() {
  const store = new MonitorStore();
  const queue = new EventQueue();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const fakeSpawnFn = vi.fn((_command: string) => {
    let exitCb: ((code: number | null, outTail: string) => void) | null = null;
    return {
      onExit(cb: (code: number | null, outTail: string) => void) {
        exitCb = cb;
      },
      kill: vi.fn(),
      /** Dispara o exit manualmente para teste. */
      _triggerExit(code: number | null, outTail: string) {
        exitCb?.(code, outTail);
      },
    };
  });
  const [monitor, monitors, monitorCancel, watchCommand] = buildMonitorTools(
    store,
    queue,
    NOW,
    fakeSpawnFn,
  );
  return {
    store,
    queue,
    monitor: monitor!,
    monitors: monitors!,
    monitorCancel: monitorCancel!,
    watchCommand: watchCommand!,
    fakeSpawnFn,
  };
}

describe('buildMonitorTools — tools do monitor (ADR-0079)', () => {
  it('monitor sem label ⇒ erro', async () => {
    const { monitor } = setup();
    const r = await monitor.run({ type: 'file-watch', path: '/x' }, undefined);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('label');
  });

  it('monitor file-watch sem path ⇒ erro', async () => {
    const { monitor } = setup();
    const r = await monitor.run({ type: 'file-watch', label: 'x' }, undefined);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('path');
  });

  it('monitor process-wait com pid inválido ⇒ erro', async () => {
    const { monitor } = setup();
    const r = await monitor.run({ type: 'process-wait', label: 'x', pid: 0 }, undefined);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('pid');
  });

  it('monitor type desconhecido ⇒ erro', async () => {
    const { monitor } = setup();
    const r = await monitor.run({ type: 'banana', label: 'x' }, undefined);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('desconhecido');
  });

  it('monitor file-watch num dir REAL ⇒ arma, lista, cancela (limpa o watcher)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'montool-'));
    try {
      const { store, monitor, monitors, monitorCancel } = setup();
      const r = await monitor.run({ type: 'file-watch', label: 'meu-dir', path: dir }, undefined);
      expect(r.ok).toBe(true);
      const id = r.observation.match(/monitor armado: (\S+)/)?.[1];
      expect(id).toBeDefined();
      expect(store.size()).toBe(1);
      const list = await monitors.run({}, undefined);
      expect(list.observation).toContain('meu-dir');
      const c = await monitorCancel.run({ monitorId: id }, undefined);
      expect(c.ok).toBe(true);
      expect(store.size()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('monitors vazio ⇒ "nenhum monitor ativo"', async () => {
    const { monitors } = setup();
    const r = await monitors.run({}, undefined);
    expect(r.observation).toContain('nenhum monitor ativo');
  });

  it('monitor_cancel de id inexistente ⇒ ok=false', async () => {
    const { monitorCancel } = setup();
    const r = await monitorCancel.run({ monitorId: 'mon-999' }, undefined);
    expect(r.ok).toBe(false);
  });

  // ────────── watch_command ──────────

  it('watch_command tem effect: "exec" (prova da gating via catraca)', () => {
    const { watchCommand } = setup();
    expect(watchCommand.effect).toBe('exec');
  });

  it('watch_command sem command ⇒ erro', async () => {
    const { watchCommand } = setup();
    const r = await watchCommand.run({ label: 'x' }, undefined);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('command');
  });

  it('watch_command sem label ⇒ erro', async () => {
    const { watchCommand } = setup();
    const r = await watchCommand.run({ command: 'true' }, undefined);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('label');
  });

  it('watch_command sem spawnFn injetado ⇒ erro', async () => {
    const { watchCommand } = setup();
    const r = await watchCommand.run({ command: 'true', label: 'test' }, undefined);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('spawn não disponível');
  });

  it('watch_command com spawnFn fake ⇒ arma, lista (type "command") e evento chega na queue', async () => {
    const { watchCommand, monitors, store, queue, fakeSpawnFn } = setupWithSpawn();

    const r = await watchCommand.run({ command: 'echo hello', label: 'eco' }, undefined);
    expect(r.ok).toBe(true);
    const id = r.observation.match(/watch_command armado: (\S+)/)?.[1];
    expect(id).toBeDefined();
    expect(r.observation).toContain('echo hello');
    expect(r.observation).toContain('eco');
    expect(store.size()).toBe(1);

    // Lista mostra o monitor tipo "command"
    const list = await monitors.run({}, undefined);
    expect(list.observation).toContain('eco');
    expect(list.observation).toContain('command');

    // Simula o processo terminar
    const handle = fakeSpawnFn.mock.results[0]?.value;
    expect(handle).toBeDefined();
    handle._triggerExit(0, 'hello\n');

    // Evento na queue
    const events = queue.drain();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('command');
    expect(events[0].condition).toBe('exit_code=0');
    expect(events[0].label).toBe('eco');
  });

  it('watch_command com cap de monitores atingido ⇒ erro', async () => {
    const { watchCommand } = setupWithSpawn();
    // Enche o store até o cap (default 10)
    for (let i = 0; i < 9; i++) {
      await watchCommand.run({ command: `cmd-${i}`, label: `lbl-${i}` }, undefined);
    }
    // O 10º deve passar
    const r10 = await watchCommand.run({ command: 'cmd-last', label: 'last' }, undefined);
    expect(r10.ok).toBe(true);

    // O 11º deve falhar (cap de 10)
    const rOver = await watchCommand.run({ command: 'overflow', label: 'over' }, undefined);
    expect(rOver.ok).toBe(false);
    expect(rOver.observation).toContain('limite de monitores');
  });
});
