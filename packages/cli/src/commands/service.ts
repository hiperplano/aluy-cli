// ADR-0158 (aceito, APR-0148) — `aluy service <sub>`: fase 1 (list/status/install/
// uninstall) + FASE 2 (esta fatia): start/stop/logs/run --runner — O RUNNER, §5. O
// shell é o ESPELHO do `/service` in-session (canal PRINCIPAL, emenda §10) — mesma
// mecânica, zero lógica duplicada: os dois consomem `UserServicesStore` + os
// formatadores PUROS do core + `service/*.ts` (pidfile/log/status/runner), como
// `/telegram`/`aluy telegram` sobre a mesma bridge.
//
// Fase 1:
//   list       — lista os serviços instalados (agora com estado REAL, §5 fase 2).
//   status     — detalhe de UM serviço + estado REAL (rodando/turno/aguardando).
//   install    — copia um diretório local OU clona um repo git p/ `~/.aluy/services/`,
//                VALIDA antes de ativar, mostra o MANIFESTO VISÍVEL (§9) e exige
//                confirmação (`--yes` explícito p/ modo não-interativo).
//   uninstall  — remove o diretório do serviço (pede confirmação). Recusa se RODANDO
//                (peça `stop` antes — nunca apaga o diretório debaixo de um processo vivo).
//
// Fase 2 (esta fatia):
//   start      — spawn DESTACADO de `aluy service run <nome> --runner` (§5): o
//                processo QUE É o serviço, do `start` ao `stop`. Recusa se já
//                rodando ou se o manifesto é inválido (o registry já valida).
//   stop       — SIGTERM no pid do runner (pidfile); timeout ⇒ SIGKILL; limpa pidfile.
//   logs       — tail do `runner.log` (últimas N linhas; `-f` opcional).
//   run --runner (uso INTERNO — não documentado no --help; é o entrypoint que o
//                `start` spawna, roda em FOREGROUND no processo destacado).
//
// `create`/`update`/`attach` seguem "disponível numa fase seguinte" (create é
// conversacional — fase 5; update é git pull — fase depois; attach é fase 4).

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, cpSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildServicesNote,
  buildServiceManifestVisibleNote,
  parseServiceManifest,
  isServiceManifestError,
  formatElapsedSince,
} from '@hiperplano/aluy-cli-core';
import { realTerminalIO, type TerminalIO } from '../auth/io.js';
import {
  UserServicesStore,
  scanServiceDirForInstall,
  isServiceEntryError,
  type ServiceEntry,
} from '../io/services-store.js';
import { validateCronExpr } from './cron.js';
import { runnerLogPath, runnerPidPath } from '../service/paths.js';
import { readServiceRuntimeStatus } from '../service/status.js';
import { isRunnerAlive, readPidFile, removePidFile } from '../service/pid.js';
import { appendLog, tailLog } from '../service/log.js';
import { runServiceRunner } from '../service/runner.js';
import { stopDaemons } from '../service/daemons.js';

export type ServiceCommand =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'list' }
  | { kind: 'status'; name: string }
  | { kind: 'install'; source: string; yes: boolean }
  | { kind: 'uninstall'; name: string; yes: boolean }
  | { kind: 'start'; name: string; yes: boolean }
  | { kind: 'stop'; name: string }
  | { kind: 'logs'; name: string; follow: boolean; lines: number }
  // Uso INTERNO — o entrypoint que `start` spawna destacado (ADR-0158 §5).
  | { kind: 'run-runner'; name: string }
  // ADR-0158 §5/§10 — `create`/`update`/`attach` chegam em fases seguintes.
  | { kind: 'not-yet'; sub: string };

const PHASE_LATER_SUBCOMMANDS = new Set(['create', 'update', 'attach']);

const SERVICE_HELP = `aluy service — SERVIÇOS plugáveis (ADR-0158) · o RUNNER (fase 2)

Uso:
  aluy service [list]
  aluy service status <nome>
  aluy service install <path|git-url> [--yes]
  aluy service uninstall <nome> [--yes]
  aluy service start <nome> [--yes]
  aluy service stop <nome>
  aluy service logs <nome> [-f] [-n <N>]

Subcomandos:
  list                 Lista os serviços instalados — nome, estado REAL (rodando/
                        parado/turno em andamento/dormindo/aguardando dono),
                        próximo schedule, descrição. Sem argumento, "aluy service"
                        já lista (espelha o /service in-session, ADR-0158 §11).
  status <nome>         Detalhe de um serviço + o estado REAL (pid, turno em
                        andamento ou dormindo até X, pergunta pendente).
  install <path|url>    Copia um diretório local OU clona um repo git p/
                        ~/.aluy/services/<nome>/. Valida ANTES de ativar e mostra o
                        MANIFESTO VISÍVEL (daemons, skills com script, mcp.json, canal,
                        autonomia) — exige confirmação. --yes pula o prompt (scripts/CI).
  uninstall <nome>      Remove o diretório do serviço. Pede confirmação (--yes pula).
                        Recusa se o serviço estiver RODANDO ("stop" antes).
  start <nome>          Spawna o PROCESSO DESTACADO do serviço (ADR-0158 §5) — mostra
                        o manifesto visível e pede confirmação (--yes pula). Recusa se
                        já rodando ou se o manifesto é inválido.
  stop <nome>           SIGTERM no processo do serviço (timeout ⇒ SIGKILL); derruba os
                        daemons próprios e limpa o pidfile.
  logs <nome>           Últimas linhas do runner.log. -n <N> muda a contagem (padrão
                        50); -f acompanha ao vivo (Ctrl-C sai).

Notas:
  - create (conversacional) e update/attach chegam em fases seguintes.
  - O canal PRINCIPAL de gestão é "/service" DENTRO da sessão (ADR-0158 §10, emenda
    de aprovação); este shell é o espelho, útil p/ script/automação.
`;

/** Parser fino de `aluy service <argv>` — espelha `parseCronCommand`. PURO. */
export function parseServiceCommand(argv: readonly string[]): ServiceCommand {
  const sub = argv[0];
  if (sub === undefined || sub === 'list') return { kind: 'list' };
  if (sub === 'help' || sub === '-h' || sub === '--help') return { kind: 'help' };

  if (sub === 'status') {
    const name = argv[1];
    if (!name) return { kind: 'error', message: 'service status: falta o <nome> do serviço.' };
    return { kind: 'status', name };
  }

  if (sub === 'install') {
    const rest = argv.slice(1);
    const yes = rest.includes('--yes');
    const source = rest.find((a) => !a.startsWith('--'));
    if (!source) return { kind: 'error', message: 'service install: falta <path|git-url>.' };
    return { kind: 'install', source, yes };
  }

  if (sub === 'uninstall') {
    const rest = argv.slice(1);
    const yes = rest.includes('--yes');
    const name = rest.find((a) => !a.startsWith('--'));
    if (!name) return { kind: 'error', message: 'service uninstall: falta o <nome> do serviço.' };
    return { kind: 'uninstall', name, yes };
  }

  if (sub === 'start') {
    const rest = argv.slice(1);
    const yes = rest.includes('--yes');
    const name = rest.find((a) => !a.startsWith('--'));
    if (!name) return { kind: 'error', message: 'service start: falta o <nome> do serviço.' };
    return { kind: 'start', name, yes };
  }

  if (sub === 'stop') {
    const name = argv[1];
    if (!name) return { kind: 'error', message: 'service stop: falta o <nome> do serviço.' };
    return { kind: 'stop', name };
  }

  if (sub === 'logs') {
    const rest = argv.slice(1);
    const follow = rest.includes('-f') || rest.includes('--follow');
    const name = rest.find((a) => !a.startsWith('-'));
    if (!name) return { kind: 'error', message: 'service logs: falta o <nome> do serviço.' };
    const nIdx = rest.indexOf('-n');
    const nRaw = nIdx !== -1 ? rest[nIdx + 1] : undefined;
    const parsedN = nRaw !== undefined ? Number(nRaw) : NaN;
    const lines = Number.isInteger(parsedN) && parsedN > 0 ? parsedN : 50;
    return { kind: 'logs', name, follow, lines };
  }

  // Uso INTERNO — o `start` spawna `aluy service run <nome> --runner` destacado.
  if (sub === 'run') {
    const rest = argv.slice(1);
    const name = rest.find((a) => !a.startsWith('--'));
    if (!name || !rest.includes('--runner')) {
      return { kind: 'error', message: 'service run: uso interno — precisa de "<nome> --runner".' };
    }
    return { kind: 'run-runner', name };
  }

  if (PHASE_LATER_SUBCOMMANDS.has(sub)) return { kind: 'not-yet', sub };

  return { kind: 'error', message: `service: subcomando desconhecido "${sub}".` };
}

export interface ServiceDeps {
  readonly io?: TerminalIO;
  readonly store?: UserServicesStore;
  /** Clonador de git injetável p/ teste (default: `git clone --depth 1`). */
  readonly gitClone?: (url: string, dest: string) => void;
}

/** Resposta honesta p/ subcomandos de fases seguintes — nunca finge que já existem. */
function notYetLines(sub: string): readonly string[] {
  const when =
    sub === 'create'
      ? 'fase 5 (criação conversacional, ADR-0158 §10)'
      : sub === 'attach'
        ? 'fase 4 (entrar/observar um serviço rodando, ADR-0158 §11)'
        : 'uma fase seguinte (git pull, ADR-0158 §9)';
  return [`"aluy service ${sub}" ainda não existe — chega em ${when}.`];
}

/** Detecta URL git (http(s)/git@/ssh://, ou termina em .git) vs. caminho local. PURO. */
function isGitUrl(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/i.test(source) || source.endsWith('.git');
}

/** Pergunta sim/não; aceita y/yes/s/sim (pt-BR + en). */
async function confirm(io: TerminalIO, question: string): Promise<boolean> {
  const answer = (await io.prompt(question)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes' || answer === 's' || answer === 'sim';
}

/** Executa `aluy service …`. Retorna exit code (0 sucesso, 1 erro de uso/estado). Não lança. */
export async function runService(argv: readonly string[], deps: ServiceDeps = {}): Promise<number> {
  const io = deps.io ?? realTerminalIO();
  const store = deps.store ?? new UserServicesStore();
  const gitClone =
    deps.gitClone ??
    ((url: string, dest: string) => {
      execFileSync('git', ['clone', '--depth', '1', url, dest], { stdio: 'pipe' });
    });

  const cmd = parseServiceCommand(argv);

  switch (cmd.kind) {
    case 'help':
      io.out(SERVICE_HELP);
      return 0;

    case 'error':
      io.err(`aluy: ${cmd.message}`);
      io.err("rode 'aluy service --help' para ver o uso.");
      return 1;

    case 'not-yet':
      for (const l of notYetLines(cmd.sub)) io.out(l);
      return 1;

    case 'list': {
      const { services, errors } = store.list();
      // ADR-0158 §5 (fase 2) — estado REAL por serviço (pidfile+kill-0 + status.json).
      const servicesWithStatus = services.map((s) => ({
        ...s,
        runtimeStatus: toRuntimeStatusInput(readServiceRuntimeStatus(s.dir)),
      }));
      const note = buildServicesNote({
        services: servicesWithStatus,
        errors: errors.map((e) => ({ dirName: e.dirName, reason: e.reason })),
        servicesDir: store.servicesDir,
        nowMs: Date.now(),
      });
      io.out(`${note.title} — serviços instalados`);
      for (const l of note.lines) io.out(l);
      return 0;
    }

    case 'status': {
      const entry = store.get(cmd.name);
      if (entry === undefined) {
        io.err(`aluy: serviço "${cmd.name}" não encontrado em ${store.servicesDir}.`);
        return 1;
      }
      if (isServiceEntryError(entry)) {
        io.out(`serviço "${cmd.name}" — INVÁLIDO:`);
        io.out(`  ⚠ ${entry.reason}`);
        return 1;
      }
      const m = entry.manifest;
      const rt = readServiceRuntimeStatus(entry.dir);
      io.out(`serviço "${m.name}" — ${describeRuntimeStatus(rt)}`);
      io.out(`  dir:         ${entry.dir}`);
      if (rt.running && rt.pid !== undefined) io.out(`  pid:         ${rt.pid}`);
      if (rt.running && rt.snapshot?.pendingQuestion !== undefined) {
        const since = rt.snapshot.updatedAtIso;
        const elapsed = since !== undefined ? ` (enviada há ${formatElapsedSince(Date.now() - Date.parse(since))})` : '';
        io.out(`  ⚠ pergunta pendente${elapsed}: ${rt.snapshot.pendingQuestion}`);
      }
      if (m.description !== undefined) io.out(`  descrição:   ${m.description}`);
      io.out(`  schedule:    ${m.schedule ?? '(não declarado)'}`);
      io.out(`  until:       ${m.until ?? '(não declarado)'}`);
      io.out(`  workflow:    ${m.workflow ?? '(não declarado)'}`);
      io.out(`  canal:       ${m.channel ?? '(NENHUM)'}`);
      io.out(`  autonomia:   ${m.autonomy ?? '(não declarada)'}`);
      io.out(`  budget:      ${m.budget ?? '(não declarado)'}`);
      if (m.tunables.length > 0) {
        io.out(`  tunáveis/circuit-breakers:`);
        for (const t of m.tunables) {
          const faixa = t.min !== undefined && t.max !== undefined ? ` [${t.min}..${t.max}]` : '';
          io.out(`    · ${t.key}: ${t.value}${faixa}`);
        }
      }
      io.out(`  validação:   OK (schedule/workflow conferidos pelo registry)`);
      return 0;
    }

    case 'install':
      return runInstall(cmd.source, cmd.yes, io, store, gitClone);

    case 'uninstall':
      return runUninstall(cmd.name, cmd.yes, io, store);

    case 'start':
      return runStart(cmd.name, cmd.yes, io, store);

    case 'stop':
      return runStop(cmd.name, io, store);

    case 'logs':
      return runLogs(cmd.name, cmd.follow, cmd.lines, io, store);

    case 'run-runner':
      // Uso INTERNO — o processo QUE É o serviço (spawnado destacado por `start`).
      // Roda em FOREGROUND aqui (o `spawn` do `start` já o desanexou do terminal).
      return runServiceRunner(cmd.name);
  }
}

/** Adapta `ServiceRuntimeStatus` (I/O, `service/status.ts`) p/ o formato PURO que
 * `buildServicesNote` (core) consome — sem o core conhecer pidfile/fs. */
function toRuntimeStatusInput(rt: ReturnType<typeof readServiceRuntimeStatus>): {
  readonly running: boolean;
  readonly turnState?: 'sleeping' | 'running-turn' | 'awaiting-owner';
  readonly nextFireIso?: string;
  readonly pendingSinceIso?: string;
} {
  return {
    running: rt.running,
    ...(rt.snapshot?.turnState !== undefined ? { turnState: rt.snapshot.turnState } : {}),
    ...(rt.snapshot?.nextFireIso !== undefined ? { nextFireIso: rt.snapshot.nextFireIso } : {}),
    // ADR-0158 §5 pt.4 (FASE 3, missão item 4) — o MOMENTO da pergunta pendente é o
    // `updatedAtIso` do snapshot: `writeServiceStatus` só é chamado de novo (fase 2/3)
    // quando o estado MUDA — enquanto `turnState === 'awaiting-owner'` fica parado,
    // `updatedAtIso` É o instante em que a pergunta foi enviada (runner.ts).
    ...(rt.snapshot?.turnState === 'awaiting-owner' && rt.snapshot.updatedAtIso !== undefined
      ? { pendingSinceIso: rt.snapshot.updatedAtIso }
      : {}),
  };
}

function describeRuntimeStatus(rt: ReturnType<typeof readServiceRuntimeStatus>): string {
  if (!rt.running) return 'PARADO';
  const st = rt.snapshot?.turnState;
  if (st === 'running-turn') return 'RODANDO · turno em andamento';
  if (st === 'awaiting-owner') {
    const since = rt.snapshot?.updatedAtIso;
    const suffix = since !== undefined ? ` (pergunta enviada há ${formatElapsedSince(Date.now() - Date.parse(since))})` : '';
    return `RODANDO · ⚠ aguardando dono${suffix}`;
  }
  if (st === 'sleeping' && rt.snapshot?.nextFireIso !== undefined) {
    return `RODANDO · dormindo até ${rt.snapshot.nextFireIso}`;
  }
  return 'RODANDO';
}

async function runInstall(
  source: string,
  yes: boolean,
  io: TerminalIO,
  store: UserServicesStore,
  gitClone: (url: string, dest: string) => void,
): Promise<number> {
  const staging = mkdtempSync(join(tmpdir(), 'aluy-service-install-'));
  const cleanup = (): void => {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  try {
    if (isGitUrl(source)) {
      io.out(`clonando ${source}…`);
      try {
        gitClone(source, staging);
      } catch {
        io.err(
          `aluy: falha ao clonar "${source}" — confira a URL/credenciais e o \`git\` instalado.`,
        );
        return 1;
      }
    } else {
      let srcStat;
      try {
        srcStat = statSync(source);
      } catch {
        io.err(`aluy: caminho "${source}" não encontrado.`);
        return 1;
      }
      if (!srcStat.isDirectory()) {
        io.err(`aluy: "${source}" não é um diretório (um serviço é um diretório-manifesto).`);
        return 1;
      }
      cpSync(source, staging, { recursive: true });
    }

    const mdPath = join(staging, 'service.md');
    let raw: string;
    try {
      raw = readFileSync(mdPath, 'utf8');
    } catch {
      io.err(`aluy: "${source}" não tem service.md — não é um diretório-serviço (ADR-0158 §1).`);
      return 1;
    }

    const parsed = parseServiceManifest('service.md', raw);
    if (isServiceManifestError(parsed)) {
      io.err(`aluy: service.md inválido — ${parsed.reason}`);
      return 1;
    }

    if (parsed.schedule !== undefined) {
      const bad = validateCronExpr(parsed.schedule);
      if (bad !== undefined) {
        io.err(`aluy: "schedule: ${parsed.schedule}" inválido — ${bad}`);
        return 1;
      }
    }
    if (parsed.workflow !== undefined) {
      const wfPath = join(staging, 'workflows', `${parsed.workflow}.md`);
      if (!existsSync(wfPath)) {
        io.err(
          `aluy: "workflow: ${parsed.workflow}" não encontrado (esperado workflows/${parsed.workflow}.md).`,
        );
        return 1;
      }
    }

    const finalDir = store.resolveDir(parsed.name);
    if (finalDir === undefined) {
      io.err(`aluy: nome de serviço inválido "${parsed.name}".`);
      return 1;
    }
    if (existsSync(finalDir)) {
      io.err(
        `aluy: já existe um serviço "${parsed.name}" instalado em ${finalDir} — rode ` +
          `\`aluy service uninstall ${parsed.name}\` antes de reinstalar.`,
      );
      return 1;
    }

    // ADR-0158 §9/§10 — MANIFESTO VISÍVEL antes de qualquer confirmação: o que o
    // serviço DECLARA (instalar de um repo é instalar código que roda).
    const scan = scanServiceDirForInstall(staging);
    const visible = buildServiceManifestVisibleNote({ manifest: parsed, ...scan });
    io.out(visible.title);
    for (const l of visible.lines) io.out(l);
    io.out('');

    if (!yes) {
      const ok = await confirm(io, 'confirma a instalação deste serviço? [y/N] ');
      if (!ok) {
        io.out('instalação cancelada — nada foi escrito em ~/.aluy/services/.');
        return 1;
      }
    }

    store.ensureDir();
    cpSync(staging, finalDir, { recursive: true });
    io.out(`✓ serviço "${parsed.name}" instalado em ${finalDir}.`);
    io.out(`  PARADO — "aluy service start ${parsed.name}" para ligar (ADR-0158 §5).`);
    return 0;
  } finally {
    cleanup();
  }
}

async function runUninstall(
  name: string,
  yes: boolean,
  io: TerminalIO,
  store: UserServicesStore,
): Promise<number> {
  const dir = store.resolveDir(name);
  if (dir === undefined || !existsSync(dir)) {
    io.err(`aluy: serviço "${name}" não encontrado em ${store.servicesDir}.`);
    return 1;
  }

  // ADR-0158 §5 — NUNCA apaga o diretório debaixo de um processo vivo.
  if (readServiceRuntimeStatus(dir).running) {
    io.err(`aluy: serviço "${name}" está RODANDO — rode \`aluy service stop ${name}\` antes.`);
    return 1;
  }

  if (!yes) {
    const ok = await confirm(io, `remover o serviço "${name}" (${dir})? [y/N] `);
    if (!ok) {
      io.out('remoção cancelada.');
      return 1;
    }
  }

  rmSync(dir, { recursive: true, force: true });
  io.out(`✓ serviço "${name}" removido (${dir}).`);
  return 0;
}

/**
 * ADR-0158 §5/§10 — `start`: mostra o MANIFESTO VISÍVEL (mesma disciplina do
 * `install`, §9 — CRIAR/INSTALAR NÃO É LIGAR, a chave de ignição é sempre um ato
 * explícito do dono) e, confirmado, faz `spawn` DESTACADO de
 * `aluy service run <nome> --runner` — o processo QUE É o serviço, do `start` ao
 * `stop`. Recusa serviço já RODANDO (pidfile+kill-0) ou inválido (registry).
 */
async function runStart(
  name: string,
  yes: boolean,
  io: TerminalIO,
  store: UserServicesStore,
): Promise<number> {
  const entry = store.get(name);
  if (entry === undefined) {
    io.err(`aluy: serviço "${name}" não encontrado em ${store.servicesDir}.`);
    return 1;
  }
  if (isServiceEntryError(entry)) {
    io.err(`aluy: serviço "${name}" inválido — ${entry.reason}`);
    return 1;
  }
  const e: ServiceEntry = entry;
  if (e.manifest.schedule === undefined) {
    io.err(`aluy: serviço "${name}" não declara "schedule:" — o runner não saberia quando acordar.`);
    return 1;
  }
  if (readServiceRuntimeStatus(e.dir).running) {
    io.err(`aluy: serviço "${name}" já está RODANDO.`);
    return 1;
  }

  const scan = scanServiceDirForInstall(e.dir);
  const visible = buildServiceManifestVisibleNote({ manifest: e.manifest, ...scan });
  io.out(visible.title);
  for (const l of visible.lines) io.out(l);
  io.out('');

  if (!yes) {
    const ok = await confirm(io, `iniciar o serviço "${name}" agora? [y/N] `);
    if (!ok) {
      io.out('início cancelado.');
      return 1;
    }
  }

  const logPath = runnerLogPath(e.dir);
  appendLog(logPath, `"aluy service start ${name}" — spawnando o runner…`);
  const entrypoint = process.argv[1] ?? '';
  const child = spawn(process.execPath, [entrypoint, 'service', 'run', name, '--runner'], {
    detached: true,
    stdio: 'ignore',
    cwd: e.dir,
  });
  child.unref();
  if (child.pid === undefined) {
    io.err(`aluy: falha ao dar spawn no runner de "${name}".`);
    return 1;
  }
  io.out(`✓ serviço "${name}" iniciado (pid ${child.pid}).`);
  io.out(`  logs: aluy service logs ${name}   ·   parar: aluy service stop ${name}`);
  return 0;
}

/** ADR-0158 §5 — `stop`: SIGTERM no pid do runner; timeout ⇒ SIGKILL. Também
 * derruba os daemons próprios DIRETO (defesa em profundidade — mesmo se o runner
 * estiver travado e não chegar a rodar o próprio shutdown gracioso). */
async function runStop(name: string, io: TerminalIO, store: UserServicesStore): Promise<number> {
  const dir = store.resolveDir(name);
  if (dir === undefined || !existsSync(dir)) {
    io.err(`aluy: serviço "${name}" não encontrado em ${store.servicesDir}.`);
    return 1;
  }
  const pidPath = runnerPidPath(dir);
  const pid = readPidFile(pidPath);
  if (pid === undefined || !isRunnerAlive(pidPath)) {
    io.out(`serviço "${name}" já está parado.`);
    removePidFile(pidPath);
    return 0;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* já morreu entre o check e o kill */
  }
  io.out(`SIGTERM enviado ao serviço "${name}" (pid ${pid})…`);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isRunnerAlive(pidPath)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (isRunnerAlive(pidPath)) {
    try {
      process.kill(pid, 'SIGKILL');
      io.out(`  não encerrou a tempo — SIGKILL enviado.`);
    } catch {
      /* já morreu */
    }
  }
  stopDaemons(dir, (line) => appendLog(runnerLogPath(dir), line));
  removePidFile(pidPath);
  io.out(`✓ serviço "${name}" parado.`);
  return 0;
}

/** ADR-0158 §5 — `logs`: tail do `runner.log`. `-f` faz polling simples (Ctrl-C sai). */
async function runLogs(
  name: string,
  follow: boolean,
  n: number,
  io: TerminalIO,
  store: UserServicesStore,
): Promise<number> {
  const dir = store.resolveDir(name);
  if (dir === undefined || !existsSync(dir)) {
    io.err(`aluy: serviço "${name}" não encontrado em ${store.servicesDir}.`);
    return 1;
  }
  const logPath = runnerLogPath(dir);
  const initial = tailLog(logPath, n);
  if (initial.length === 0) {
    io.out(`(sem log ainda para "${name}" — o serviço nunca rodou, ou ${logPath} está vazio.)`);
  } else {
    for (const l of initial) io.out(l);
  }
  if (!follow) return 0;

  let printed = initial.length;
  io.out('— acompanhando ao vivo (Ctrl-C para sair) —');
  return await new Promise<number>((resolve) => {
    const interval = setInterval(() => {
      const all = tailLog(logPath, printed + 1000);
      if (all.length > printed) {
        for (const l of all.slice(printed)) io.out(l);
        printed = all.length;
      }
    }, 500);
    const stop = (): void => {
      clearInterval(interval);
      resolve(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
