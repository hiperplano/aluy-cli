// ADR-0158 §5/§8.1/§11 — RUNNER: o estado REAL de um serviço, para `status`/`list`/
// `/service` deixarem de mostrar sempre "parado" (fase 1) e passarem a mostrar
// rodando/parado, turno em andamento/dormindo-até-X, e pergunta pendente (§5 pt.4).
//
// Fonte de verdade de "RODANDO": o PIDFILE + `kill(pid,0)` (`pid.ts`) — nunca o
// `status.json` sozinho (um processo morto sem cleanup gracioso deixaria um
// `status.json` "turno em andamento" mentindo para sempre). `status.json` é
// BEST-EFFORT/informativo — cruzado contra o pidfile aqui.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRunnerAlive } from './pid.js';
import { runnerPidPath, runnerStatusPath } from './paths.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type ServiceTurnState = 'sleeping' | 'running-turn' | 'awaiting-owner';

/** O retrato que o RUNNER escreve a cada transição de estado (best-effort). */
export interface ServiceStatusSnapshot {
  readonly turnState: ServiceTurnState;
  /** ISO — próximo `schedule` (quando `turnState === 'sleeping'`). */
  readonly nextFireIso?: string;
  /** Resumo do ÚLTIMO turno fechado (sucesso/erro/aguardando) — p/ `status`. */
  readonly lastReportSummary?: string;
  /** A pergunta pendente, quando `turnState === 'awaiting-owner'` (§5 pt.4). */
  readonly pendingQuestion?: string;
  readonly updatedAtIso: string;
}

/** O estado COMPOSTO que `status`/`list`/`/service` exibem. */
export interface ServiceRuntimeStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly snapshot?: ServiceStatusSnapshot;
}

function ensureParentDir(path: string): void {
  try {
    mkdirSync(dirname(path), { mode: DIR_MODE, recursive: true });
  } catch {
    /* best-effort */
  }
}

/** Escreve o retrato (best-effort — chamado pelo runner a cada transição). */
export function writeServiceStatus(
  serviceDir: string,
  snapshot: Omit<ServiceStatusSnapshot, 'updatedAtIso'>,
): void {
  const path = runnerStatusPath(serviceDir);
  try {
    ensureParentDir(path);
    const full: ServiceStatusSnapshot = { ...snapshot, updatedAtIso: new Date().toISOString() };
    writeFileSync(path, JSON.stringify(full, null, 2), { mode: FILE_MODE });
  } catch {
    /* best-effort — status.json nunca é caminho crítico */
  }
}

function readSnapshot(serviceDir: string): ServiceStatusSnapshot | undefined {
  const path = runnerStatusPath(serviceDir);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServiceStatusSnapshot>;
    if (raw.turnState !== 'sleeping' && raw.turnState !== 'running-turn' && raw.turnState !== 'awaiting-owner') {
      return undefined;
    }
    return raw as ServiceStatusSnapshot;
  } catch {
    return undefined;
  }
}

/**
 * Lê o estado REAL de um serviço: `running` via pidfile+kill(pid,0) (fonte de
 * verdade), `snapshot` (best-effort) só quando `running` — um `status.json` estale
 * de um runner morto NÃO é exibido como se fosse atual (evita "turno em andamento"
 * fantasma). Nunca lança.
 */
export function readServiceRuntimeStatus(serviceDir: string): ServiceRuntimeStatus {
  const pidPath = runnerPidPath(serviceDir);
  const alive = isRunnerAlive(pidPath);
  if (!alive) return { running: false };
  let pid: number | undefined;
  try {
    pid = Number(readFileSync(pidPath, 'utf8').trim()) || undefined;
  } catch {
    pid = undefined;
  }
  const snapshot = readSnapshot(serviceDir);
  return { running: true, ...(pid !== undefined ? { pid } : {}), ...(snapshot ? { snapshot } : {}) };
}
