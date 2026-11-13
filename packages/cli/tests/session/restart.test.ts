// `/restart` — recarrega o aluy retomando a conversa. Tudo puro/injetado: sem spawn real,
// sem fs real, sem tocar em ~/.aluy.

import { describe, expect, it } from 'vitest';
import {
  RESTARTED_FROM_ENV,
  decideRestart,
  planRestart,
  restartedNote,
  releaseStdinForChild,
  rewriteRestartArgv,
  runRestart,
  takeRestartedFrom,
  type ChildLike,
  type RestartPorts,
} from '../../src/session/restart.js';
import { NATIVE_COMMANDS, entryPath, filterCommands } from '../../src/slash/commands.js';
import type { MenuContext } from '../../src/slash/command-meta.js';

const ui = { classic: false, fullscreen: false, split: false };

describe('rewriteRestartArgv', () => {
  it('tira --resume/--continue/--new e acrescenta --resume <id>', () => {
    expect(
      rewriteRestartArgv({ args: ['--resume', 'abc', '--new', '--continue'], sessionId: 's1', ui }),
    ).toEqual(['--resume', 's1']);
    expect(rewriteRestartArgv({ args: ['--resume=abc'], sessionId: 's1', ui })).toEqual([
      '--resume',
      's1',
    ]);
  });

  it('tira -p/--print e o prompt, e o objetivo posicional', () => {
    expect(rewriteRestartArgv({ args: ['-p', 'faça x', '--yolo'], sessionId: 's1', ui })).toEqual([
      '--yolo',
      '--resume',
      's1',
    ]);
    expect(rewriteRestartArgv({ args: ['corrige o bug', '--yolo'], sessionId: 's1', ui })).toEqual([
      '--yolo',
      '--resume',
      's1',
    ]);
  });

  it('mantém flags e valores (--lang/--model/--max-tokens), inclusive valor posicional-like', () => {
    expect(
      rewriteRestartArgv({
        args: ['--yolo', '--lang', 'en', '--model', 'x/y', '--max-tokens=500', '--tier', 'flux'],
        sessionId: 's1',
        ui,
      }),
    ).toEqual([
      '--yolo',
      '--lang',
      'en',
      '--model',
      'x/y',
      '--max-tokens=500',
      '--tier',
      'flux',
      '--resume',
      's1',
    ]);
  });

  it('reemite os modos de UI a partir do estado VIVO, não do argv do boot', () => {
    expect(
      rewriteRestartArgv({
        args: ['--classic', '--fullscreen', '--split'],
        sessionId: 's1',
        ui: { classic: false, fullscreen: false, split: false },
      }),
    ).toEqual(['--resume', 's1']);
    expect(
      rewriteRestartArgv({
        args: [],
        sessionId: 's1',
        ui: { classic: true, fullscreen: true, split: true },
      }),
    ).toEqual(['--classic', '--fullscreen', '--split', '--resume', 's1']);
  });

  it('sem sessão salva recomeça limpo com --new', () => {
    expect(rewriteRestartArgv({ args: ['--yolo'], ui })).toEqual(['--yolo', '--new']);
  });
});

describe('decideRestart', () => {
  it('anônimo é recusado, mesmo confirmado', () => {
    expect(decideRestart({ anonymous: true, running: 0, confirmed: true }).kind).toBe('refuse');
  });
  it('com tarefas rodando pede confirmação e avisa que serão interrompidas', () => {
    const g = decideRestart({ anonymous: false, running: 2, confirmed: false });
    expect(g.kind).toBe('confirm');
    expect(JSON.stringify(g)).toContain('interromp');
    expect(JSON.stringify(g)).toContain('/restart');
  });
  it('confirmado ou ocioso segue', () => {
    expect(decideRestart({ anonymous: false, running: 2, confirmed: true }).kind).toBe('proceed');
    expect(decideRestart({ anonymous: false, running: 0, confirmed: false }).kind).toBe('proceed');
  });
});

describe('planRestart', () => {
  const base = {
    execPath: '/usr/bin/node',
    execArgv: ['--enable-source-maps'],
    script: '/usr/lib/bin/aluy',
    args: [],
    env: { A: '1' },
    cwd: '/proj',
    currentVersion: '1.0.0',
    exists: () => true,
  };
  it('mantém o caminho do script como foi invocado (sem realpath) e põe a versão antiga no env', () => {
    const p = planRestart(base)!;
    expect(p.script).toBe('/usr/lib/bin/aluy');
    expect(p.nodeArgs).toEqual(['--enable-source-maps']);
    expect(p.env[RESTARTED_FROM_ENV]).toBe('1.0.0');
    expect(p.env.A).toBe('1');
    expect(p.cwd).toBe('/proj');
  });
  it('script ausente ⇒ undefined (não desmonta a TUI)', () => {
    expect(planRestart({ ...base, exists: () => false })).toBeUndefined();
    expect(planRestart({ ...base, script: undefined })).toBeUndefined();
  });
});

function fakePorts(): {
  ports: RestartPorts;
  child: ChildLike & { emit: (ev: string, ...a: unknown[]) => void; killed: string[] };
  spawned: Array<{ cmd: string; args: readonly string[]; opts: unknown }>;
  handlers: Map<string, () => void>;
  failSpawn: { v: boolean };
} {
  const listeners = new Map<string, (...a: never[]) => void>();
  const killed: string[] = [];
  const child = {
    killed,
    on(ev: string, fn: (...a: never[]) => void) {
      listeners.set(ev, fn);
      return this;
    },
    kill(sig?: string) {
      killed.push(sig ?? '');
      return true;
    },
    emit(ev: string, ...a: unknown[]) {
      (listeners.get(ev) as (...x: unknown[]) => void)(...a);
    },
  } as unknown as ReturnType<typeof fakePorts>['child'];
  const spawned: Array<{ cmd: string; args: readonly string[]; opts: unknown }> = [];
  const handlers = new Map<string, () => void>();
  const failSpawn = { v: false };
  const ports: RestartPorts = {
    spawn: (cmd, args, opts) => {
      if (failSpawn.v) throw new Error('ENOENT');
      spawned.push({ cmd, args, opts });
      return child;
    },
    onSignal: (s, f) => void handlers.set(s, f),
    offSignal: (s) => void handlers.delete(s),
    stdinIsTty: false,
    signalNumber: (s) => ({ SIGTERM: 15, SIGKILL: 9 })[s],
  };
  return { ports, child, spawned, handlers, failSpawn };
}

const plan = {
  execPath: '/node',
  nodeArgs: ['--x'],
  script: '/bin/aluy',
  args: ['--resume', 's1'],
  env: { K: 'v' },
  cwd: '/p',
};

describe('runRestart', () => {
  it('spawna node + execArgv + script + args com stdio inherit, cwd e env', async () => {
    const f = fakePorts();
    const p = runRestart(plan, f.ports);
    expect(f.spawned[0]).toMatchObject({
      cmd: '/node',
      args: ['--x', '/bin/aluy', '--resume', 's1'],
      opts: { stdio: 'inherit', env: { K: 'v' }, cwd: '/p' },
    });
    f.child.emit('close', 0, null);
    expect(await p).toBe(0);
  });

  it('propaga o exit code do filho', async () => {
    const f = fakePorts();
    const p = runRestart(plan, f.ports);
    f.child.emit('close', 7, null);
    expect(await p).toBe(7);
  });

  it('filho morto por sinal ⇒ 128+n', async () => {
    const f = fakePorts();
    const p = runRestart(plan, f.ports);
    f.child.emit('close', null, 'SIGTERM');
    expect(await p).toBe(143);
  });

  it('repassa SIGTERM ao filho e solta os handlers ao fim', async () => {
    const f = fakePorts();
    const p = runRestart(plan, f.ports);
    f.handlers.get('SIGTERM')!();
    expect(f.child.killed).toEqual(['SIGTERM']);
    f.child.emit('close', 0, null);
    await p;
    expect(f.handlers.size).toBe(0);
  });

  it('em TTY o SIGINT não é repassado (o terminal já entrega) mas o pai sobrevive', async () => {
    const f = fakePorts();
    const p = runRestart(plan, { ...f.ports, stdinIsTty: true });
    f.handlers.get('SIGINT')!();
    expect(f.child.killed).toEqual([]);
    f.child.emit('close', 0, null);
    await p;
  });

  it('sem TTY o SIGINT é repassado', async () => {
    const f = fakePorts();
    const p = runRestart(plan, f.ports);
    f.handlers.get('SIGINT')!();
    expect(f.child.killed).toEqual(['SIGINT']);
    f.child.emit('close', 0, null);
    await p;
  });

  it('falha de spawn ⇒ undefined', async () => {
    const f = fakePorts();
    f.failSpawn.v = true;
    expect(await runRestart(plan, f.ports)).toBeUndefined();
  });
});

describe('nota pós-restart', () => {
  it('lê e LIMPA o env (não propaga)', () => {
    const env: Record<string, string | undefined> = { [RESTARTED_FROM_ENV]: '1.0.0-rc.1' };
    expect(takeRestartedFrom(env)).toBe('1.0.0-rc.1');
    expect(RESTARTED_FROM_ENV in env).toBe(false);
    expect(takeRestartedFrom(env)).toBeUndefined();
  });
  it('formata a troca de versão', () => {
    expect(restartedNote('1.0.0', '1.0.1')).toBe('↻ reiniciado — aluy 1.0.0 → 1.0.1');
    expect(restartedNote('1.0.1', '1.0.1')).toBe('↻ reiniciado — aluy 1.0.1');
  });
});

describe('registro do comando', () => {
  const CLASSIC: MenuContext = { concierge: false, subagentFocused: false };
  it('/restart está no registro, seção conversa, com as palavras-chave', () => {
    const c = NATIVE_COMMANDS.find((x) => x.name === 'restart');
    expect(c).toBeDefined();
    expect(c!.section).toBe('conversa');
    expect(c!.keywords).toEqual(
      expect.arrayContaining(['reiniciar', 'atualizar', 'restart', 'nova versão']),
    );
    expect(c!.agentEffect).toBe('human-only');
  });
  it.each(['restart', 'reiniciar', 'atualizar', 'nova versão'])(
    'o menu acha /restart por "%s"',
    (q) => {
      const paths = filterCommands(q, [], NATIVE_COMMANDS, CLASSIC).map(entryPath);
      expect(paths).toContain('restart');
    },
  );
});

describe('releaseStdinForChild + runRestart (Windows: pai solta o console antes do filho)', () => {
  function fakeStdin(log: string[]) {
    return {
      removeAllListeners(ev?: string) {
        log.push(`off:${ev}`);
      },
      setRawMode(m: boolean) {
        log.push(`raw:${m}`);
      },
      pause() {
        log.push('pause');
      },
      destroy() {
        log.push('destroy');
      },
    };
  }

  it('ordem: listeners fora, raw off, pause, destroy — ANTES do spawn', async () => {
    const log: string[] = [];
    const f = fakePorts();
    const origSpawn = f.ports.spawn;
    const ports: RestartPorts = {
      ...f.ports,
      spawn: (...a) => {
        log.push('spawn');
        return origSpawn(...a);
      },
      beforeSpawn: () => releaseStdinForChild(fakeStdin(log)),
    };
    const p = runRestart(plan, ports);
    expect(log).toEqual([
      'off:data',
      'off:keypress',
      'off:readable',
      'raw:false',
      'pause',
      'destroy',
      'spawn',
    ]);
    f.child.emit('close', 0, null);
    await p;
  });

  it('best-effort: um passo que lança não impede os seguintes nem o spawn', async () => {
    const log: string[] = [];
    const stdin = {
      ...fakeStdin(log),
      setRawMode() {
        throw new Error('EBADF');
      },
    };
    expect(() => releaseStdinForChild(stdin)).not.toThrow();
    expect(log).toContain('destroy');
    const f = fakePorts();
    const p = runRestart(plan, {
      ...f.ports,
      beforeSpawn: () => {
        throw new Error('x');
      },
    });
    expect(f.spawned).toHaveLength(1);
    f.child.emit('close', 0, null);
    await p;
  });
});
