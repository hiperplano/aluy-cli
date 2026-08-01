// ADR-0158 §5 — RUNNER: mecânica de PIDFILE (grava/lê/checa-vivo/remove). Espelha o
// padrão de sidecar do turbo (spawn destacado + `.unref()`, `sidecar-provisioner.ts`)
// mas com IDENTIDADE persistida em disco — o turbo não precisa (o sidecar não tem
// `stop` granular por nome; um serviço precisa, §5: "start/stop granular por
// serviço"). `~/.aluy/services/<nome>/.state/runner.pid` é a fonte de verdade de
// "este serviço está RODANDO" (cruzado com `kill(pid, 0)` — um pidfile órfão de um
// processo morto NUNCA finge que está rodando).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Garante o dir do pidfile (mode 0700, idempotente, best-effort). */
function ensureParentDir(path: string): void {
  try {
    mkdirSync(dirname(path), { mode: DIR_MODE, recursive: true });
  } catch {
    /* best-effort — fail-safe */
  }
}

/** Grava o pid no arquivo (atômico o bastante p/ um pidfile — sobrescreve). */
export function writePidFile(path: string, pid: number): void {
  ensureParentDir(path);
  writeFileSync(path, `${pid}\n`, { mode: FILE_MODE });
}

/** Lê o pid do arquivo. `undefined` ⇒ ausente/ilegível/conteúdo não-numérico. */
export function readPidFile(path: string): number | undefined {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Remove o pidfile (best-effort — `stop`/o próprio runner ao sair chamam). */
export function removePidFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * `true` se existe um PROCESSO vivo com este pid — via `kill(pid, 0)` (sinal 0 não
 * mata; só testa permissão+existência — padrão POSIX; funciona em Windows também,
 * onde o Node emula via `OpenProcess`). Fail-safe: qualquer erro inesperado ⇒ `false`
 * (nunca finge "vivo" na dúvida — evita `start` recusar por engano um serviço morto).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = processo não existe. EPERM = existe mas é de outro dono (ainda "vivo"
    // p/ nosso propósito — contamos como rodando, mesma disciplina POSIX de `kill -0`).
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `true` se o pidfile aponta para um processo VIVO agora (a checagem completa). */
export function isRunnerAlive(pidFilePath: string): boolean {
  const pid = readPidFile(pidFilePath);
  return pid !== undefined && isProcessAlive(pid);
}

export function pidFileExists(path: string): boolean {
  return existsSync(path);
}
