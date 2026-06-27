// EST-1009 · ADR-0065 §1 — DETECÇÃO de capability com probes INJETADOS (sem tocar
// o SO real). Prova: bwrap-presente/ausente, userns-on/off, seccomp, Landlock
// aditivo, plataforma != linux ⇒ tudo indisponível com motivo. NUNCA finge.

import { describe, expect, it, vi } from 'vitest';
import { detectSandboxCapability } from '../../src/sandbox/capability.js';

/** spawnSync FAKE p/ `bwrap --version`: ok|fail. */
function spawnSyncFake(ok: boolean) {
  return vi.fn(() =>
    ok
      ? ({ status: 0, stdout: 'bubblewrap 0.11.0\n', stderr: '', error: undefined } as never)
      : ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') } as never),
  ) as never;
}

/** readFile FAKE a partir de um mapa path→conteúdo (ausente ⇒ undefined). */
function readFileFake(map: Record<string, string>) {
  return (p: string): string | undefined => map[p];
}

describe('detectSandboxCapability — Linux com piso completo', () => {
  it('bwrap ok + userns on + seccomp + landlock ⇒ tudo true, sem motivo', () => {
    const cap = detectSandboxCapability({
      platform: 'linux',
      arch: 'x64',
      spawnSyncFn: spawnSyncFake(true),
      readFile: readFileFake({
        '/proc/self/status': 'Name:\tnode\nSeccomp:\t2\n',
        '/proc/self/lsm': 'capability,landlock,yama,apparmor',
      }),
    });
    expect(cap.platform).toBe('linux');
    expect(cap.bwrap).toBe(true);
    expect(cap.userns).toBe(true);
    expect(cap.seccomp).toBe(true);
    expect(cap.landlock).toBe(true);
    expect(cap.unavailableReason).toBeUndefined();
  });
});

describe('detectSandboxCapability — faltantes geram MOTIVO (aviso inequívoco)', () => {
  it('bwrap ausente ⇒ bwrap=false + motivo', () => {
    const cap = detectSandboxCapability({
      platform: 'linux',
      arch: 'x64',
      spawnSyncFn: spawnSyncFake(false),
      readFile: readFileFake({ '/proc/self/status': 'Seccomp:\t2\n' }),
    });
    expect(cap.bwrap).toBe(false);
    expect(cap.unavailableReason).toBeTruthy();
    expect(cap.unavailableReason!.toLowerCase()).toContain('bwrap');
  });

  it('userns DESLIGADO (max_user_namespaces=0) ⇒ userns=false + motivo', () => {
    const cap = detectSandboxCapability({
      platform: 'linux',
      arch: 'x64',
      spawnSyncFn: spawnSyncFake(true),
      readFile: readFileFake({
        '/proc/sys/user/max_user_namespaces': '0\n',
        '/proc/self/status': 'Seccomp:\t2\n',
      }),
    });
    expect(cap.userns).toBe(false);
    expect(cap.unavailableReason).toContain('userns');
  });

  it('unprivileged_userns_clone=0 ⇒ userns=false', () => {
    const cap = detectSandboxCapability({
      platform: 'linux',
      arch: 'x64',
      spawnSyncFn: spawnSyncFake(true),
      readFile: readFileFake({
        '/proc/sys/kernel/unprivileged_userns_clone': '0\n',
        '/proc/self/status': 'Seccomp:\t2\n',
      }),
    });
    expect(cap.userns).toBe(false);
  });

  it('seccomp não compilado ⇒ seccomp=false', () => {
    const cap = detectSandboxCapability({
      platform: 'linux',
      arch: 'x64',
      spawnSyncFn: spawnSyncFake(true),
      readFile: readFileFake({ '/proc/self/status': 'Name:\tnode\n' }), // sem Seccomp:
    });
    expect(cap.seccomp).toBe(false);
  });

  it('arch não-mapeada ⇒ seccomp=false (não finge filtro p/ arch desconhecida)', () => {
    const cap = detectSandboxCapability({
      platform: 'linux',
      arch: 'mips',
      spawnSyncFn: spawnSyncFake(true),
      readFile: readFileFake({ '/proc/self/status': 'Seccomp:\t2\n' }),
    });
    expect(cap.seccomp).toBe(false);
  });
});

describe('detectSandboxCapability — Landlock é ADITIVO (não condiciona o piso)', () => {
  it('sem landlock no lsm ⇒ landlock=false, mas bwrap/userns/seccomp seguem true', () => {
    const cap = detectSandboxCapability({
      platform: 'linux',
      arch: 'x64',
      spawnSyncFn: spawnSyncFake(true),
      readFile: readFileFake({
        '/proc/self/status': 'Seccomp:\t2\n',
        '/proc/self/lsm': 'capability,yama,apparmor',
      }),
    });
    expect(cap.landlock).toBe(false);
    expect(cap.bwrap && cap.userns && cap.seccomp).toBe(true);
    // sem landlock NÃO gera motivo de indisponibilidade do piso (é só reforço).
    expect(cap.unavailableReason).toBeUndefined();
  });
});

describe('detectSandboxCapability — não-Linux (Fase 1 = Linux, D-SB-1)', () => {
  it.each(['darwin', 'win32'])('plataforma %s ⇒ tudo indisponível + motivo de fase', (plat) => {
    const cap = detectSandboxCapability({ platform: plat, arch: 'x64' });
    expect(cap.bwrap).toBe(false);
    expect(cap.userns).toBe(false);
    expect(cap.seccomp).toBe(false);
    expect(cap.landlock).toBe(false);
    expect(cap.unavailableReason).toContain('Fase 1');
  });
});
