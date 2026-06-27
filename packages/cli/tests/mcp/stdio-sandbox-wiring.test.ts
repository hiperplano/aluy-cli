// EST-1011 · ADR-0065 §11.2 — testes de WIRING do sandbox no transport MCP, SEM
// depender de `bwrap`/piso real (rodam em QUALQUER CI). Provam:
//   • FLAG OFF (sem launcher): o transport spawna o server CRU (command/args originais)
//     — caminho atual intocado.
//   • CONFINE (capability com piso, spawn mockado): o transport reescreve o spawn p/
//     `/bin/sh -c 'exec bwrap ... -- <server> 3< <filtro>'` — net-deny default no argv.
//   • REFUSE (prod sem piso): o `connect` LANÇA, NÃO spawna nada (fail-soft p/ a
//     descoberta) — NUNCA finge confinamento.
//   • DEGRADE (dev sem piso): o transport spawna o server CRU + avisa (não-suprimível).
//   • buildConfinedInvocation: a forma do invólucro (fd seccomp por shell, --share-net
//     só sob network:true, cleanup remove o filtro temporário).
//
// O spawn do SDK é interceptado por um `clientFactory` fake que captura o que o
// `StdioClientTransport` receberia — provamos o ARGV reescrito sem lançar processo.

import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { BwrapSandboxLauncher } from '../../src/sandbox/index.js';
import { StdioMcpTransport, resolveLaunchBinds } from '../../src/mcp/stdio-transport.js';
import type { McpServerConfig, SandboxCapability } from '@hiperplano/aluy-cli-core';

const FLOOR_CAP: SandboxCapability = {
  platform: 'linux',
  bwrap: true,
  userns: true,
  seccomp: true,
  landlock: true,
};
const NO_FLOOR_CAP: SandboxCapability = {
  platform: 'linux',
  bwrap: false,
  userns: false,
  seccomp: false,
  landlock: false,
  unavailableReason: 'bwrap ausente (teste)',
};

function server(): McpServerConfig {
  return { name: 'srv', command: '/usr/bin/the-server', args: ['--port', '9'], env: {} };
}

describe('StdioMcpTransport — wiring do sandbox (sem piso real)', () => {
  it('FLAG OFF (sem launcher): spawna o server CRU (command/args originais)', () => {
    const t = new StdioMcpTransport({ cwd: '/ws' });
    // @ts-expect-error acesso ao método privado p/ provar a resolução (sem spawnar).
    const target = t.resolveSpawnTarget(server());
    expect(target.command).toBe('/usr/bin/the-server');
    expect(target.args).toEqual(['--port', '9']);
    expect(target.refused).toBe(false);
  });

  it('CONFINE: reescreve p/ `/bin/sh -c exec bwrap ... 3< filtro` (net-deny default)', () => {
    const launcher = new BwrapSandboxLauncher({ capability: FLOOR_CAP, env: 'dev' });
    const t = new StdioMcpTransport({
      cwd: '/ws',
      sandboxLauncher: launcher,
      workspaceRoots: ['/ws'],
    });
    // @ts-expect-error método privado
    const target = t.resolveSpawnTarget(server());
    expect(target.command).toBe('/bin/sh');
    expect(target.args[0]).toBe('-c');
    const script = String(target.args[1]);
    expect(script).toContain('exec ');
    expect(script).toContain('bwrap');
    expect(script).toContain('--unshare-all'); // net-deny por default
    expect(script).not.toContain('--share-net'); // network não declarado ⇒ sem rede
    expect(script).toContain('--seccomp'); // (c) filtro de syscalls
    expect(script).toMatch(/3< /); // fd do filtro aberto por shell
    expect(target.refused).toBe(false);
    // o filtro temporário foi escrito; o cleanup o remove.
    const m = script.match(/3< '([^']+)'/);
    expect(m).toBeTruthy();
    expect(existsSync(m![1]!)).toBe(true);
    // @ts-expect-error método privado — limpa o filtro temporário.
    t.runConfinementCleanup();
    expect(existsSync(m![1]!)).toBe(false);
  });

  it('CONFINE + network:true: adiciona --share-net (rede sob aprovação)', () => {
    const launcher = new BwrapSandboxLauncher({ capability: FLOOR_CAP, env: 'dev' });
    const t = new StdioMcpTransport({
      cwd: '/ws',
      sandboxLauncher: launcher,
      workspaceRoots: ['/ws'],
      network: true, // egress aprovado p/ este server
    });
    // @ts-expect-error método privado
    const target = t.resolveSpawnTarget(server());
    expect(String(target.args[1])).toContain('--share-net');
    // @ts-expect-error método privado
    t.runConfinementCleanup();
  });

  it('REFUSE (prod sem piso): refused=true (não spawna nada, fail-soft)', () => {
    const launcher = new BwrapSandboxLauncher({ capability: NO_FLOOR_CAP, env: 'prod' });
    const t = new StdioMcpTransport({
      cwd: '/ws',
      sandboxLauncher: launcher,
      workspaceRoots: ['/ws'],
    });
    // @ts-expect-error método privado
    const target = t.resolveSpawnTarget(server());
    expect(target.refused).toBe(true);
    expect(target.warning).toBeTruthy(); // aviso inequívoco
  });

  it('DEGRADE (dev sem piso): spawna o server CRU + aviso (nunca finge confinamento)', () => {
    const launcher = new BwrapSandboxLauncher({ capability: NO_FLOOR_CAP, env: 'dev' });
    const t = new StdioMcpTransport({
      cwd: '/ws',
      sandboxLauncher: launcher,
      workspaceRoots: ['/ws'],
    });
    // @ts-expect-error método privado
    const target = t.resolveSpawnTarget(server());
    expect(target.command).toBe('/usr/bin/the-server'); // server CRU (sem bwrap)
    expect(target.refused).toBe(false);
    expect(target.warning).toBeTruthy(); // aviso de "sem piso de SO"
  });

  it('REFUSE: o connect() LANÇA (a descoberta trata fail-soft), não conecta', async () => {
    const launcher = new BwrapSandboxLauncher({ capability: NO_FLOOR_CAP, env: 'prod' });
    const t = new StdioMcpTransport({
      cwd: '/ws',
      sandboxLauncher: launcher,
      workspaceRoots: ['/ws'],
    });
    await expect(t.connect(server())).rejects.toThrow(/recus|sandbox|piso/i);
  });
});

describe('buildConfinedInvocation (launcher) — forma do invólucro', () => {
  it('confine: command=/bin/sh, exec bwrap, cleanup remove o filtro', () => {
    const l = new BwrapSandboxLauncher({ capability: FLOOR_CAP, env: 'dev' });
    const inv = l.buildConfinedInvocation(['/usr/bin/srv', '--x'], {
      workspaceRoots: ['/ws'],
      cwd: '/ws',
    });
    expect(inv.decision.action).toBe('confine');
    expect(inv.command).toBe('/bin/sh');
    const script = String(inv.args![1]);
    const m = script.match(/3< '([^']+)'/)!;
    expect(existsSync(m[1]!)).toBe(true);
    inv.cleanup();
    expect(existsSync(m[1]!)).toBe(false);
  });

  it('refuse (prod sem piso): command ausente (não conecta)', () => {
    const l = new BwrapSandboxLauncher({ capability: NO_FLOOR_CAP, env: 'prod' });
    const inv = l.buildConfinedInvocation(['/usr/bin/srv'], {
      workspaceRoots: ['/ws'],
      cwd: '/ws',
    });
    expect(inv.decision.action).toBe('refuse');
    expect(inv.command).toBeUndefined();
  });

  it('rejeita bind/cwd que alcance ~/.aluy/ (defesa em profundidade)', () => {
    const l = new BwrapSandboxLauncher({
      capability: FLOOR_CAP,
      env: 'dev',
      aluyHome: '/home/u/.aluy',
    });
    expect(() =>
      l.buildConfinedInvocation(['/usr/bin/srv'], {
        workspaceRoots: ['/home/u/.aluy/memory'],
        cwd: '/home/u/.aluy/memory',
      }),
    ).toThrow(/\.aluy/);
  });
});

describe('resolveLaunchBinds — paths de lançamento (binário + script)', () => {
  it('absoluto fora de system ⇒ binda; script absoluto existente ⇒ binda', () => {
    // process.execPath é o node real (fora de /usr num nvm) — deve ser bindado.
    const binds = resolveLaunchBinds(process.execPath, [], process.env);
    if (!process.execPath.startsWith('/usr/')) {
      expect(binds).toContain(process.execPath);
    }
  });

  it('binário sob /usr (já montado) NÃO é re-bindado (sem ruído)', () => {
    const binds = resolveLaunchBinds('/usr/bin/node', ['--flag', 'naoexiste.txt'], process.env);
    expect(binds).not.toContain('/usr/bin/node');
    // arg que não é arquivo absoluto existente é ignorado.
    expect(binds).toEqual([]);
  });

  it('command sem PATH-match ⇒ omitido (bwrap reporta exec honesto)', () => {
    const binds = resolveLaunchBinds('binario-que-nao-existe-xyz', [], { PATH: '/usr/bin' });
    expect(binds).toEqual([]);
  });
});

// silencia o aviso de degrade no stderr durante os testes de wiring (não polui a saída).
vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
