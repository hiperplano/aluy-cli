// ADR-0158 §5 — status.ts: pidfile é a FONTE DE VERDADE de "rodando"; status.json é
// best-effort, só exibido quando o pidfile aponta pra um processo vivo.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeServiceStatus, readServiceRuntimeStatus } from '../../src/service/status.js';
import { writePidFile } from '../../src/service/pid.js';
import { runnerPidPath } from '../../src/service/paths.js';

describe('status.ts', () => {
  let serviceDir: string;
  beforeEach(() => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-status-'));
  });
  afterEach(() => {
    rmSync(serviceDir, { recursive: true, force: true });
  });

  it('sem pidfile ⇒ running:false, sem snapshot', () => {
    const rt = readServiceRuntimeStatus(serviceDir);
    expect(rt.running).toBe(false);
    expect(rt.snapshot).toBeUndefined();
  });

  it('pidfile de processo VIVO (o próprio teste) + status.json ⇒ running:true + snapshot', () => {
    writePidFile(runnerPidPath(serviceDir), process.pid);
    writeServiceStatus(serviceDir, { turnState: 'sleeping', nextFireIso: '2026-08-01T09:00:00.000Z' });
    const rt = readServiceRuntimeStatus(serviceDir);
    expect(rt.running).toBe(true);
    expect(rt.pid).toBe(process.pid);
    expect(rt.snapshot?.turnState).toBe('sleeping');
    expect(rt.snapshot?.nextFireIso).toBe('2026-08-01T09:00:00.000Z');
  });

  it('pidfile de processo MORTO ⇒ running:false mesmo com status.json presente (não finge)', () => {
    writePidFile(runnerPidPath(serviceDir), 999_999_999);
    writeServiceStatus(serviceDir, { turnState: 'running-turn' });
    const rt = readServiceRuntimeStatus(serviceDir);
    expect(rt.running).toBe(false);
    expect(rt.snapshot).toBeUndefined();
  });

  it('pendingQuestion sobrevive no snapshot (aguardando dono)', () => {
    writePidFile(runnerPidPath(serviceDir), process.pid);
    writeServiceStatus(serviceDir, {
      turnState: 'awaiting-owner',
      pendingQuestion: 'aumento a posição?',
    });
    const rt = readServiceRuntimeStatus(serviceDir);
    expect(rt.snapshot?.turnState).toBe('awaiting-owner');
    expect(rt.snapshot?.pendingQuestion).toBe('aumento a posição?');
  });
});
