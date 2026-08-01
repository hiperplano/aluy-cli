// ADR-0158 §6 — daemons.ts: ciclo de vida dos daemons PRÓPRIOS do usuário. Usa
// comandos shell REAIS (sleep) mas curtos e mortos via SIGTERM no teardown — sem
// depender de rede/LLM.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDeclaredDaemons, startDaemons, stopDaemons } from '../../src/service/daemons.js';
import { readPidFile, isProcessAlive } from '../../src/service/pid.js';
import { daemonPidPath } from '../../src/service/paths.js';

describe('daemons.ts', () => {
  let serviceDir: string;
  const logs: string[] = [];
  const log = (l: string): number => logs.push(l);

  beforeEach(() => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-daemon-'));
    logs.length = 0;
  });
  afterEach(() => {
    // best-effort: garante que nenhum sleep de teste sobreviva ao teste.
    stopDaemons(serviceDir, () => {});
    rmSync(serviceDir, { recursive: true, force: true });
  });

  function writeDaemon(name: string, command: string): void {
    const dir = join(serviceDir, 'daemons', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon.md'), `---\ncommand: ${command}\n---\n`);
  }

  it('sem daemons/ ⇒ lista vazia', () => {
    expect(listDeclaredDaemons(serviceDir, log)).toEqual([]);
  });

  it('lê UM daemon declarado válido', () => {
    writeDaemon('guard', 'sleep 30');
    const list = listDeclaredDaemons(serviceDir, log);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('guard');
    expect(list[0]!.manifest.command).toBe('sleep 30');
  });

  it('daemon.md inválido (sem command) ⇒ ignorado com aviso no log', () => {
    mkdirSync(join(serviceDir, 'daemons', 'quebrado'), { recursive: true });
    writeFileSync(join(serviceDir, 'daemons', 'quebrado', 'daemon.md'), '---\nport: 80\n---\n');
    const list = listDeclaredDaemons(serviceDir, log);
    expect(list).toHaveLength(0);
    expect(logs.join('\n')).toContain('quebrado');
  });

  it('startDaemons sobe o processo e grava pidfile; stopDaemons derruba', async () => {
    writeDaemon('guard', 'sleep 30');
    startDaemons(serviceDir, log);
    const pidPath = daemonPidPath(serviceDir, 'guard');
    const pid = readPidFile(pidPath);
    expect(pid).toBeDefined();
    expect(isProcessAlive(pid!)).toBe(true);

    stopDaemons(serviceDir, log);
    // dá um instante pro SIGTERM surtir efeito.
    await new Promise((r) => setTimeout(r, 300));
    expect(isProcessAlive(pid!)).toBe(false);
  }, 10_000);

  it('startDaemons é IDEMPOTENTE — daemon já vivo é pulado', () => {
    writeDaemon('guard', 'sleep 30');
    startDaemons(serviceDir, log);
    const pid1 = readPidFile(daemonPidPath(serviceDir, 'guard'));
    startDaemons(serviceDir, log);
    const pid2 = readPidFile(daemonPidPath(serviceDir, 'guard'));
    expect(pid1).toBe(pid2);
    expect(logs.some((l) => l.includes('já rodando'))).toBe(true);
  });
});
