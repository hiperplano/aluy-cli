// ADR-0158 §6 — RUNNER: ciclo de vida dos DAEMONS PRÓPRIOS do usuário
// (`daemons/<nome>/daemon.md`). O aluy só SOBE/DERRUBA — nunca interpreta o que
// fazem ("o runner que vem com o aluy é MÍNIMO e burro de propósito", §6). Mesmo
// padrão de spawn destacado dos sidecars do turbo (`sidecar-provisioner.ts`:
// `detached:true` + `stdio` p/ arquivo + `.unref()`), generalizado p/ processo do
// USUÁRIO em vez de Ollama/mem0.
//
// Fronteira de segurança HONESTA (§6/§Consequências): os daemons rodam FORA da
// catraca — como qualquer software que o dono instala na máquina. `aluy service
// start` já os sobe como ATO EXPLÍCITO do dono (a confiança foi dada no `install`,
// que mostrou o "manifesto visível" — §9).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDaemonManifest, isDaemonManifestError, type DaemonManifest } from '@hiperplano/aluy-cli-core';
import { daemonLogPath, daemonPidPath, serviceStateDir } from './paths.js';
import { writePidFile, readPidFile, isProcessAlive, removePidFile } from './pid.js';

export interface DeclaredDaemon {
  readonly name: string;
  readonly manifest: DaemonManifest;
}

/** Lê `daemons/<nome>/daemon.md` do serviço. `daemon.md` ausente/inválido ⇒ IGNORADO com
 * aviso no log (não derruba os demais nem o runner — §6, ciclo de vida best-effort
 * sobre CÓDIGO DO USUÁRIO, que pode estar incompleto durante o desenvolvimento). */
export function listDeclaredDaemons(serviceDir: string, log: (line: string) => void): DeclaredDaemon[] {
  const daemonsDir = join(serviceDir, 'daemons');
  let entries: string[];
  try {
    entries = readdirSync(daemonsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return []; // sem daemons/ ⇒ nenhum declarado (comum — daemons são opcionais).
  }
  const out: DeclaredDaemon[] = [];
  for (const name of entries) {
    const mdPath = join(daemonsDir, name, 'daemon.md');
    let raw: string;
    try {
      raw = readFileSync(mdPath, 'utf8');
    } catch {
      log(`daemon "${name}": sem daemon.md legível em ${mdPath} — ignorado.`);
      continue;
    }
    const parsed = parseDaemonManifest(raw);
    if (isDaemonManifestError(parsed)) {
      log(`daemon "${name}": ${parsed.reason} — ignorado.`);
      continue;
    }
    out.push({ name, manifest: parsed });
  }
  return out;
}

/**
 * Sobe todos os daemons declarados que ainda NÃO estão rodando (idempotente — um
 * daemon já vivo, pelo pidfile, é PULADO). `command:` roda via shell (`sh -c` /
 * `cmd /c` no Windows) — é a linha de comando do DONO, a mesma confiança de um
 * script de skill. stdout/stderr vão para `.state/<daemon>.log`; DESTACADO
 * (`detached:true` + `.unref()`) — mesmo padrão do `ollama serve` do turbo.
 */
export function startDaemons(serviceDir: string, log: (line: string) => void): void {
  mkdirSync(serviceStateDir(serviceDir), { mode: 0o700, recursive: true });
  const declared = listDeclaredDaemons(serviceDir, log);
  for (const d of declared) {
    const pidPath = daemonPidPath(serviceDir, d.name);
    const existingPid = readPidFile(pidPath);
    if (existingPid !== undefined && isProcessAlive(existingPid)) {
      log(`daemon "${d.name}": já rodando (pid ${existingPid}) — pulado.`);
      continue;
    }
    const logPath = daemonLogPath(serviceDir, d.name);
    let fd: number;
    try {
      fd = openSync(logPath, 'a', 0o600);
    } catch (e) {
      log(`daemon "${d.name}": falha ao abrir log ${logPath} — ${String(e)}. NÃO subiu.`);
      continue;
    }
    try {
      const shell = process.platform === 'win32' ? 'cmd' : 'sh';
      const shellArgs = process.platform === 'win32' ? ['/c', d.manifest.command] : ['-c', d.manifest.command];
      const child = spawn(shell, shellArgs, {
        cwd: join(serviceDir, 'daemons', d.name),
        detached: true,
        stdio: ['ignore', fd, fd],
        env: process.env,
      });
      child.unref();
      if (child.pid !== undefined) {
        writePidFile(pidPath, child.pid);
        log(
          `daemon "${d.name}": subiu (pid ${child.pid})${d.manifest.port !== undefined ? ` · porta ${d.manifest.port}` : ''}.`,
        );
      } else {
        log(`daemon "${d.name}": spawn não devolveu pid — pode não ter subido.`);
      }
    } catch (e) {
      log(`daemon "${d.name}": falha ao dar spawn — ${String(e)}.`);
    }
  }
}

/** Derruba (SIGTERM, com SIGKILL de timeout) todos os daemons COM pidfile — não
 * precisa reler `daemon.md` (o pidfile já diz quem está de pé). */
export function stopDaemons(serviceDir: string, log: (line: string) => void): void {
  const stateDir = serviceStateDir(serviceDir);
  let entries: string[];
  try {
    entries = readdirSync(stateDir).filter((f) => f.endsWith('.pid') && f !== 'runner.pid');
  } catch {
    return; // sem .state/ ⇒ nada a derrubar.
  }
  for (const file of entries) {
    const name = file.slice(0, -'.pid'.length);
    const pidPath = join(stateDir, file);
    const pid = readPidFile(pidPath);
    if (pid === undefined) {
      removePidFile(pidPath);
      continue;
    }
    if (!isProcessAlive(pid)) {
      log(`daemon "${name}": pidfile órfão (pid ${pid} já morto) — limpo.`);
      removePidFile(pidPath);
      continue;
    }
    // ACHADO DO SMOKE-TEST MANUAL (fase 2): `command:` roda via `sh -c "<comando>"`
    // (`startDaemons`) — em vários `/bin/sh` (dash/bash) isso FORCA (não faz exec-
    // replace), então o pid gravado é o da SHELL, não do processo real do dono
    // (`sleep 300` etc.), que fica como FILHO dela. Matar só o pid da shell mata a
    // shell e deixa o filho ÓRFÃO rodando pra sempre — exatamente o daemon "próprio"
    // que devíamos ter derrubado. `detached:true` no spawn (`startDaemons`) fez do
    // processo o LÍDER DE UMA SESSÃO NOVA (setsid) — o PGID dele é o próprio pid.
    // `kill(-pid, sig)` (POSIX, pid NEGATIVO) manda o sinal pro GRUPO INTEIRO —
    // shell + todo filho que ela tenha forkado — sem precisar rastrear netos.
    try {
      process.kill(-pid, 'SIGTERM');
      log(`daemon "${name}": SIGTERM enviado ao grupo do processo (pid ${pid}).`);
    } catch {
      // Windows não tem grupo de processo POSIX (kill(-pid) falha) — cai pro pid
      // direto (best-effort; sem grupo lá, não há filho órfão do MESMO jeito).
      try {
        process.kill(pid, 'SIGTERM');
        log(`daemon "${name}": SIGTERM enviado (pid ${pid}).`);
      } catch {
        /* já morreu entre o check e o kill — ok */
      }
    }
    removePidFile(pidPath);
  }
}

/** `true` se o daemon.md aponta p/ um daemon com pidfile ausente. Best-effort, útil
 * pro `/doctor`/manifesto visível listar quais daemons DECLARADOS existem no disco. */
export function daemonMdExists(serviceDir: string, name: string): boolean {
  return existsSync(join(serviceDir, 'daemons', name, 'daemon.md'));
}
