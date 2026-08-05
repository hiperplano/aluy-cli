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
// Fase 2:
//   start      — spawn DESTACADO de `aluy service run <nome> --runner` (§5): o
//                processo QUE É o serviço, do `start` ao `stop`. Recusa se já
//                rodando ou se o manifesto é inválido (o registry já valida).
//   stop       — SIGTERM no pid do runner (pidfile); timeout ⇒ SIGKILL; limpa pidfile.
//   logs       — tail do `runner.log` (últimas N linhas; `-f` opcional).
//   run --runner (uso INTERNO — não documentado no --help; é o entrypoint que o
//                `start` spawna, roda em FOREGROUND no processo destacado).
//
// FASE 4: attach — "entrar num serviço rodando" (§11). Conecta ao socket local que
// o PRÓPRIO runner serve (`attach-server.ts`), mostra log+estado (+blocos, melhor
// esforço) AO VIVO, aceita digitação (linha ⇒ `say`), Ctrl-C (e ESC quando o
// terminal permite raw-mode — ver o cliente interativo abaixo) faz DETACH sem
// parar o serviço.
//
// FASE 5 (esta fatia): `create` — criação CONVERSACIONAL (§10). O canal PRINCIPAL
// é `/service create` DENTRO da sessão (`slash/service-create.ts` monta o
// PROMPT-GUIA; `session/run.tsx` o envia como turno) — o agente ENTREVISTA o que
// faltar e escreve o rascunho em STAGING (nunca em `~/.aluy/services/` — a catraca
// barra). Este shell (`aluy service create`) não tem canal pra entrevista; por
// isso só ORIENTA pro `/service create` in-session (ver `createRedirectLines`).
// `update` (git pull) segue "disponível numa fase seguinte".
//
// DESCOBERTA ENTRE SERVIÇOS (`group:`) — um serviço com `autonomy: yolo-scoped`
// (ex.: um "maestro" que orquestra os demais) precisa achar seus irmãos de mesa.
// `group:` no `service.md` é só um RÓTULO (parser puro em `service-parse.ts`); AQUI
// `list --group <nome>` FILTRA a listagem pelo grupo, e `start`/`stop --group <nome>`
// ITERAM sobre os membros — cada um continua um processo independente, com seu
// próprio lock; se um falhar, os demais seguem (ver `runStartGroup`/`runStopGroup`).
// Deliberadamente SEM sala compartilhada, sem estado de grupo, sem qualquer canal
// novo entre processos — a forma de "falar" com um irmão já existe hoje
// (`echo "instrução" | aluy service attach <nome>`; o `attach` lê stdin via
// `readline`, não exige TTY).

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, cpSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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
import { runnerLogPath, runnerPidPath, attachSocketPath } from '../service/paths.js';
import { readServiceRuntimeStatus } from '../service/status.js';
import { isRunnerAlive, readPidFile, removePidFile } from '../service/pid.js';
import { appendLog, tailLog } from '../service/log.js';
import { runServiceRunner } from '../service/runner.js';
import { stopDaemons } from '../service/daemons.js';
import { connectAttachSocket } from '../service/attach-client.js';

export type ServiceCommand =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  // `group` presente ⇒ filtra a listagem (descoberta entre serviços irmãos).
  | { kind: 'list'; group?: string }
  | { kind: 'status'; name: string }
  | { kind: 'install'; source: string; yes: boolean }
  | { kind: 'uninstall'; name: string; yes: boolean }
  | { kind: 'start'; name: string; yes: boolean }
  | { kind: 'stop'; name: string }
  // `--group <nome>` — açúcar que ITERA start/stop sobre os membros do grupo (cada
  // um continua processo independente; falha de um não derruba os outros).
  | { kind: 'start-group'; group: string; yes: boolean }
  | { kind: 'stop-group'; group: string }
  | { kind: 'logs'; name: string; follow: boolean; lines: number }
  // ADR-0158 §11 (FASE 4) — entrar/observar/interagir com um serviço rodando.
  | { kind: 'attach'; name: string }
  // ADR-0158 §10 (FASE 5) — `create` é CONVERSACIONAL (entrevista de verdade) e o
  // shell não tem canal pra isso (ver `slash/service-create.ts`, Decisão 2) — o
  // shell só ORIENTA pro canal PRINCIPAL, `/service create` dentro da sessão.
  | { kind: 'create-redirect' }
  // Uso INTERNO — o entrypoint que `start` spawna destacado (ADR-0158 §5).
  | { kind: 'run-runner'; name: string }
  // ADR-0158 §9 — `update` (git pull) chega numa fase seguinte.
  | { kind: 'not-yet'; sub: string };

const PHASE_LATER_SUBCOMMANDS = new Set(['update']);

const SERVICE_HELP = `aluy service — SERVIÇOS plugáveis

Uso:
  aluy service [list] [--group <nome>]
  aluy service status <nome>
  aluy service create
  aluy service install <path|git-url> [--yes]
  aluy service uninstall <nome> [--yes]
  aluy service start <nome> [--yes]
  aluy service start --group <nome> [--yes]
  aluy service stop <nome>
  aluy service stop --group <nome>
  aluy service logs <nome> [-f] [-n <N>]
  aluy service attach <nome>

Subcomandos:
  list                 Lista os serviços instalados — nome, estado REAL (rodando/
                        parado/turno em andamento/dormindo/aguardando dono),
                        próximo schedule, descrição, grupo/modelo (quando
                        declarados). Sem argumento, "aluy service" já lista
                        (espelha o /service in-session). "--group <nome>" filtra
                        pelo "group:" do service.md — é assim que um serviço
                        descobre seus irmãos de mesa.
  status <nome>         Detalhe de um serviço + o estado REAL (pid, turno em
                        andamento ou dormindo até X, pergunta pendente).
  create                Criação CONVERSACIONAL — o shell não tem canal p/ a
                        entrevista; ORIENTA a rodar "/service create <descrição>"
                        numa sessão do aluy (o canal PRINCIPAL).
  install <path|url>    Copia um diretório local OU clona um repo git p/
                        ~/.aluy/services/<nome>/. Valida ANTES de ativar e mostra o
                        MANIFESTO VISÍVEL (daemons, skills com script, mcp.json, canal,
                        grupo, modelo, autonomia) — exige confirmação. --yes pula o
                        prompt (scripts/CI).
  uninstall <nome>      Remove o diretório do serviço. Pede confirmação (--yes pula).
                        Recusa se o serviço estiver RODANDO ("stop" antes).
  start <nome>          Spawna o PROCESSO DESTACADO do serviço — mostra o manifesto
                        visível e pede confirmação (--yes pula). Recusa se já rodando
                        ou se o manifesto é inválido.
  start --group <nome>  ITERA "start" sobre todo serviço com esse "group:" — cada um
                        continua um processo independente (lock/estado próprios); se
                        um falhar, os demais seguem, e o comando reporta cada um.
  stop <nome>           SIGTERM no processo do serviço (timeout ⇒ SIGKILL); derruba os
                        daemons próprios e limpa o pidfile.
  stop --group <nome>   ITERA "stop" sobre todo serviço com esse "group:" — mesma
                        independência do "start --group" (um serviço não derruba outro).
  logs <nome>           Últimas linhas do runner.log. -n <N> muda a contagem (padrão
                        50); -f acompanha ao vivo (Ctrl-C sai).
  attach <nome>          ENTRA no serviço rodando: mostra log+estado (+blocos da
                        conversa, melhor esforço) ao vivo; qualquer linha digitada
                        vira instrução (Enter envia); Ctrl-C faz DETACH — o serviço
                        SEGUE rodando (nunca para por causa do attach).

Notas:
  - update (git pull) chega numa fase seguinte.
  - O canal PRINCIPAL de gestão é "/service" DENTRO da sessão; este shell é o
    espelho, útil p/ script/automação — EXCETO "create", que é conversacional
    e só existe de verdade in-session.
`;

/**
 * Extrai "--group <valor>" de um array de args restantes (descoberta entre
 * serviços). `{}` = flag ausente (sem filtro). Uma flag PRESENTE mas SEM valor
 * (ou seguida de outra flag) é erro de uso — nunca vira "sem filtro" silenciosamente
 * (o dono digitou "--group" querendo filtrar; ignorar de mansinho esconderia o erro
 * de digitação). PURO.
 */
function extractGroupFlag(rest: readonly string[]): { readonly group?: string; readonly error?: string } {
  const idx = rest.indexOf('--group');
  if (idx === -1) return {};
  const value = rest[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    return { error: '"--group" precisa de um valor (ex.: --group mesa-trading).' };
  }
  return { group: value };
}

/** Parser fino de `aluy service <argv>` — espelha `parseCronCommand`. PURO. */
export function parseServiceCommand(argv: readonly string[]): ServiceCommand {
  const sub = argv[0];
  if (sub === undefined || sub === 'list') {
    const rest = sub === undefined ? argv : argv.slice(1);
    const { group, error } = extractGroupFlag(rest);
    if (error !== undefined) return { kind: 'error', message: `service list: ${error}` };
    return group !== undefined ? { kind: 'list', group } : { kind: 'list' };
  }
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
    const { group, error } = extractGroupFlag(rest);
    if (error !== undefined) return { kind: 'error', message: `service start: ${error}` };
    if (group !== undefined) return { kind: 'start-group', group, yes };
    const name = rest.find((a) => !a.startsWith('--'));
    if (!name) {
      return {
        kind: 'error',
        message: 'service start: falta o <nome> do serviço (ou "--group <nome>").',
      };
    }
    return { kind: 'start', name, yes };
  }

  if (sub === 'stop') {
    const rest = argv.slice(1);
    const { group, error } = extractGroupFlag(rest);
    if (error !== undefined) return { kind: 'error', message: `service stop: ${error}` };
    if (group !== undefined) return { kind: 'stop-group', group };
    const name = rest[0];
    if (!name) {
      return {
        kind: 'error',
        message: 'service stop: falta o <nome> do serviço (ou "--group <nome>").',
      };
    }
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

  if (sub === 'attach') {
    const name = argv[1];
    if (!name) return { kind: 'error', message: 'service attach: falta o <nome> do serviço.' };
    return { kind: 'attach', name };
  }

  // ADR-0158 §10 (FASE 5) — `create` é CONVERSACIONAL; o shell só ORIENTA pro
  // canal PRINCIPAL (`/service create` in-session). Ver `createRedirectLines`.
  if (sub === 'create') return { kind: 'create-redirect' };

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
  /** ADR-0158 §11 (FASE 4) — conector do socket de attach injetável p/ teste
   * (default: `connectAttachSocket` real, net.createConnection). */
  readonly attachConnect?: typeof connectAttachSocket;
  /** ADR-0158 §11 (FASE 4) — stdin injetável p/ teste do `attach` (default:
   * `process.stdin`) — um `Readable` (não precisa ser TTY: `readline` funciona
   * sobre qualquer stream; um teste alimenta linhas via um stream fake). */
  readonly attachStdin?: NodeJS.ReadableStream;
}

/** Resposta honesta p/ subcomandos de fases seguintes — nunca finge que já existem. */
function notYetLines(sub: string): readonly string[] {
  return [`"aluy service ${sub}" ainda não existe — chega numa fase seguinte (git pull).`];
}

/**
 * ADR-0158 §10 (FASE 5) — `aluy service create` no SHELL: `create` é CONVERSACIONAL
 * (o agente ENTREVISTA o que faltar — schedule? canal? funil de risco?) e um
 * comando de shell não tem CANAL pra essa ida-e-volta (não é um turno headless de
 * um tiro como o `aluy bootstrap --agent`, que só instala pacotes de forma
 * DETERMINÍSTICA). DECISÃO (missão explícita: "decisão sua, liste-a"): o shell
 * ORIENTA pro canal PRINCIPAL — `/service create` DENTRO de uma sessão (ADR-0158
 * §10, emenda de aprovação do dono: "/service é o canal principal"). Ver a
 * DECISÃO 2 completa em `slash/service-create.ts`.
 */
function createRedirectLines(): readonly string[] {
  return [
    '"aluy service create" é CONVERSACIONAL — o agente entrevista o que faltar',
    '(schedule/canal/autonomia/funil de risco) antes de escrever. Isso exige um',
    'CANAL de ida-e-volta que o shell não tem (ao contrário de "install"/"start",',
    'que só confirmam um "sim/não").',
    '',
    'Abra uma sessão do aluy e rode:',
    '  /service create <descrição em prosa do serviço>',
    '',
    'o agente escreve o rascunho em staging (PARADO); revise e então',
    '"aluy service install <path>" para ativar de verdade.',
  ];
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
      // Descoberta entre serviços (`group:`) — filtra ANTES de formatar; os
      // REJEITADOS (sem manifesto parseável, logo sem `group:` legível) seguem
      // aparecendo de qualquer forma — são diagnóstico, não pertencem a nenhum grupo.
      const filtered =
        cmd.group !== undefined ? services.filter((s) => s.manifest.group === cmd.group) : services;
      if (cmd.group !== undefined && filtered.length === 0 && errors.length === 0) {
        io.out(
          services.length === 0
            ? `nenhum serviço instalado — instale um diretório-manifesto em ${store.servicesDir}/<nome>/.`
            : `nenhum serviço com "group: ${cmd.group}" (${services.length} instalado(s) no total, ` +
                `nenhum neste grupo).`,
        );
        return 0;
      }
      // ADR-0158 §5 (fase 2) — estado REAL por serviço (pidfile+kill-0 + status.json).
      const servicesWithStatus = filtered.map((s) => ({
        ...s,
        runtimeStatus: toRuntimeStatusInput(readServiceRuntimeStatus(s.dir)),
      }));
      const note = buildServicesNote({
        services: servicesWithStatus,
        errors: errors.map((e) => ({ dirName: e.dirName, reason: e.reason })),
        servicesDir: store.servicesDir,
        nowMs: Date.now(),
      });
      const groupSuffix = cmd.group !== undefined ? ` (grupo: ${cmd.group})` : '';
      io.out(`${note.title} — serviços instalados${groupSuffix}`);
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
      // Descoberta entre serviços — a que mesa/equipe este serviço pertence, e com
      // que modelo o turno roda (fixo por serviço; ausente ⇒ default global da config).
      io.out(`  grupo:       ${m.group ?? '(não declarado)'}`);
      io.out(`  modelo:      ${m.model ?? '(não declarado — default global)'}`);
      io.out(`  schedule:    ${m.schedule ?? '(não declarado)'}`);
      io.out(`  until:       ${m.until ?? '(não declarado)'}`);
      io.out(`  workflow:    ${m.workflow ?? '(não declarado)'}`);
      io.out(`  canal:       ${m.channel ?? '(NENHUM)'}`);
      io.out(`  autonomia:   ${m.autonomy ?? '(não declarada)'}`);
      io.out(`  budget:      ${m.budget ?? '(não declarado)'}`);
      // `immediate: true` — dispara um turno já no start/reinício (ver runner.ts).
      // Só destacado quando `true`: ausente/`false` é o comportamento de hoje.
      if (m.immediate === true) {
        io.out(`  ⚠ imediato:  sim — roda um turno já no start/reinício, antes do 1º cron`);
      }
      if (m.tunables.length > 0) {
        io.out(`  tunáveis/circuit-breakers:`);
        for (const t of m.tunables) {
          const faixa = t.min !== undefined && t.max !== undefined ? ` [${t.min}..${t.max}]` : '';
          io.out(`    · ${t.key}: ${t.value}${faixa}`);
        }
      }
      // Chave desconhecida que não virou tunável — mesma visibilidade do manifesto
      // visível do `install` (o dono pode ter perdido essa revisão inicial).
      if (m.ignoredFrontmatterKeys.length > 0) {
        io.out(`  ⚠ campos ignorados: ${m.ignoredFrontmatterKeys.join(', ')}`);
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

    case 'start-group':
      return runStartGroup(cmd.group, cmd.yes, io, store);

    case 'stop':
      return runStop(cmd.name, io, store);

    case 'stop-group':
      return runStopGroup(cmd.group, io, store);

    case 'logs':
      return runLogs(cmd.name, cmd.follow, cmd.lines, io, store);

    case 'attach':
      return runAttach(cmd.name, io, store, deps.attachConnect ?? connectAttachSocket, deps.attachStdin ?? process.stdin);

    case 'create-redirect':
      for (const l of createRedirectLines()) io.out(l);
      return 0;

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
      io.err(`aluy: "${source}" não tem service.md — não é um diretório-serviço.`);
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
    io.out(`  PARADO — "aluy service start ${parsed.name}" para ligar.`);
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

/** Os membros (nomes) de um `group:` — só entre os serviços VÁLIDOS (um manifesto
 * rejeitado não tem `group:` legível, então não pode ser membro de nada). Ordenado
 * por nome — determinístico, mesma disciplina do `buildServicesNote`. PURO o
 * suficiente (só filtra/mapeia o que `store.list()` já leu). */
function groupMembers(store: UserServicesStore, group: string): readonly string[] {
  const { services } = store.list();
  return services
    .filter((s) => s.manifest.group === group)
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * `start --group <nome>` — açúcar que ITERA `runStart` sobre cada membro do grupo.
 * DELIBERADAMENTE não cria nada novo: cada serviço segue processo independente, com
 * seu próprio lock/pidfile/estado — este loop só chama o MESMO `runStart` que
 * "aluy service start <nome>" chamaria, um de cada vez. A falha de UM membro (exit
 * !== 0, ou uma exceção inesperada) NUNCA impede os demais de tentar — o comando
 * reporta o resultado de cada um, honestamente, no final.
 */
async function runStartGroup(
  group: string,
  yes: boolean,
  io: TerminalIO,
  store: UserServicesStore,
): Promise<number> {
  const members = groupMembers(store, group);
  if (members.length === 0) {
    io.err(`aluy: nenhum serviço com "group: ${group}" encontrado em ${store.servicesDir}.`);
    return 1;
  }
  io.out(`grupo "${group}" — ${members.length} serviço(s): ${members.join(', ')}`);
  const failed: string[] = [];
  for (const name of members) {
    io.out('');
    io.out(`— ${name} —`);
    try {
      const code = await runStart(name, yes, io, store);
      if (code !== 0) failed.push(name);
    } catch (err) {
      failed.push(name);
      io.err(`aluy: erro inesperado ao iniciar "${name}" — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  io.out('');
  if (failed.length > 0) {
    io.out(
      `⚠ grupo "${group}": ${members.length - failed.length}/${members.length} iniciado(s) — ` +
        `falharam: ${failed.join(', ')} (veja as mensagens acima de cada um).`,
    );
    return 1;
  }
  io.out(`✓ grupo "${group}": todos os ${members.length} serviço(s) iniciados.`);
  return 0;
}

/**
 * `stop --group <nome>` — mesma disciplina de `runStartGroup`, iterando `runStop`.
 * Um serviço já parado no grupo não é falha (mesmo comportamento do `stop` singular).
 */
async function runStopGroup(group: string, io: TerminalIO, store: UserServicesStore): Promise<number> {
  const members = groupMembers(store, group);
  if (members.length === 0) {
    io.err(`aluy: nenhum serviço com "group: ${group}" encontrado em ${store.servicesDir}.`);
    return 1;
  }
  io.out(`grupo "${group}" — ${members.length} serviço(s): ${members.join(', ')}`);
  const failed: string[] = [];
  for (const name of members) {
    io.out('');
    io.out(`— ${name} —`);
    try {
      const code = await runStop(name, io, store);
      if (code !== 0) failed.push(name);
    } catch (err) {
      failed.push(name);
      io.err(`aluy: erro inesperado ao parar "${name}" — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  io.out('');
  if (failed.length > 0) {
    io.out(
      `⚠ grupo "${group}": ${members.length - failed.length}/${members.length} parado(s) — ` +
        `falharam: ${failed.join(', ')} (veja as mensagens acima de cada um).`,
    );
    return 1;
  }
  io.out(`✓ grupo "${group}": todos os ${members.length} serviço(s) parados.`);
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

/**
 * ADR-0158 §11 (FASE 4) — `attach`: ENTRA num serviço rodando. Conecta ao socket
 * local que o PRÓPRIO runner serve (`attach-server.ts`), imprime log+estado(+blocos,
 * melhor esforço) ao vivo, e lê linhas do stdin — cada Enter manda `say` (a fala do
 * dono, tratada pelo runner como INSTRUÇÃO — §11: "a mesma autoridade que teria pelo
 * canal remoto"). Ctrl-C (SIGINT) faz DETACH — fecha só a conexão do LADO DO
 * CLIENTE; o serviço SEGUE rodando (nunca é este comando que o para — "stop" é
 * sempre um ato explícito à parte).
 *
 * DECISÃO (além do ADR — a missão listava "Esc/Ctrl-C"): Ctrl-C (SIGINT) é o
 * detach PRIMÁRIO e único testado automaticamente (funciona em qualquer stdin —
 * TTY ou não). ESC como tecla crua exigiria colocar o stdin em raw-mode, o que
 * quebraria a edição de linha do `readline` usada p/ digitar o `say` — as duas
 * coisas competem pelo MESMO stdin. Combiná-las direito (raw-mode com um editor de
 * linha próprio) é viável mas não cabe na v1 sem um teste automatizado de TTY real
 * (fora do alcance da suíte headless) — DEGRADE DOCUMENTADO: só Ctrl-C na v1; ESC
 * fica para quando houver um terminal de verdade pra testar contra.
 */
async function runAttach(
  name: string,
  io: TerminalIO,
  store: UserServicesStore,
  connect: typeof connectAttachSocket,
  stdin: NodeJS.ReadableStream,
): Promise<number> {
  const dir = store.resolveDir(name);
  if (dir === undefined || !existsSync(dir)) {
    io.err(`aluy: serviço "${name}" não encontrado em ${store.servicesDir}.`);
    return 1;
  }
  if (!readServiceRuntimeStatus(dir).running) {
    io.err(`aluy: serviço "${name}" está PARADO — rode \`aluy service start ${name}\` primeiro.`);
    return 1;
  }

  const sockPath = attachSocketPath(dir);
  // ADR-0158 §11 (FASE 4) — corrida honesta: "rodando" (pidfile+kill-0, checado
  // acima) fica `true` assim que o runner ESCREVE O PIDFILE — um instante ANTES de
  // ele terminar de subir o socket de attach (`startAttachServer` roda depois, no
  // corpo de `runServiceRunner`). `aluy service start && aluy service attach` em
  // sequência rápida bateria nessa janela. Espera até ~3s pelo ARQUIVO do socket
  // aparecer antes de tentar conectar — best-effort, nunca trava p/ sempre.
  const socketDeadline = Date.now() + 3000;
  while (!existsSync(sockPath) && Date.now() < socketDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  io.out(`conectando ao serviço "${name}"… (Ctrl-C p/ detach — o serviço segue rodando)`);

  return await new Promise<number>((resolve) => {
    let finished = false;
    let cleanupInput: () => void = () => {};

    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      cleanupInput();
      resolve(code);
    };

    const conn = connect(sockPath, {
      onLine: (line) => io.out(line),
      onClose: (reason) => {
        io.out(`— ${reason} —`);
        finish(0);
      },
    });

    const detach = (): void => {
      if (finished) return;
      io.out('— detach — o serviço segue rodando —');
      conn.close();
      finish(0);
    };

    // `terminal:false` — o attach não precisa de edição de linha rica (histórico/
    // setas); só linha ⇒ Enter ⇒ `say`. Funciona sobre QUALQUER `Readable` (TTY ou
    // não), o que torna o caminho testável sem TTY real (ver o comentário acima).
    const rl = createInterface({ input: stdin, terminal: false });
    rl.on('line', (text) => {
      const trimmed = text.trim();
      if (trimmed === '') return;
      conn.send(trimmed);
    });
    // EOF do stdin (pipe fechado, Ctrl-D) É um detach — mesma disciplina de
    // qualquer client interativo (docker attach/ssh): sem mais entrada, sai.
    rl.on('close', detach);

    const onSigint = (): void => detach();
    process.once('SIGINT', onSigint);

    cleanupInput = (): void => {
      rl.close();
      process.off('SIGINT', onSigint);
    };
  });
}
