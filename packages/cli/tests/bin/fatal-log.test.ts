import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendFatalLog,
  installFatalLogger,
  logChildExit,
  type FatalProcessLike,
} from '../../src/bin/fatal-log.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'aluy-fatal-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const read = (d: string): string => readFileSync(join(d, 'crash.log'), 'utf8');

describe('fatal-log (rede de segurança de crash)', () => {
  it('grava o stack do erro com timestamp e pid', () => {
    const dir = tmp();
    const ok = appendFatalLog('uncaughtException(x)', new Error('boom'), {
      dir,
      now: () => new Date('2026-11-03T10:00:00Z'),
      pid: 42,
    });
    expect(ok).toBe(true);
    const txt = read(dir);
    expect(txt).toContain('[2026-11-03T10:00:00.000Z] pid=42 uncaughtException(x): Error: boom');
  });

  it('nunca lança (diretório impossível) e devolve false', () => {
    const d = tmp();
    writeFileSync(join(d, 'arquivo'), '');
    expect(appendFatalLog('k', 'x', { dir: join(d, 'arquivo', 'sub') })).toBe(false);
  });

  it('installFatalLogger observa uncaughtExceptionMonitor, exit≠0 e SIGHUP (sem tirar o default)', () => {
    const dir = tmp();
    const handlers = new Map<string, (...a: unknown[]) => void>();
    let exited: number | undefined;
    const fake: FatalProcessLike = {
      on(event, listener) {
        handlers.set(event, listener as (...a: unknown[]) => void);
      },
      exit(code) {
        exited = code;
        return undefined as never;
      },
    };
    installFatalLogger(fake, { dir, pid: 1 });
    expect([...handlers.keys()].sort()).toEqual(['SIGHUP', 'exit', 'uncaughtExceptionMonitor']);
    handlers.get('uncaughtExceptionMonitor')!(new Error('rej'), 'unhandledRejection');
    handlers.get('exit')!(0); // limpo: não loga
    handlers.get('exit')!(1);
    handlers.get('SIGHUP')!();
    const txt = read(dir);
    expect(txt).toContain('uncaughtException(unhandledRejection): Error: rej');
    expect(txt).toContain('exit: código 1');
    expect(txt).not.toContain('código 0');
    expect(txt).toContain('signal: SIGHUP');
    expect(exited).toBe(129);
  });

  it('logChildExit: registra sinal/OOM do filho; saída limpa e Ctrl-C não', () => {
    const dir = tmp();
    logChildExit(0, null, { dir });
    logChildExit(130, null, { dir });
    expect(() => read(dir)).toThrow();
    logChildExit(null, 'SIGKILL', { dir });
    logChildExit(134, null, { dir });
    const txt = read(dir);
    expect(txt).toContain('code=null signal=SIGKILL');
    expect(txt).toContain('code=134 signal=null');
  });
});
