// ADR-0158 §5 — O RUNNER: UM PROCESSO POR SERVIÇO. Este módulo É o corpo do
// "processo que É o serviço" (`aluy service run <nome> --runner`, spawnado
// DESTACADO por `aluy service start <nome>` — ver `commands/service.ts`). Ciclo:
//
//   1. lê `service.md` (via `UserServicesStore`, já validado — cron/workflow OK);
//   2. dorme até o `schedule` (§5 pt.2 — "fora do horário, o serviço nem acorda:
//      regra dura por construção" — `nextCronFire`, cli-core);
//   3. no início do expediente: sobe os daemons próprios (§6) + abre um TURNO
//      HEADLESS por atividade do `workflow:`, com wiring ESCOPADO (§2 — via a env
//      var interna `ALUY_SERVICE_HOME` que `run.tsx`/`wiring.ts` já respeitam);
//   4. `until:` atingido ⇒ encerra o turno (mata o processo-filho) — regra dura §3;
//   5. `budget:` ⇒ vira `--max-tokens` (reusa `resolveMaxTokens`/`limits.ts` via a
//      flag JÁ existente do `aluy -p`, sem duplicar o clamp anti-runaway);
//   6. fechamento de turno com pergunta pendente (`awaitsUserDecision`, ADR-0157) ⇒
//      loga "aguardando dono" e PARA — nunca prossegue com suposição (§5 pt.4/§3;
//      canal/Telegram é fase 3 — aqui só o log + `status` sinalizam);
//   7. volta a dormir até o próximo `schedule`.
//
// Cada ATIVIDADE do workflow é UM turno headless `aluy -p` em processo FILHO
// separado (não in-process): teardown de recursos (MCP/broker) garantido pelo SO a
// cada turno — o runner pode viver dias/semanas sem acumular handle vazado de N
// turnos (o caminho `-p` do `aluy` foi desenhado para "roda e sai", não para ser
// chamado repetidamente num processo hospedeiro de vida longa).
//
// SIGTERM (`aluy service stop`) ⇒ derruba os daemons, mata o turno em andamento
// (gracioso: SIGTERM no filho, SIGKILL de timeout), remove o pidfile, sai.

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  nextCronFire,
  parseServiceBudget,
  msUntilDeadline,
  awaitsUserDecision,
  runWorkflow,
  parseWorkflow,
  isWorkflowError,
  type WorkflowActivity,
  type WorkflowActivityOutcome,
  type WorkflowActivityRunner,
} from '@hiperplano/aluy-cli-core';
import { UserServicesStore, isServiceEntryError, type ServiceEntry } from '../io/services-store.js';
import { runnerPidPath } from './paths.js';
import { writePidFile, removePidFile } from './pid.js';
import { appendLog } from './log.js';
import { runnerLogPath } from './paths.js';
import { writeServiceStatus } from './status.js';
import { startDaemons, stopDaemons } from './daemons.js';

/** Teto duro por ATIVIDADE, mesmo sem `until:` declarado — anti-runaway (CLI-SEC-8):
 * um serviço sem `until:` não pode travar o runner p/ sempre num turno preso. */
const MAX_ACTIVITY_MS = 30 * 60_000; // 30 minutos

/** Timeout de graça entre SIGTERM e SIGKILL de um processo-filho (turno ou daemon). */
const GRACE_KILL_MS = 8_000;

export interface RunServiceRunnerDeps {
  /** Raiz do `~/.aluy/` (default: home real). Injetável p/ teste (tmpdir) — NUNCA o
   * HOME real em teste (a mesma trava do smoke-test manual pedida na missão). */
  readonly aluyBaseDir?: string;
  readonly log?: (line: string) => void;
  /** Caminho do entrypoint `aluy` a re-invocar por turno (default: o mesmo script
   * deste processo, `process.argv[1]`) — injetável p/ teste. */
  readonly aluyEntrypoint?: string;
  readonly execPath?: string;
  /** Sinal externo de parada (teste) — além do SIGTERM/SIGINT reais do processo. */
  readonly externalStop?: AbortSignal;
}

function killGracefully(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* já morreu */
  }
  const t = setTimeout(() => {
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch {
      /* já morreu */
    }
  }, GRACE_KILL_MS);
  t.unref();
}

/** Espera até `date` OU até `stop` disparar — o que vier primeiro. */
function sleepUntil(date: Date, stop: AbortSignal): Promise<'woke' | 'stopped'> {
  const ms = Math.max(0, date.getTime() - Date.now());
  return new Promise((resolve) => {
    if (stop.aborted) {
      resolve('stopped');
      return;
    }
    const timer = setTimeout(() => {
      stop.removeEventListener('abort', onAbort);
      resolve('woke');
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve('stopped');
    };
    stop.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Roda UMA atividade como um turno headless `aluy -p` em processo FILHO, com wiring
 * ESCOPADO ao serviço (§2, via `ALUY_SERVICE_HOME`). Mata o filho se `stop` disparar
 * OU se o `deadlineMs` (restante até o `until:`, ou o teto duro) vencer PRIMEIRO.
 */
async function runActivityTurn(args: {
  readonly serviceDir: string;
  readonly serviceName: string;
  readonly orchestratorPreamble: string;
  readonly activity: WorkflowActivity;
  readonly index: number;
  readonly total: number;
  readonly budgetTokens?: number;
  readonly deadlineMs: number;
  readonly stop: AbortSignal;
  readonly execPath: string;
  readonly aluyEntrypoint: string;
  readonly log: (line: string) => void;
  /** Preenchido com o texto da pergunta pendente quando o outcome é `awaiting-owner`. */
  readonly pendingQuestionRef: { current?: string };
}): Promise<WorkflowActivityOutcome> {
  const { activity, index, total, deadlineMs, stop, log } = args;

  if (stop.aborted) return { ok: false, stop: 'cancelled' };
  if (deadlineMs <= 0) {
    log(`atividade ${index + 1}/${total} "${activity.id}": expediente já encerrado (until) — pulada.`);
    return { ok: false, stop: 'limit' };
  }

  const agentHint =
    activity.agent !== undefined
      ? `\n\n(Execute esta atividade especificamente como o agente "${activity.agent}" — ` +
        `use \`spawn_agent\` com esse nome se fizer sentido; ele está disponível no ` +
        `registro escopado deste serviço.)`
      : '';
  const goal =
    `${args.orchestratorPreamble}\n\n` +
    `[Atividade ${index + 1}/${total} do workflow — id "${activity.id}"]\n${activity.goal}${agentHint}`;

  const argv = [args.aluyEntrypoint, '-p', goal, '--output-format', 'json', '--quiet'];
  if (args.budgetTokens !== undefined) argv.push('--max-tokens', String(args.budgetTokens));

  const timeoutMs = Math.min(deadlineMs, MAX_ACTIVITY_MS);
  log(`atividade ${index + 1}/${total} "${activity.id}": iniciando turno (teto ${Math.round(timeoutMs / 1000)}s)…`);

  const child = spawn(args.execPath, argv, {
    cwd: args.serviceDir,
    env: { ...process.env, ALUY_SERVICE_HOME: args.serviceDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => {
    stdout += c.toString('utf8');
  });
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });

  const onStopAbort = (): void => killGracefully(child);
  stop.addEventListener('abort', onStopAbort, { once: true });
  const deadlineTimer = setTimeout(() => killGracefully(child), timeoutMs);
  deadlineTimer.unref();

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', () => resolve({ code: null, signal: null }));
  });
  clearTimeout(deadlineTimer);
  stop.removeEventListener('abort', onStopAbort);

  if (stop.aborted) {
    log(`atividade ${index + 1}/${total} "${activity.id}": interrompida (stop do runner).`);
    return { ok: false, stop: 'cancelled' };
  }
  // O filho morreu por SINAL (SIGTERM/SIGKILL) ⇒ fomos NÓS que o derrubamos — via
  // `killGracefully` no timer do deadline (`until:`/teto duro). `stop.aborted` já
  // foi descartado acima, então um sinal aqui só pode ser o deadline.
  if (exit.signal !== null) {
    log(`atividade ${index + 1}/${total} "${activity.id}": ATINGIU O TETO (until/teto duro) — encerrada.`);
    return { ok: false, stop: 'limit' };
  }

  const line = stdout.trim().split('\n').pop() ?? '';
  let parsed: { result?: unknown; ok?: unknown } | undefined;
  try {
    parsed = JSON.parse(line) as { result?: unknown; ok?: unknown };
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || typeof parsed.result !== 'string' || typeof parsed.ok !== 'boolean') {
    log(
      `atividade ${index + 1}/${total} "${activity.id}": saída ilegível (exit ${exit.code}) — ` +
        `${stderr.trim().slice(0, 500) || '(sem stderr)'}`,
    );
    return { ok: false, stop: 'error' };
  }

  if (!parsed.ok) {
    log(`atividade ${index + 1}/${total} "${activity.id}": turno terminou com erro.`);
    return { ok: false, stop: 'error' };
  }

  const resultText = parsed.result;
  if (awaitsUserDecision(resultText)) {
    // ADR-0158 §5 pt.4/§3 — regra dura: NUNCA prossegue com suposição. Sem canal
    // ainda (fase 3), a "espera pelo canal" desta fase é: loga + PARA o workflow;
    // `status`/`/service status` sinalizam "aguardando dono" até o próximo `start`
    // manual ou (fase 3) resposta pelo canal.
    const tail = resultText.trim().split('\n').slice(-3).join(' ');
    args.pendingQuestionRef.current = tail;
    log(`atividade ${index + 1}/${total} "${activity.id}": AGUARDANDO DONO — "${tail}"`);
    return { ok: false, stop: 'awaiting-owner' };
  }

  log(`atividade ${index + 1}/${total} "${activity.id}": ok.`);
  return { ok: true };
}

/**
 * Roda o processo do serviço (o corpo de `aluy service run <nome> --runner`). NUNCA
 * lança — devolve o exit code. `deps.externalStop` permite teste determinístico sem
 * depender de sinal real de SO.
 */
export async function runServiceRunner(name: string, deps: RunServiceRunnerDeps = {}): Promise<number> {
  const store = new UserServicesStore(deps.aluyBaseDir !== undefined ? { baseDir: deps.aluyBaseDir } : {});
  const entry = store.get(name);
  if (entry === undefined || isServiceEntryError(entry)) {
    process.stderr.write(
      `aluy: serviço "${name}" inválido/não encontrado — não é possível iniciar o runner.\n`,
    );
    return 1;
  }
  const service: ServiceEntry = entry;
  const serviceDir = service.dir;
  const logPath = deps.log ? undefined : runnerLogPath(serviceDir);
  const log = deps.log ?? ((line: string) => appendLog(logPath!, line));

  if (service.manifest.schedule === undefined) {
    log('FATAL: serviço sem "schedule:" declarado — o runner não sabe quando acordar. Abortando.');
    return 1;
  }

  const pidPath = runnerPidPath(serviceDir);
  writePidFile(pidPath, process.pid);
  log(`runner iniciado (pid ${process.pid}) — serviço "${service.manifest.name}".`);

  const stopController = new AbortController();
  const onSignal = (sig: NodeJS.Signals): void => {
    log(`sinal ${sig} recebido — encerrando graciosamente…`);
    stopController.abort();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  deps.externalStop?.addEventListener('abort', () => stopController.abort(), { once: true });

  const shutdown = (): void => {
    stopDaemons(serviceDir, log);
    writeServiceStatus(serviceDir, { turnState: 'sleeping' });
    removePidFile(pidPath);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    log('runner encerrado.');
  };

  const execPath = deps.execPath ?? process.execPath;
  const aluyEntrypoint = deps.aluyEntrypoint ?? process.argv[1] ?? '';

  try {
    while (!stopController.signal.aborted) {
      const now = new Date();
      const next = nextCronFire(service.manifest.schedule, now);
      if (next === undefined) {
        log(`FATAL: "schedule: ${service.manifest.schedule}" nunca dispara (ou é inválido). Abortando.`);
        // FATAL fora do `stopController.abort()` — o `finally` abaixo só limpa em
        // shutdown GRACIOSO (sinal); aqui precisamos limpar manualmente p/ nunca
        // deixar um pidfile órfão apontando pra um processo que já morreu.
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        removePidFile(pidPath);
        return 1;
      }
      writeServiceStatus(serviceDir, { turnState: 'sleeping', nextFireIso: next.toISOString() });
      log(`dormindo até ${next.toISOString()} (próximo turno).`);

      const wake = await sleepUntil(next, stopController.signal);
      if (wake === 'stopped') break;

      // ── início do expediente (§5 pt.3/§6) ──────────────────────────────────
      log('acordou — início do expediente: subindo daemons próprios (se houver)…');
      startDaemons(serviceDir, log);
      writeServiceStatus(serviceDir, { turnState: 'running-turn' });

      const outcome = await runOneWorkflow({
        serviceDir,
        serviceName: service.manifest.name,
        workflowName: service.manifest.workflow,
        orchestratorBody: service.manifest.orchestrator,
        budgetRaw: service.manifest.budget,
        untilRaw: service.manifest.until,
        stop: stopController.signal,
        execPath,
        aluyEntrypoint,
        log,
      });

      if (outcome.kind === 'awaiting-owner') {
        writeServiceStatus(serviceDir, {
          turnState: 'awaiting-owner',
          pendingQuestion: outcome.question,
          lastReportSummary: `aguardando dono: ${outcome.question}`,
        });
        log('turno encerrado — AGUARDANDO DONO (sem canal nesta fase: revise o log e "aluy service start" de novo quando resolver).');
      } else {
        log(`turno encerrado — ${outcome.summary}`);
      }

      log('fim do expediente — derrubando daemons próprios…');
      stopDaemons(serviceDir, log);

      if (outcome.kind === 'awaiting-owner') {
        // Regra dura §5 pt.4: não volta a tentar sozinho. Encerra o processo do
        // runner inteiro (o dono decide quando religar via `aluy service start`).
        removePidFile(pidPath);
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        log('runner encerrado (aguardando dono).');
        return 0;
      }
    }
  } finally {
    if (stopController.signal.aborted) shutdown();
  }
  return 0;
}

type WorkflowOutcome =
  | { readonly kind: 'ok'; readonly summary: string }
  | { readonly kind: 'stopped'; readonly summary: string }
  | { readonly kind: 'awaiting-owner'; readonly question: string };

async function runOneWorkflow(args: {
  readonly serviceDir: string;
  readonly serviceName: string;
  readonly workflowName: string | undefined;
  readonly orchestratorBody: string;
  readonly budgetRaw: string | undefined;
  readonly untilRaw: string | undefined;
  readonly stop: AbortSignal;
  readonly execPath: string;
  readonly aluyEntrypoint: string;
  readonly log: (line: string) => void;
}): Promise<WorkflowOutcome> {
  const { serviceDir, workflowName, log } = args;
  if (workflowName === undefined) {
    log('sem "workflow:" declarado — nada a executar neste turno.');
    return { kind: 'ok', summary: 'sem workflow declarado (no-op).' };
  }
  const wfPath = join(serviceDir, 'workflows', `${workflowName}.md`);
  if (!existsSync(wfPath)) {
    log(`FATAL do turno: workflows/${workflowName}.md não encontrado.`);
    return { kind: 'stopped', summary: `workflow "${workflowName}" não encontrado.` };
  }
  const raw = readFileSync(wfPath, 'utf8');
  const parsed = parseWorkflow(`${workflowName}.md`, raw, 'project');
  if (isWorkflowError(parsed)) {
    log(`FATAL do turno: workflow "${workflowName}" inválido — ${parsed.reason}`);
    return { kind: 'stopped', summary: `workflow inválido — ${parsed.reason}` };
  }

  const budgetTokens = parseServiceBudget(args.budgetRaw);
  const orchestratorPreamble =
    `Você coordena o serviço "${args.serviceName}" (ADR-0158) — rege, não opera:\n${args.orchestratorBody}`;

  const pendingQuestionRef: { current?: string } = {};
  const runner: WorkflowActivityRunner = {
    async runActivity({ index, total, id, goal, signal: _rootSignal }) {
      void _rootSignal; // o `runWorkflow` já checa entre atividades; usamos `args.stop`.
      const now = new Date();
      const remaining = msUntilDeadline(now, args.untilRaw);
      const deadlineMs = remaining ?? MAX_ACTIVITY_MS;
      return runActivityTurn({
        serviceDir,
        serviceName: args.serviceName,
        orchestratorPreamble,
        activity: { id, goal, agent: parsed.activities[index]?.agent } as WorkflowActivity,
        index,
        total,
        ...(budgetTokens !== undefined ? { budgetTokens } : {}),
        deadlineMs,
        stop: args.stop,
        execPath: args.execPath,
        aluyEntrypoint: args.aluyEntrypoint,
        log: args.log,
        pendingQuestionRef,
      });
    },
  };

  const res = await runWorkflow(parsed.activities, runner, args.stop);
  if (res.lastStop === 'awaiting-owner') {
    return { kind: 'awaiting-owner', question: pendingQuestionRef.current ?? '(ver runner.log)' };
  }
  if (res.stopped) {
    return {
      kind: 'stopped',
      summary: `parou em ${res.activitiesRun}/${parsed.activities.length} atividades (${res.lastStop ?? 'motivo desconhecido'}).`,
    };
  }
  return { kind: 'ok', summary: `${res.activitiesRun}/${parsed.activities.length} atividades concluídas.` };
}
