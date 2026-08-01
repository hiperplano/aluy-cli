// ADR-0158 §6 — daemons.ts: cenários de `startDaemons` que exigem MOCK de
// `spawn`/`openSync` (achado numa auditoria de cobertura de MUTAÇÃO — ver
// relatório): falha ao ABRIR o log do daemon (ex. permissão negada), `spawn`
// devolvendo um child SEM `pid`, `spawn` LANÇANDO síncrono (ex. shell ausente do
// SO), e o fallback pro `cmd` do Windows (`process.platform === 'win32'`).
// Arquivo SEPARADO de `daemons.test.ts`/`daemons-cleanup.test.ts` (que usam
// processos `sleep` REAIS, sem mock) — os 4 cenários aqui só são alcançáveis com
// mock, então isolamos o `vi.mock` NESTE arquivo (mesma disciplina de
// `sidecar-provisioner.test.ts`: módulo mockado por arquivo, nunca globalmente).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { daemonPidPath } from '../../src/service/paths.js';
import { readPidFile } from '../../src/service/pid.js';
import { startDaemons } from '../../src/service/daemons.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const mockSpawn = vi.mocked(spawn);
const mockOpenSync = vi.mocked(openSync);

describe('startDaemons — cenários de falha de spawn/openSync (mock)', () => {
  let serviceDir: string;
  const logs: string[] = [];
  const log = (l: string): number => logs.push(l);
  let platformStub: NodeJS.Platform | undefined;

  beforeEach(async () => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-daemon-edge-'));
    logs.length = 0;
    mockSpawn.mockReset();
    mockOpenSync.mockReset();
    // Default: openSync delega ao real (os testes SÓ sobrescrevem quando querem
    // simular a falha) — evita que os outros cenários (spawn) fiquem sem log real.
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    mockOpenSync.mockImplementation(actualFs.openSync);
  });
  afterEach(() => {
    rmSync(serviceDir, { recursive: true, force: true });
    if (platformStub !== undefined) {
      Object.defineProperty(process, 'platform', { value: platformStub, configurable: true });
      platformStub = undefined;
    }
  });

  function writeDaemon(name: string, command: string): void {
    const dir = join(serviceDir, 'daemons', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon.md'), `---\ncommand: ${command}\n---\n`);
  }

  it('openSync falha (ex. permissão negada no log) ⇒ loga "NÃO subiu", NUNCA chama spawn, sem pidfile', async () => {
    writeDaemon('guard', 'sleep 30');
    mockOpenSync.mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    startDaemons(serviceDir, log);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('NÃO subiu'))).toBe(true);
    expect(logs.some((l) => l.includes('falha ao abrir log'))).toBe(true);
    expect(readPidFile(daemonPidPath(serviceDir, 'guard'))).toBeUndefined();
  });

  it('spawn devolve child SEM pid ⇒ loga "spawn não devolveu pid", NENHUM pidfile é gravado', async () => {
    writeDaemon('guard', 'sleep 30');
    mockSpawn.mockReturnValue({ pid: undefined, unref: vi.fn() } as unknown as ReturnType<typeof spawn>);
    startDaemons(serviceDir, log);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('spawn não devolveu pid'))).toBe(true);
    expect(readPidFile(daemonPidPath(serviceDir, 'guard'))).toBeUndefined();
  });

  it('spawn LANÇA síncrono (ex. shell ausente do SO) ⇒ loga "falha ao dar spawn", sem pidfile, sem lançar', async () => {
    writeDaemon('guard', 'sleep 30');
    mockSpawn.mockImplementation(() => {
      throw new Error('ENOENT: sh não encontrado');
    });
    expect(() => startDaemons(serviceDir, log)).not.toThrow();
    expect(logs.some((l) => l.includes('falha ao dar spawn'))).toBe(true);
    expect(readPidFile(daemonPidPath(serviceDir, 'guard'))).toBeUndefined();
  });

  it('Windows (process.platform === "win32") ⇒ spawn chamado com "cmd" + ["/c", command] (não "sh"/"-c")', async () => {
    writeDaemon('guard', 'echo oi');
    mockSpawn.mockReturnValue({ pid: 4242, unref: vi.fn() } as unknown as ReturnType<typeof spawn>);
    platformStub = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    startDaemons(serviceDir, log);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [shell, shellArgs] = mockSpawn.mock.calls[0]!;
    expect(shell).toBe('cmd');
    expect(shellArgs).toEqual(['/c', 'echo oi']);
  });

  it('POSIX (linux/darwin) ⇒ spawn chamado com "sh" + ["-c", command]', async () => {
    writeDaemon('guard', 'echo oi');
    mockSpawn.mockReturnValue({ pid: 4242, unref: vi.fn() } as unknown as ReturnType<typeof spawn>);
    platformStub = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    startDaemons(serviceDir, log);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [shell, shellArgs] = mockSpawn.mock.calls[0]!;
    expect(shell).toBe('sh');
    expect(shellArgs).toEqual(['-c', 'echo oi']);
  });

  it('spawn com pid definido ⇒ pidfile gravado, log inclui o pid (e a porta, se declarada)', async () => {
    const dir = join(serviceDir, 'daemons', 'guard');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon.md'), '---\ncommand: sleep 30\nport: 9090\n---\n');
    mockSpawn.mockReturnValue({ pid: 5150, unref: vi.fn() } as unknown as ReturnType<typeof spawn>);
    startDaemons(serviceDir, log);

    expect(readPidFile(daemonPidPath(serviceDir, 'guard'))).toBe(5150);
    expect(logs.some((l) => l.includes('subiu (pid 5150)') && l.includes('porta 9090'))).toBe(true);
  });
});
