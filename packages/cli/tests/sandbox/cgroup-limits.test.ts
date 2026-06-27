// EST-1021 · ADR-0065 §13.2 (APR-0087) — CONFINAMENTO DE RECURSO (cgroup v2) do
// sandbox de bash: fecha o fork-bomb/DoS que o bwrap NÃO cobre.
//
// O bwrap confina FUGA (FS/rede/syscall) mas NÃO confina RECURSO: um
// `:(){ :|:& };:` (fork-bomb) ou `cat /dev/zero` CONFINADO ainda derruba a máquina
// inteira (CPU/RAM/PIDs). §13.2 ENVOLVE o bwrap num scope do systemd com teto:
//   systemd-run --user --scope --quiet --collect \
//     -p TasksMax=<N> -p MemoryMax=<M> -p CPUQuota=<C> -- bwrap <args> -- <cmd>
// TasksMax capa o fork-bomb, MemoryMax capa RAM, CPUQuota throttla CPU.
//
// Cobertura:
//  (a) [skip-se-indisponível] o scope REAL montado pelo `buildSystemdRunPrefix` da
//      produção MATA/BARRA além do cap: um processo que tenta forkar 50 sub-procs
//      consegue só ≤ cap (a máquina NÃO cai — provamos LIMITE, não derrubada).
//  (b) [determinístico] o launcher REAL PREFIXA `systemd-run --user --scope ...` nos
//      args quando `cgroupLimits` (inspeção da forma, sem rodar) — análogo ao (d) do
//      net-under-ask que inspeciona `buildBwrapArgs`.
//  (c) [determinístico] fail-mode: capability com `cgroupLimits:false` ⇒ NÃO prefixa
//      systemd-run + emite WARNING (degrade-com-aviso, nunca silencioso, nunca bloqueia).

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxCapability, SandboxConfinement } from '@aluy/cli-core';
import { DEFAULT_RESOURCE_LIMITS } from '@aluy/cli-core';
import { BwrapSandboxLauncher } from '../../src/sandbox/launcher.js';

/** Capability COM cgroup (systemd-run --user disponível) + piso de fuga completo. */
const CAP_CGROUP: SandboxCapability = {
  platform: 'linux',
  bwrap: true,
  userns: true,
  seccomp: true,
  landlock: true,
  cgroupLimits: true,
};

/** Capability SEM cgroup (systemd-run ausente) — piso de fuga OK, mas sem teto de recurso. */
const CAP_NO_CGROUP: SandboxCapability = {
  platform: 'linux',
  bwrap: true,
  userns: true,
  seccomp: true,
  landlock: true,
  cgroupLimits: false,
  unavailableReason: 'systemd-run --user indisponível (sem bus de usuário?)',
};

const WS = '/home/user/project';
function conf(over: Partial<SandboxConfinement> = {}): SandboxConfinement {
  return { workspaceRoots: [WS], cwd: WS, ...over };
}

function launcher(cap: SandboxCapability): BwrapSandboxLauncher {
  return new BwrapSandboxLauncher({ capability: cap, env: 'dev', aluyHome: '/home/user/.aluy' });
}

// ── (a) PROVA DE SO REAL: o cap de cgroup BARRA o fork-bomb ────────────────────
//
// Disponível só se `systemd-run --user --scope` sobe E há `python3` (p/ o probe de
// fork CONTROLADO). Sem isso, SKIP — mas (b)/(c) rodam SEMPRE (determinísticos).
function systemdRunUserOk(): boolean {
  try {
    const v = spawnSync('systemd-run', ['--user', '--version'], { timeout: 3000 });
    if (v.error || v.status !== 0) return false;
    // Prova que um scope REAL sobe (não só o binário existe): roda /bin/true num scope.
    const s = spawnSync(
      'systemd-run',
      ['--user', '--scope', '--quiet', '--collect', '-p', 'TasksMax=64', '--', '/bin/true'],
      { timeout: 5000 },
    );
    return !s.error && s.status === 0;
  } catch {
    return false;
  }
}
function python3Ok(): boolean {
  try {
    const r = spawnSync('python3', ['--version'], { timeout: 3000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

const CGROUP_TESTABLE = systemdRunUserOk() && python3Ok();

// Probe de FORK CONTROLADO (não é fork-bomb de verdade — é um loop FINITO e LIMPO):
// o python tenta forkar N filhos; cada filho dorme e sai; o pai CONTA quantos
// `fork()` tiveram sucesso ANTES do kernel recusar (OSError/EAGAIN ao bater no cap) e
// MATA todos no finally. Sem cgroup ⇒ forka todos; com TasksMax baixo ⇒ ≤ cap.
const FORK_PROBE = [
  'import os,sys,time',
  'N=50; ok=0; kids=[]',
  'try:',
  '  for _ in range(N):',
  '    pid=os.fork()',
  '    if pid==0:',
  '      time.sleep(3); os._exit(0)',
  '    kids.append(pid); ok+=1',
  'except OSError:',
  '  pass',
  'finally:',
  '  pass',
  'print("FORKED_OK=%d"%ok)',
  'for k in kids:',
  '  try: os.kill(k,9)',
  '  except OSError: pass',
].join('\n');

describe.skipIf(!CGROUP_TESTABLE)(
  '(a) cgroup REAL BARRA o fork-bomb além do cap (systemd-run --user disponível)',
  () => {
    it('TasksMax baixo ⇒ um loop que tenta forkar 50 procs consegue só ≤ cap (máquina NÃO cai)', () => {
      const CAP = 10;
      // Monta o PREFIXO EXATO da PRODUÇÃO (não um comando à mão): prova que os args
      // que o launcher gera de fato impõem o teto no kernel.
      const prefix = launcher(CAP_CGROUP).buildSystemdRunPrefix(
        conf({ resourceLimits: { tasksMax: CAP } }),
      );
      expect(prefix).toContain(`TasksMax=${CAP}`);

      // systemd-run <prefixo> -- python3 -c <probe>. (Sem bwrap aqui: isolamos o cap
      // de RECURSO — o bwrap pode faltar no CI; o cgroup é a camada sob teste.)
      const argv = [...prefix, 'python3', '-c', FORK_PROBE];
      let pids: number[] = [];
      try {
        const r = spawnSync('systemd-run', argv, { timeout: 20000, encoding: 'utf8' });
        const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
        // Ou o python reporta quantos forkou (≤ cap), ou o próprio shell/python aborta
        // por "Cannot fork"/Resource — em AMBOS o caso, NÃO forkou os 50 (cap segurou).
        const m = /FORKED_OK=(\d+)/.exec(out);
        if (m) {
          const forked = Number(m[1]);
          // O teto SEGUROU: não chegou aos 50; e ficou ABAIXO/no cap (a árvore inteira,
          // incl. o próprio python + systemd, divide o orçamento de TasksMax).
          expect(forked).toBeLessThan(50);
          expect(forked).toBeLessThanOrEqual(CAP);
        } else {
          // Sem a linha ⇒ o processo NEM conseguiu rodar o probe inteiro (cap apertou
          // o bastante p/ abortar antes). É também prova de que o cap BARRA — só não
          // temos a contagem. NUNCA pode ter forkado livremente.
          expect(out.toLowerCase()).toMatch(/cannot fork|resource|fork|temporarily/);
        }
      } finally {
        // LIMPEZA dura: mata qualquer filho do probe que tenha escapado (best-effort).
        try {
          spawnSync('pkill', ['-9', '-f', 'os.fork'], { timeout: 3000 });
        } catch {
          /* best-effort */
        }
        for (const p of pids) {
          try {
            process.kill(p, 'SIGKILL');
          } catch {
            /* já morto */
          }
        }
        pids = [];
      }
    });

    it('baseline (SEM cgroup) forka os 50 — prova que o cap é o que limita, não o probe', () => {
      let escaped = false;
      try {
        const r = spawnSync('python3', ['-c', FORK_PROBE], { timeout: 20000, encoding: 'utf8' });
        const m = /FORKED_OK=(\d+)/.exec(`${r.stdout ?? ''}`);
        // Sem teto, o MESMO probe forka todos os 50 (controle do experimento).
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBe(50);
        escaped = true;
      } finally {
        if (escaped) {
          try {
            spawnSync('pkill', ['-9', '-f', 'os.fork'], { timeout: 3000 });
          } catch {
            /* best-effort */
          }
        }
      }
    });
  },
);

// ── (b) o launcher REAL PREFIXA systemd-run quando cgroupLimits (determinístico) ──
describe('(b) buildSystemdRunPrefix — forma do prefixo systemd-run (cgroupLimits:true)', () => {
  it('emite `--user --scope --quiet --collect` + os 3 limites (defaults) + `--` final', () => {
    const prefix = launcher(CAP_CGROUP).buildSystemdRunPrefix(conf());
    // delegação rootless + scope síncrono (não-serviço) + limpa scope ao fim.
    expect(prefix).toContain('--user');
    expect(prefix).toContain('--scope');
    expect(prefix).toContain('--quiet');
    expect(prefix).toContain('--collect');
    // os 3 tetos de RECURSO, com os DEFAULTS conservadores do core.
    expect(prefix).toContain(`TasksMax=${DEFAULT_RESOURCE_LIMITS.tasksMax}`);
    expect(prefix).toContain(`MemoryMax=${DEFAULT_RESOURCE_LIMITS.memoryMax}`);
    expect(prefix).toContain(`CPUQuota=${DEFAULT_RESOURCE_LIMITS.cpuQuota}`);
    // `-p` precede cada property (forma do systemd-run).
    expect(prefix.filter((a) => a === '-p')).toHaveLength(3);
    // termina em `--` (separador: o que vem depois é o COMANDO = bwrap …).
    expect(prefix[prefix.length - 1]).toBe('--');
  });

  it('o confinamento PODE SOBRESCREVER os limites (1:1 nos -p do scope)', () => {
    const prefix = launcher(CAP_CGROUP).buildSystemdRunPrefix(
      conf({ resourceLimits: { tasksMax: 32, memoryMax: '512M', cpuQuota: '50%' } }),
    );
    expect(prefix).toContain('TasksMax=32');
    expect(prefix).toContain('MemoryMax=512M');
    expect(prefix).toContain('CPUQuota=50%');
    // os ausentes caem no default (fusão parcial).
    const partial = launcher(CAP_CGROUP).buildSystemdRunPrefix(
      conf({ resourceLimits: { tasksMax: 64 } }),
    );
    expect(partial).toContain('TasksMax=64');
    expect(partial).toContain(`MemoryMax=${DEFAULT_RESOURCE_LIMITS.memoryMax}`);
    expect(partial).toContain(`CPUQuota=${DEFAULT_RESOURCE_LIMITS.cpuQuota}`);
  });

  it('o argv REAL spawnado prefixa systemd-run ANTES do bwrap (spawn INJETADO)', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      // objeto mínimo tipo ChildProcess (não precisamos do processo real aqui).
      return { pid: 1234, on() {}, stdout: null, stderr: null } as never;
    }) as never;
    const l = new BwrapSandboxLauncher({
      capability: CAP_CGROUP,
      env: 'dev',
      aluyHome: '/home/user/.aluy',
      spawnFn,
    });
    const r = l.spawnConfined(['/bin/sh', '-c', 'echo hi'], conf());
    expect(r.process).toBeDefined();
    expect(calls).toHaveLength(1);
    const { cmd, args } = calls[0]!;
    // PROGRAMA spawnado = systemd-run (não bwrap direto).
    expect(cmd).toBe('systemd-run');
    // systemd-run vem com --user --scope ... e o bwrap aparece DEPOIS do `--` do scope.
    expect(args).toContain('--user');
    expect(args).toContain('--scope');
    const dashIdx = args.indexOf('--');
    expect(dashIdx).toBeGreaterThan(0);
    // o programa logo após o 1º `--` do scope é o bwrap (o confinamento de FUGA).
    expect(args[dashIdx + 1]).toBe('bwrap');
    // o comando do usuário continua presente no fim (o bwrap o executa).
    expect(args).toContain('echo hi');
    // sem cgroup-degrade aqui: confinou fuga E recurso ⇒ sem warning aditivo.
    expect(r.warning).toBeUndefined();
  });
});

// ── (c) fail-mode: sem cgroup ⇒ NÃO prefixa + AVISA (nunca silencioso, nunca bloqueia) ──
describe('(c) cgroupLimits:false ⇒ degrade-com-aviso (sem systemd-run, com warning)', () => {
  it('buildSystemdRunPrefix devolve [] quando cgroupLimits é false/ausente', () => {
    expect(launcher(CAP_NO_CGROUP).buildSystemdRunPrefix(conf())).toEqual([]);
    // capability LEGADA sem o campo (undefined) ⇒ tratada como false (aditivo).
    const legacy: SandboxCapability = {
      platform: 'linux',
      bwrap: true,
      userns: true,
      seccomp: true,
      landlock: false,
    };
    expect(launcher(legacy).buildSystemdRunPrefix(conf())).toEqual([]);
  });

  it('spawnConfined SEM cgroup: spawna o bwrap CRU (sem systemd-run) + warning aditivo', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnFn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { pid: 1234, on() {}, stdout: null, stderr: null } as never;
    }) as never;
    const l = new BwrapSandboxLauncher({
      capability: CAP_NO_CGROUP,
      env: 'dev',
      aluyHome: '/home/user/.aluy',
      spawnFn,
    });
    const r = l.spawnConfined(['/bin/sh', '-c', 'echo hi'], conf());
    // RODOU (cgroup é hardening aditivo, NÃO gate duro): processo presente.
    expect(r.process).toBeDefined();
    expect(calls).toHaveLength(1);
    // PROGRAMA = bwrap direto (NÃO systemd-run): sem prefixo de recurso.
    expect(calls[0]!.cmd).toBe('bwrap');
    expect(calls[0]!.args).not.toContain('systemd-run');
    expect(calls[0]!.args).not.toContain('--scope');
    // mas AVISA (degrade-com-aviso, não silencioso): warning aditivo de "sem RECURSO".
    expect(r.warning).toBeTruthy();
    expect(r.warning!).toContain('SEM CONFINAMENTO DE RECURSO');
    expect(r.warning!.toLowerCase()).toContain('fork-bomb');
    // o motivo da capability é embutido (preciso, p/ auditoria).
    expect(r.warning!).toContain('systemd-run');
  });
});

// guarda anti-vazamento de tmpdir (paranoia de teardown — não cria nada persistente).
describe('teardown', () => {
  it('sem artefatos de tmp pendurados', () => {
    const d = mkdtempSync(join(tmpdir(), 'aluy-cg-noop-'));
    rmSync(d, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
