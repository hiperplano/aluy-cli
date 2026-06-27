// EST-1009 · ADR-0065 · CLI-SEC-H1 — LANÇADOR (mãe-lançador): forma do argv +
// invariantes de fronteira + ramos de fail-mode, com `spawn` INJETADO (sem tocar o
// SO de verdade — a prova de SO real está em os-confinement.test.ts).
//
// Cobre, sem depender de userns/bwrap na máquina de teste:
//  - (a/d) a FORMA do argv do bwrap: net-deny default, --share-net só com network,
//    workspace bind, ro-binds, --seccomp, --unshare-all, sem `$HOME`/`~/.aluy/`.
//  - (a) REJEIÇÃO de bind/cwd que alcance ~/.aluy/ (fail-safe ALTO).
//  - (e) ramos de fail-mode: confine (spawna bwrap), degrade/unsafe (spawna o
//    programa CRU, sem bwrap), refuse (NÃO spawna nada).

import { afterAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { SandboxCapability, SandboxConfinement } from '@hiperplano/aluy-cli-core';
import { BwrapSandboxLauncher, SandboxConfinementError } from '../../src/sandbox/launcher.js';

const FLOOR: SandboxCapability = {
  platform: 'linux',
  bwrap: true,
  userns: true,
  seccomp: true,
  landlock: true,
};
const NO_FLOOR: SandboxCapability = {
  platform: 'linux',
  bwrap: false,
  userns: false,
  seccomp: true,
  landlock: false,
  unavailableReason: 'bwrap ausente',
};

const WS = '/home/user/project';
const ALUY_HOME = '/home/user/.aluy';

function confinement(over: Partial<SandboxConfinement> = {}): SandboxConfinement {
  return { workspaceRoots: [WS], cwd: WS, ...over };
}

/** Um spawn FAKE: registra as chamadas e devolve um objeto mínimo tipo ChildProcess. */
function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
  const fn = vi.fn((cmd: string, args: string[], opts: unknown) => {
    calls.push({ cmd, args, opts });
    return { pid: 4242, stdout: null, stderr: null, on: () => {} } as never;
  });
  return { fn: fn as never, calls };
}

describe('buildBwrapArgs — forma do argv (a/d)', () => {
  const launcher = new BwrapSandboxLauncher({
    capability: FLOOR,
    env: 'dev',
    arch: 'x64',
    aluyHome: ALUY_HOME,
  });

  it('isola TODOS os namespaces e net-deny por DEFAULT (--unshare-all, sem --share-net)', () => {
    const args = launcher.buildBwrapArgs(confinement(), 7);
    expect(args).toContain('--unshare-all');
    expect(args).toContain('--die-with-parent');
    expect(args).not.toContain('--share-net'); // (d) sem rede por default
  });

  it('liga rede SÓ quando o confinamento declara network:true (d)', () => {
    const args = launcher.buildBwrapArgs(confinement({ network: true }), 7);
    expect(args).toContain('--share-net');
  });

  it('monta o WORKSPACE RW e NÃO monta $HOME nem ~/.aluy/ (a)', () => {
    const args = launcher.buildBwrapArgs(confinement(), 7);
    const joined = args.join(' ');
    expect(args).toContain('--bind');
    expect(joined).toContain(WS);
    // jamais monta o HOME do usuário ou o ~/.aluy/ no namespace.
    expect(joined).not.toContain(ALUY_HOME);
    expect(joined).not.toMatch(/--bind \/home\/user /); // só o /project, não o HOME
  });

  it('passa o fd do seccomp (--seccomp <fd>) (c)', () => {
    const args = launcher.buildBwrapArgs(confinement(), 9);
    const i = args.indexOf('--seccomp');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('9');
  });

  it('define o cwd do filho com --chdir', () => {
    const cwd = join(WS, 'src');
    const args = launcher.buildBwrapArgs(confinement({ cwd }), 7);
    const i = args.indexOf('--chdir');
    expect(args[i + 1]).toBe(cwd);
  });

  it('F16: monta /proc e /dev DEPOIS de todos os binds (não-sombreáveis por --bind /)', () => {
    // Regressão F16 (dogfooding): em yolo a cerca cai ⇒ workspaceRoots inclui '/'. O
    // `--bind / /` NÃO pode sombrear o `--dev /dev` (senão /dev fica vazio ⇒ /dev/null
    // some ⇒ "cannot create /dev/null"). bwrap monta na ORDEM do argv, então /proc e
    // /dev têm de vir POR ÚLTIMO entre os mounts — DEPOIS de todos os `--bind`.
    const args = launcher.buildBwrapArgs(confinement({ workspaceRoots: ['/'] }), 7);
    const lastBind = args.lastIndexOf('--bind');
    expect(lastBind).toBeGreaterThanOrEqual(0);
    expect(args.indexOf('--dev')).toBeGreaterThan(lastBind);
    expect(args.indexOf('--proc')).toBeGreaterThan(lastBind);
  });

  it('monta tmpfs /tmp ANTES do bind do workspace (workspace sob /tmp não é shadowado)', () => {
    const args = launcher.buildBwrapArgs(confinement({ workspaceRoots: [WS], cwd: WS }), 7);
    const tmpfsIdx = args.indexOf('--tmpfs');
    const bindIdx = args.indexOf('--bind');
    expect(tmpfsIdx).toBeGreaterThanOrEqual(0);
    expect(bindIdx).toBeGreaterThan(tmpfsIdx);
  });
});

describe('assertNoAluyHome — REJEITA bind/cwd que alcance ~/.aluy/ (a, fail-safe)', () => {
  const launcher = new BwrapSandboxLauncher({
    capability: FLOOR,
    env: 'dev',
    arch: 'x64',
    aluyHome: ALUY_HOME,
    spawnFn: fakeSpawn().fn,
  });

  it.each([
    ['workspace = ~/.aluy/', { workspaceRoots: [ALUY_HOME], cwd: ALUY_HOME }],
    [
      'workspace SOB ~/.aluy/',
      { workspaceRoots: [join(ALUY_HOME, 'undo')], cwd: join(ALUY_HOME, 'undo') },
    ],
    ['roBind alcança ~/.aluy/', confinement({ roBinds: [join(ALUY_HOME, 'memory')] })],
    ['rwBind alcança ~/.aluy/', confinement({ rwBinds: [ALUY_HOME] })],
  ])('%s ⇒ lança SandboxConfinementError', (_label, conf) => {
    expect(() => launcher.spawnConfined(['/bin/cat', 'x'], conf as SandboxConfinement)).toThrow(
      SandboxConfinementError,
    );
  });

  it('workspace LEGÍTIMO (fora de ~/.aluy/) NÃO é rejeitado', () => {
    expect(() => launcher.spawnConfined(['/bin/echo', 'ok'], confinement())).not.toThrow();
  });
});

describe('assertNoAluyHome — SYMLINK p/ ~/.aluy/ NÃO fura a fronteira (realpath, fail-safe)', () => {
  // Regressão de hardening: o check de fronteira era LÉXICO (`path.resolve`), então um
  // bind que é SYMLINK p/ dentro de `~/.aluy/` passava no check e o `bwrap` montava o
  // realpath (≈ vazaria journal/memória/config no namespace). Com `realpathSync` o
  // candidato é canonicalizado ANTES de comparar. Precisa de FS real (symlink em disco).
  const root = mkdtempSync(join(tmpdir(), 'aluy-sb-symlink-'));
  const realAluyHome = join(root, 'dot-aluy');
  const workspace = join(root, 'project');
  mkdirSync(join(realAluyHome, 'memory'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  // Um bind APARENTEMENTE legítimo (dentro do workspace) que é symlink p/ ~/.aluy/memory.
  const innocentLookingBind = join(workspace, 'cache');
  symlinkSync(join(realAluyHome, 'memory'), innocentLookingBind, 'dir');

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const launcher = new BwrapSandboxLauncher({
    capability: FLOOR,
    env: 'dev',
    arch: 'x64',
    aluyHome: realAluyHome,
    spawnFn: fakeSpawn().fn,
  });

  it('roBind que é SYMLINK p/ dentro de ~/.aluy/ ⇒ REJEITA (antes furava no check léxico)', () => {
    const conf: SandboxConfinement = {
      workspaceRoots: [workspace],
      cwd: workspace,
      roBinds: [innocentLookingBind],
    };
    expect(() => launcher.spawnConfined(['/bin/cat', 'x'], conf)).toThrow(SandboxConfinementError);
  });

  it('bind REAL fora de ~/.aluy/ (mesmo via symlink) NÃO é rejeitado', () => {
    const sibling = join(root, 'shared');
    mkdirSync(sibling, { recursive: true });
    const linkToSibling = join(workspace, 'shared-link');
    symlinkSync(sibling, linkToSibling, 'dir');
    const conf: SandboxConfinement = {
      workspaceRoots: [workspace],
      cwd: workspace,
      roBinds: [linkToSibling],
    };
    expect(() => launcher.spawnConfined(['/bin/echo', 'ok'], conf)).not.toThrow();
  });
});

describe('spawnConfined — ramos de fail-mode (e)', () => {
  it('CONFINE (piso): spawna o `bwrap` (não o programa cru)', () => {
    const sp = fakeSpawn();
    const launcher = new BwrapSandboxLauncher({
      capability: FLOOR,
      env: 'dev',
      arch: 'x64',
      aluyHome: ALUY_HOME,
      spawnFn: sp.fn,
      bwrapPath: 'bwrap',
    });
    const r = launcher.spawnConfined(['/bin/echo', 'hi'], confinement());
    expect(r.decision.action).toBe('confine');
    expect(r.process).toBeDefined();
    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]!.cmd).toBe('bwrap'); // lançou DENTRO do bwrap
    // o argv do bwrap termina com `-- /bin/echo hi` (o programa confinado).
    const args = sp.calls[0]!.args;
    const sep = args.indexOf('--');
    expect(args.slice(sep + 1)).toEqual(['/bin/echo', 'hi']);
  });

  it('DEGRADE (dev sem piso): spawna o PROGRAMA CRU (sem bwrap) + decisão avisa', () => {
    const sp = fakeSpawn();
    const launcher = new BwrapSandboxLauncher({
      capability: NO_FLOOR,
      env: 'dev',
      arch: 'x64',
      aluyHome: ALUY_HOME,
      spawnFn: sp.fn,
    });
    const r = launcher.spawnConfined(['/bin/echo', 'hi'], confinement());
    expect(r.decision.action).toBe('degrade');
    expect(r.decision.warning).toContain('SEM PISO DE SO');
    expect(r.process).toBeDefined();
    expect(sp.calls[0]!.cmd).toBe('/bin/echo'); // NÃO passou pelo bwrap
    expect(sp.calls[0]!.args).toEqual(['hi']);
  });

  it('UNSAFE (prod sem piso + flag): spawna cru + avisa risco assumido', () => {
    const sp = fakeSpawn();
    const launcher = new BwrapSandboxLauncher({
      capability: NO_FLOOR,
      env: 'prod',
      unsafeNoSandbox: true,
      arch: 'x64',
      aluyHome: ALUY_HOME,
      spawnFn: sp.fn,
    });
    const r = launcher.spawnConfined(['/bin/echo', 'hi'], confinement());
    expect(r.decision.action).toBe('unsafe');
    expect(r.process).toBeDefined();
    expect(sp.calls[0]!.cmd).toBe('/bin/echo');
  });

  it('REFUSE (prod sem piso, sem flag): NÃO spawna NADA, sem processo', () => {
    const sp = fakeSpawn();
    const launcher = new BwrapSandboxLauncher({
      capability: NO_FLOOR,
      env: 'prod',
      unsafeNoSandbox: false,
      arch: 'x64',
      aluyHome: ALUY_HOME,
      spawnFn: sp.fn,
    });
    const r = launcher.spawnConfined(['/bin/echo', 'hi'], confinement());
    expect(r.decision.action).toBe('refuse');
    expect(r.decision.allowed).toBe(false);
    expect(r.process).toBeUndefined();
    expect(sp.calls).toHaveLength(0); // recusa por default = não roda o efeito
  });

  it('command vazio ⇒ erro claro (nada a executar)', () => {
    const launcher = new BwrapSandboxLauncher({
      capability: FLOOR,
      env: 'dev',
      arch: 'x64',
      aluyHome: ALUY_HOME,
      spawnFn: fakeSpawn().fn,
    });
    expect(() => launcher.spawnConfined([], confinement())).toThrow(SandboxConfinementError);
  });
});

describe('decide — expõe a postura sem lançar', () => {
  it('reflete capability + env + flag', () => {
    expect(
      new BwrapSandboxLauncher({ capability: FLOOR, env: 'prod', aluyHome: ALUY_HOME }).decide()
        .action,
    ).toBe('confine');
    expect(
      new BwrapSandboxLauncher({ capability: NO_FLOOR, env: 'prod', aluyHome: ALUY_HOME }).decide()
        .action,
    ).toBe('refuse');
  });
});
