// EST-1150 · ADR-0128 — `aluy cron add/list/rm/run`: agendamento PERSISTENTE de jobs
// disparados pelo cron do SO (sem daemon próprio na v1).
//
// 1ª fatia: Linux (crontab). Windows/macOS = ondas seguintes (Q-128-1).
//
// Segurança (CLI-SEC-16 · ADR-0128 §3):
// - ask-sem-humano ⇒ para-e-reporta (NAO auto-aprova).
// - --yolo por-job é opt-in explícito (persistido na definição com aviso).
// - Categorias sempre-ask continuam não-relaxáveis (ADR-0072/CLI-SEC-3).
// - Anti-runaway duro (CLI-SEC-14): job que embrulha --cycle herda os tetos.
// - Confinamento herdado: workspace declarado no job (path-deny ADR-0053).

import { execSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  /** Cron expression (ex.: "0 9 * * 1-5"). */
  schedule: string;
  /** Tarefa a executar. */
  task: string;
  /** Timestamp ISO de criação. */
  criado_em: string;
  /** Opt-in explícito para rodar sem confirmação (--yolo). */
  yolo: boolean;
  /** Workspace confinado (default cwd no momento do add). */
  workspace?: string;
  /** Habilitado? Ausente/true ⇒ agendado no SO; false ⇒ pausado (fica no jobs.json,
   * fora do crontab). EST-1159 — enable/disable sem excluir. */
  enabled?: boolean;
}

export interface CronState {
  jobs: CronJob[];
}

// ─── Caminhos ────────────────────────────────────────────────────────────────

function cronDir(): string {
  return join(homedir(), '.aluy', 'cron');
}

function jobsPath(): string {
  return join(cronDir(), 'jobs.json');
}

function ensureCronDir(): void {
  mkdirSync(cronDir(), { recursive: true, mode: 0o700 });
}

// ─── Persistência ────────────────────────────────────────────────────────────

export function loadState(): CronState {
  try {
    const raw = readFileSync(jobsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return { jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch {
    return { jobs: [] };
  }
}

export function saveState(state: CronState): void {
  ensureCronDir();
  writeFileSync(jobsPath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

// ─── Crontab (Linux) ─────────────────────────────────────────────────────────

const MARKER = '# aluy-cron-jobs';
const RUNNER_CMD = `aluy cron run`;

/**
 * Reconstrói o bloco de entradas do aluy no crontab.
 * Preserva o resto do crontab do usuário.
 */
function syncCrontab(): void {
  const state = loadState();

  // Lê crontab atual
  let current = '';
  try {
    current = execFileSync('crontab', ['-l'], { encoding: 'utf8' });
  } catch {
    // crontab vazio ou inexistente
  }

  // Remove o bloco antigo do aluy
  const lines = current.split('\n');
  const filtered: string[] = [];
  let inAluyBlock = false;
  for (const line of lines) {
    if (line.trim() === MARKER) {
      inAluyBlock = !inAluyBlock;
      continue;
    }
    if (!inAluyBlock) {
      filtered.push(line);
    }
  }

  // Reconstrói o bloco do aluy — SÓ os jobs HABILITADOS (disabled fica fora do SO).
  const active = state.jobs.filter((j) => j.enabled !== false);
  const newBlock: string[] = [];
  if (active.length > 0) {
    newBlock.push(MARKER);
    for (const job of active) {
      newBlock.push(`${job.schedule} ${RUNNER_CMD} ${job.id}`);
    }
    newBlock.push(MARKER);
  }

  // Monta o crontab final
  const final = [...filtered.filter((l) => l.trim() !== ''), ...newBlock].join('\n') + '\n';

  if (final.trim() === '') {
    // Remove crontab se ficar vazio
    try {
      execFileSync('crontab', ['-r'], { encoding: 'utf8' });
    } catch {
      // já estava vazio
    }
    return;
  }

  // Escreve via stdin do crontab
  execSync(`crontab -`, { input: final, encoding: 'utf8' });
}

// ─── Parsing do comando ──────────────────────────────────────────────────────

export type CronCommand =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'add'; quando: string; tarefa: string; yolo: boolean }
  | { kind: 'list' }
  | { kind: 'rm'; id: string }
  | { kind: 'run'; id: string }
  | { kind: 'edit'; id: string; quando?: string; tarefa?: string; yolo?: boolean }
  | { kind: 'enable'; id: string }
  | { kind: 'disable'; id: string };

const CRON_HELP = `aluy cron — agendamento PERSISTENTE (jobs disparados pelo cron do SO)

Uso:
  aluy cron add <quando> "<tarefa>" [--yolo]
  aluy cron list
  aluy cron edit <id> [--quando "<cron>"] [--tarefa "<txt>"] [--yolo|--no-yolo]
  aluy cron enable <id> | disable <id>
  aluy cron rm <id>
  aluy cron run <id>

Subcomandos:
  add  <quando> "<tarefa>"  Agenda uma nova tarefa. <quando> é uma expressão cron
                            de 5 campos (ex.: "0 9 * * 1-5" = dias úteis às 9h).
                            Com --yolo a tarefa roda sem pedir confirmação
                            (opt-in explícito; categorias sempre-ask seguem
                            não-relaxáveis).
  list                      Lista os jobs (id, estado on/off, schedule, tarefa, yolo).
  edit <id> [flags]         Reconfigura um job existente (preserva id+histórico):
                            --quando "<cron>", --tarefa "<txt>", --yolo|--no-yolo.
                            Só os campos passados mudam.
  enable  <id>              Reativa um job desabilitado (volta ao agendador do SO).
  disable <id>              Desabilita SEM excluir: sai do crontab, fica salvo.
  rm   <id>                 Remove um job pelo id e desagenda do cron do SO.
  run  <id>                 Roda um job AGORA (via aluy -p), pela catraca.

Notas:
  - 1ª fatia: Linux (crontab). Windows/macOS em ondas seguintes.
  - Tarefa roda SEM sessão aberta: se a catraca pedir confirmação (ask) e não
    houver humano, o run PARA e reporta (NAO auto-aprova). Use --yolo com
    consciência para jobs que não precisam de supervisão.
  - Confinamento: o run roda no workspace do job (path-deny ADR-0053).
  - Anti-runaway: tetos do --cycle são herdados (CLI-SEC-14).
`;

export function parseCronCommand(argv: readonly string[]): CronCommand {
  const sub = argv[0];
  if (sub === undefined || sub === 'help' || sub === '-h' || sub === '--help') {
    return { kind: 'help' };
  }

  if (sub === 'list') {
    return { kind: 'list' };
  }

  if (sub === 'add') {
    const rest = argv.slice(1);
    const yolo = rest.includes('--yolo');
    const args = rest.filter((a) => a !== '--yolo');
    const quando = args[0];
    const tarefa = args[1];

    if (!quando) return { kind: 'error', message: 'cron add: falta o <quando> (expressão cron).' };
    if (!tarefa) return { kind: 'error', message: 'cron add: falta a "<tarefa>".' };

    // Validação básica da expressão cron (5 campos)
    const campos = quando.trim().split(/\s+/);
    if (campos.length !== 5) {
      return {
        kind: 'error',
        message: `cron add: <quando> inválido "${quando}" — use 5 campos cron (ex.: "0 9 * * 1-5").`,
      };
    }

    return { kind: 'add', quando, tarefa, yolo };
  }

  if (sub === 'rm' || sub === 'remove') {
    const id = argv[1];
    if (!id) return { kind: 'error', message: 'cron rm: falta o <id> do job.' };
    return { kind: 'rm', id };
  }

  if (sub === 'run') {
    const id = argv[1];
    if (!id) return { kind: 'error', message: 'cron run: falta o <id> do job.' };
    return { kind: 'run', id };
  }

  if (sub === 'enable' || sub === 'disable') {
    const id = argv[1];
    if (!id) return { kind: 'error', message: `cron ${sub}: falta o <id> do job.` };
    return { kind: sub, id };
  }

  if (sub === 'edit') {
    const rest = argv.slice(1);
    const id = rest[0];
    if (!id || id.startsWith('--')) {
      return { kind: 'error', message: 'cron edit: falta o <id> do job.' };
    }
    const flagVal = (name: string): string | undefined => {
      const i = rest.indexOf(name);
      return i !== -1 ? rest[i + 1] : undefined;
    };
    const quando = flagVal('--quando');
    const tarefa = flagVal('--tarefa');
    const yolo = rest.includes('--yolo') ? true : rest.includes('--no-yolo') ? false : undefined;
    if (quando === undefined && tarefa === undefined && yolo === undefined) {
      return {
        kind: 'error',
        message:
          'cron edit: nada a mudar — use --quando "<cron>", --tarefa "<txt>" e/ou --yolo|--no-yolo.',
      };
    }
    if (quando !== undefined && quando.trim().split(/\s+/).length !== 5) {
      return {
        kind: 'error',
        message: `cron edit: --quando inválido "${quando}" — use 5 campos cron (ex.: "0 9 * * 1-5").`,
      };
    }
    return {
      kind: 'edit',
      id,
      ...(quando !== undefined ? { quando } : {}),
      ...(tarefa !== undefined ? { tarefa } : {}),
      ...(yolo !== undefined ? { yolo } : {}),
    };
  }

  return { kind: 'error', message: `cron: subcomando desconhecido "${sub}".` };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export interface CronDeps {
  aluyHome?: string;
  io?: {
    out: (line: string) => void;
    err: (line: string) => void;
  };
}

/**
 * Despacha o comando `aluy cron …`.
 * Retorna exit code (0 = sucesso, 1 = erro de uso/estado, 2 = erro do runner).
 */
export async function runCron(argv: readonly string[], deps: CronDeps = {}): Promise<number> {
  const out = deps.io?.out ?? console.log;
  const err = deps.io?.err ?? console.error;

  const cmd = parseCronCommand(argv);

  switch (cmd.kind) {
    case 'help':
      out(CRON_HELP);
      return 0;

    case 'error':
      err(`aluy: ${cmd.message}`);
      err("rode 'aluy cron --help' para ver o uso.");
      return 1;

    case 'add': {
      ensureCronDir();
      const state = loadState();

      const job: CronJob = {
        id: randomUUID(),
        schedule: cmd.quando,
        task: cmd.tarefa,
        criado_em: new Date().toISOString(),
        yolo: cmd.yolo,
        workspace: process.cwd(),
      };

      state.jobs.push(job);
      saveState(state);

      // Sincroniza crontab (Linux)
      if (process.platform === 'linux') {
        try {
          syncCrontab();
        } catch (e) {
          err(`aluy: erro ao atualizar crontab: ${e instanceof Error ? e.message : String(e)}`);
          // Não reverte o job — o estado está salvo. O usuário pode corrigir permissões.
        }
      } else {
        out('aluy: aviso — agendamento pelo cron do SO disponível só no Linux nesta fatia.');
        out('  O job foi salvo mas NÃO foi instalado no agendador do SO.');
      }

      out(`Job "${job.id.slice(0, 8)}" adicionado:`);
      out(`  Schedule: ${job.schedule}`);
      out(`  Tarefa:   ${job.task}`);
      out(`  Yolo:     ${job.yolo ? 'sim (opt-in)' : 'não (padrão seguro)'}`);
      if (cmd.yolo) {
        out('  ⚠ --yolo ativo: a tarefa roda SEM pedir confirmação.');
        out('    Categorias sempre-ask seguem não-relaxáveis.');
      }
      return 0;
    }

    case 'list': {
      const state = loadState();
      if (state.jobs.length === 0) {
        out('Nenhum job agendado. Use: aluy cron add <quando> "<tarefa>"');
        return 0;
      }

      out(`Jobs agendados (${state.jobs.length}):`);
      for (const job of state.jobs) {
        const shortId = job.id.slice(0, 8);
        const yoloLabel = job.yolo ? 'yolo' : 'ask';
        const stateLabel = job.enabled === false ? 'off' : 'on ';
        out(`  ${shortId}  [${stateLabel}]  ${job.schedule}  [${yoloLabel}]  ${job.task}`);
      }
      return 0;
    }

    case 'rm': {
      const state = loadState();
      // Busca por prefixo do id
      const idx = state.jobs.findIndex((j) => j.id.startsWith(cmd.id));
      if (idx === -1) {
        err(`aluy: job "${cmd.id}" não encontrado. Use "aluy cron list" para ver os ids.`);
        return 1;
      }

      const removed = state.jobs[idx]!;
      state.jobs.splice(idx, 1);
      saveState(state);

      if (process.platform === 'linux') {
        try {
          syncCrontab();
        } catch (e) {
          err(`aluy: erro ao atualizar crontab: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      out(`Job "${removed.id.slice(0, 8)}" removido: ${removed.task}`);
      return 0;
    }

    case 'run': {
      const state = loadState();
      const job = state.jobs.find((j) => j.id.startsWith(cmd.id));
      if (!job) {
        err(`aluy: job "${cmd.id}" não encontrado. Use "aluy cron list" para ver os ids.`);
        return 1;
      }

      out(`Executando job "${job.id.slice(0, 8)}": ${job.task}`);

      // Monta o comando headless
      const yoloFlag = job.yolo ? ' --yolo' : '';
      const command = `aluy -p "${job.task.replace(/"/g, '\\"')}"${yoloFlag}`;

      out(`  Comando: ${command}`);

      try {
        execSync(command, {
          cwd: job.workspace || process.cwd(),
          stdio: 'inherit',
          encoding: 'utf8',
        });
        out('  ✓ Concluído.');
        return 0;
      } catch (e) {
        const exitCode = (e as { status?: number }).status ?? 2;
        err(`  ✗ Falhou (exit code: ${exitCode}).`);
        return exitCode;
      }
    }

    case 'enable':
    case 'disable': {
      const state = loadState();
      const job = state.jobs.find((j) => j.id.startsWith(cmd.id));
      if (!job) {
        err(`aluy: job "${cmd.id}" não encontrado. Use "aluy cron list" para ver os ids.`);
        return 1;
      }
      job.enabled = cmd.kind === 'enable';
      saveState(state);
      if (process.platform === 'linux') {
        try {
          syncCrontab();
        } catch (e) {
          err(`aluy: erro ao atualizar crontab: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      out(
        `Job "${job.id.slice(0, 8)}" ${cmd.kind === 'enable' ? 'HABILITADO' : 'DESABILITADO'}: ${job.task}`,
      );
      if (cmd.kind === 'disable') {
        out('  (continua salvo; fora do agendador do SO até reabilitar)');
      }
      return 0;
    }

    case 'edit': {
      const state = loadState();
      const job = state.jobs.find((j) => j.id.startsWith(cmd.id));
      if (!job) {
        err(`aluy: job "${cmd.id}" não encontrado. Use "aluy cron list" para ver os ids.`);
        return 1;
      }
      if (cmd.quando !== undefined) job.schedule = cmd.quando;
      if (cmd.tarefa !== undefined) job.task = cmd.tarefa;
      if (cmd.yolo !== undefined) job.yolo = cmd.yolo;
      saveState(state);
      if (process.platform === 'linux') {
        try {
          syncCrontab();
        } catch (e) {
          err(`aluy: erro ao atualizar crontab: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      out(`Job "${job.id.slice(0, 8)}" editado:`);
      out(`  Schedule: ${job.schedule}`);
      out(`  Tarefa:   ${job.task}`);
      out(`  Yolo:     ${job.yolo ? 'sim (opt-in)' : 'não (padrão seguro)'}`);
      return 0;
    }
  }
}
