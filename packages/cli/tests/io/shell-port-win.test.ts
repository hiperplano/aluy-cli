// EST-0982 · Windows — kill por ÁRVORE no timeout/abort. No Linux a CI roda comandos
// reais (process.kill de GRUPO); aqui provamos o caminho `win32` com um spawn FAKE
// (não há `taskkill` no Linux): sob `platform:'win32'`, o kill usa
// `taskkill /pid X /T /F` (mata filho + netos) em vez de `process.kill(-pid)`
// (grupo POSIX inexistente no Windows ⇒ netos órfãos).

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import type { spawn as nodeSpawn } from 'node:child_process';
import { NodeShellPort } from '../../src/io/shell-port.js';
import { NodeWorkspace } from '../../src/io/workspace.js';

type AnyChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
};

function fakeChild(pid: number): AnyChild {
  const child = new EventEmitter() as AnyChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (): void => {};
  return child;
}

describe('EST-0982 — Windows: kill por árvore (taskkill /T) no timeout', () => {
  it('platform win32 ⇒ o timeout mata via `taskkill /pid X /T /F` (não process.kill de grupo)', async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const cmdChild = fakeChild(4321); // o "comando" (sem output ⇒ dispara o idle timeout)

    const spawnFn = ((cmd: string, args?: readonly string[]) => {
      calls.push({ cmd, args: args ?? [] });
      if (cmd === 'taskkill') {
        // o kill chegou: o "processo" encerra ⇒ o child do comando emite close.
        setImmediate(() => cmdChild.emit('close', 1, 'SIGTERM'));
        return fakeChild(0);
      }
      return cmdChild;
    }) as unknown as typeof nodeSpawn;

    const shell = new NodeShellPort({
      workspace: new NodeWorkspace({ root: tmpdir() }),
      spawnFn,
      platform: 'win32',
      timeoutMs: 30, // INATIVIDADE curta ⇒ dispara o kill
      killGraceMs: 10,
    });

    const r = await shell.exec('comando-que-pendura');

    const taskkill = calls.find((c) => c.cmd === 'taskkill');
    expect(taskkill).toBeDefined();
    expect(taskkill!.args).toEqual(['/pid', '4321', '/T', '/F']); // /T = ÁRVORE
    expect(r.exitCode).toBe(124); // convenção de timeout
  });
});
