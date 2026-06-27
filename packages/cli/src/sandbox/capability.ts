// EST-1009 · ADR-0065 §1 / CLI-SEC-H1 — DETECÇÃO de capability do sandbox (I/O de SO).
//
// O processo-MÃE detecta no boot se o piso de SO está disponível: `bwrap`
// presente/executável, user namespaces rootless habilitados, seccomp-bpf, e
// Landlock (LSM ≥5.13, REFORÇO aditivo). O resultado é DADO serializável
// (`SandboxCapability` do core) que a lógica de fail-mode (PURA) consome — e que o
// `/doctor` pode reportar (FU). NUNCA finge suporte: em qualquer dúvida, reporta
// indisponível com motivo legível (o fail-mode então degrada/recusa, com aviso).
//
// Este arquivo TOCA o SO (`node:child_process`/`node:os`/`node:fs`) ⇒ mora no
// @hiperplano/aluy-cli, não no core portável. A DECISÃO (fail-mode) é do core; a DETECÇÃO é aqui.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os';
import type { SandboxCapability } from '@hiperplano/aluy-cli-core';
import { seccompArchOf } from '@hiperplano/aluy-cli-core';

export interface DetectCapabilityOptions {
  /** Plataforma (default `os.platform()`). Injetável p/ teste. */
  readonly platform?: NodeJS.Platform | string;
  /** Arch do Node (default `os.arch()`). Injetável p/ teste. */
  readonly arch?: string;
  /** spawnSync injetável (default `node:child_process`). Testes mockam `bwrap`. */
  readonly spawnSyncFn?: typeof spawnSync;
  /** Leitor de arquivo de probe (default `fs.readFileSync`/`existsSync`). */
  readonly readFile?: (path: string) => string | undefined;
}

/** `bwrap --version` roda? (presente E executável). Fail-safe: erro ⇒ false. */
function probeBwrap(spawnSyncFn: typeof spawnSync): { ok: boolean; detail: string } {
  try {
    const r = spawnSyncFn('bwrap', ['--version'], { timeout: 3000, encoding: 'utf8' });
    if (r.error) return { ok: false, detail: `bwrap não executável (${r.error.message})` };
    if (r.status !== 0) return { ok: false, detail: 'bwrap retornou status != 0' };
    const ver = (r.stdout ?? '').trim();
    return { ok: true, detail: ver || 'bwrap presente' };
  } catch (e) {
    return { ok: false, detail: `bwrap ausente (${e instanceof Error ? e.message : String(e)})` };
  }
}

/**
 * user namespaces rootless disponíveis? Em kernels modernos é o default. Checamos
 * sinais NÃO-destrutivos:
 *   - `max_user_namespaces > 0` (se o knob existe e for 0, userns está desligado);
 *   - `unprivileged_userns_clone` == 1 (knob do Debian/Ubuntu; ausente ⇒ não bloqueia).
 * Conservador: só reporta `false` quando há EVIDÊNCIA de desligado; ausência dos
 * knobs ⇒ assume habilitado (default moderno). A PROVA real é o `bwrap` rodar —
 * por isso a detecção é best-effort e o lançamento valida de fato (fail-safe).
 */
function probeUserns(readFile: (p: string) => string | undefined): {
  ok: boolean;
  detail: string;
} {
  const maxNs = readFile('/proc/sys/user/max_user_namespaces');
  if (maxNs !== undefined && /^\s*0\s*$/.test(maxNs)) {
    return { ok: false, detail: 'max_user_namespaces=0 (userns desativado)' };
  }
  const clone = readFile('/proc/sys/kernel/unprivileged_userns_clone');
  if (clone !== undefined && /^\s*0\s*$/.test(clone)) {
    return { ok: false, detail: 'unprivileged_userns_clone=0 (userns rootless bloqueado)' };
  }
  return { ok: true, detail: 'userns disponível' };
}

/**
 * seccomp-bpf disponível? Sinais: o kernel anuncia `Seccomp:` em /proc/self/status
 * (presença do campo ⇒ suporte compilado) E a arch do Node tem mapa de syscalls
 * (x64/arm64). Sem mapa de arch ⇒ não geramos filtro ⇒ reporta indisponível
 * (NUNCA finge o filtro p/ uma arch que não conhecemos).
 */
function probeSeccomp(
  nodeArch: string,
  readFile: (p: string) => string | undefined,
): { ok: boolean; detail: string } {
  if (!seccompArchOf(nodeArch)) {
    return { ok: false, detail: `seccomp: arch ${nodeArch} não mapeada (sem filtro)` };
  }
  const status = readFile('/proc/self/status');
  if (status !== undefined && !/\bSeccomp:/.test(status)) {
    return { ok: false, detail: 'seccomp não compilado no kernel' };
  }
  return { ok: true, detail: 'seccomp-bpf disponível' };
}

/**
 * §13.2 — CONFINAMENTO DE RECURSO (cgroup v2) disponível via `systemd-run --user`?
 * É o que envolve o `bwrap` com TasksMax/MemoryMax/CPUQuota p/ fechar o fork-bomb/DoS
 * (camada DISTINTA do bwrap: bwrap confina FUGA, cgroup confina RECURSO). Probe LEVE
 * e não-destrutivo: `systemd-run --user --version` roda (binário presente + bus de
 * usuário acessível)? Não criamos scope aqui — só confirmamos a ferramenta. A PROVA
 * real é o scope subir no lançamento; sem a ferramenta, NEM tentamos (fail-safe:
 * degrade-com-aviso, nunca finge teto de recurso). Erro/timeout ⇒ false.
 */
function probeSystemdRun(spawnSyncFn: typeof spawnSync): { ok: boolean; detail: string } {
  try {
    const r = spawnSyncFn('systemd-run', ['--user', '--version'], {
      timeout: 3000,
      encoding: 'utf8',
    });
    if (r.error) {
      return { ok: false, detail: `systemd-run --user indisponível (${r.error.message})` };
    }
    if (r.status !== 0) {
      // status != 0 normalmente = sem bus de usuário (`--user` sem sessão systemd) ⇒
      // delegação rootless de cgroup indisponível nesta máquina.
      return { ok: false, detail: 'systemd-run --user retornou status != 0 (sem bus de usuário?)' };
    }
    return { ok: true, detail: 'systemd-run --user (cgroup v2 rootless) disponível' };
  } catch (e) {
    return {
      ok: false,
      detail: `systemd-run ausente (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

/**
 * Landlock (LSM, kernel ≥5.13) disponível? REFORÇO ADITIVO de FS (nunca único —
 * ADR-0065 §1). Sinal: `landlock` listado em /proc/self/lsm OU o securityfs do
 * landlock presente. Indisponível NÃO degrada o piso (Landlock é extra); só
 * informa que o reforço extra está/não ausente.
 */
function probeLandlock(readFile: (p: string) => string | undefined): boolean {
  const lsm = readFile('/proc/self/lsm');
  if (lsm !== undefined && /\blandlock\b/.test(lsm)) return true;
  // Fallback: alguns kernels expõem o atributo via securityfs.
  if (existsSync('/sys/kernel/security/landlock')) return true;
  return false;
}

function defaultReadFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * DETECTA a capability do sandbox nesta máquina. Resultado serializável (core).
 * Em plataforma != linux, reporta tudo indisponível com motivo (Fase 1 = Linux,
 * D-SB-1 — macOS/Windows são fases seguintes). NUNCA finge: erro ⇒ indisponível.
 */
export function detectSandboxCapability(opts: DetectCapabilityOptions = {}): SandboxCapability {
  const platform = opts.platform ?? osPlatform();
  const nodeArch = opts.arch ?? osArch();
  const readFile = opts.readFile ?? defaultReadFile;
  const kernel = (() => {
    try {
      return osRelease();
    } catch {
      return undefined;
    }
  })();

  if (platform !== 'linux') {
    return {
      platform,
      bwrap: false,
      userns: false,
      seccomp: false,
      landlock: false,
      cgroupLimits: false,
      ...(kernel ? { kernel } : {}),
      unavailableReason: `Fase 1 do sandbox é Linux (D-SB-1); plataforma ${platform} ainda sem piso de SO`,
    };
  }

  const spawnSyncFn = opts.spawnSyncFn ?? spawnSync;
  const bw = probeBwrap(spawnSyncFn);
  const uns = probeUserns(readFile);
  const sec = probeSeccomp(nodeArch, readFile);
  const landlock = probeLandlock(readFile);
  // §13.2 — cgroup v2 via systemd-run --user. ADITIVO (não entra no motivo do PISO
  // de fuga abaixo; sua ausência só desliga o teto de RECURSO, com aviso no lançador).
  const cgroup = probeSystemdRun(spawnSyncFn);

  // Motivo de indisponibilidade do PISO (bwrap+userns+seccomp). Landlock é aditivo
  // (não entra no motivo do piso). Concatena os faltantes, p/ o aviso ser preciso.
  const missing: string[] = [];
  if (!bw.ok) missing.push(bw.detail);
  if (!uns.ok) missing.push(uns.detail);
  if (!sec.ok) missing.push(sec.detail);

  return {
    platform,
    bwrap: bw.ok,
    userns: uns.ok,
    seccomp: sec.ok,
    landlock,
    cgroupLimits: cgroup.ok,
    ...(kernel ? { kernel } : {}),
    ...(missing.length > 0 ? { unavailableReason: missing.join('; ') } : {}),
  };
}
