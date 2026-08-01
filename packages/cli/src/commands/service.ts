// ADR-0158 (aceito, APR-0148) — `aluy service <sub>`: FASE 1 = fundação SEM runner
// (o processo-por-serviço é a fase 2, §5). O shell é o ESPELHO do `/service`
// in-session (canal PRINCIPAL, emenda de aprovação §10) — mesma mecânica, zero
// lógica duplicada: os dois consomem `UserServicesStore` + os formatadores PUROS
// do core, como `/telegram`/`aluy telegram` sobre a mesma bridge.
//
// Fase 1 (esta fatia):
//   list       — lista os serviços instalados (estado sempre "parado", §5 fatia 2).
//   status     — detalhe de UM serviço + a validação (cron/workflow) já conferida.
//   install    — copia um diretório local OU clona um repo git p/ `~/.aluy/services/`,
//                VALIDA antes de ativar, mostra o MANIFESTO VISÍVEL (§9) e exige
//                confirmação (`--yes` explícito p/ modo não-interativo).
//   uninstall  — remove o diretório do serviço (pede confirmação).
//
// `create`/`start`/`stop`/`logs`/`update`/`attach` (superfície completa do ADR-0158
// §10) respondem HONESTO "disponível numa fase seguinte" — nada finge que start liga
// um processo que ainda não existe (CRIAR NÃO É LIGAR é doutrina §10, mas aqui nem
// "criar" liga: é "nem start existe ainda").

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildServicesNote,
  buildServiceManifestVisibleNote,
  parseServiceManifest,
  isServiceManifestError,
} from '@hiperplano/aluy-cli-core';
import { realTerminalIO, type TerminalIO } from '../auth/io.js';
import {
  UserServicesStore,
  scanServiceDirForInstall,
  isServiceEntryError,
} from '../io/services-store.js';
import { validateCronExpr } from './cron.js';

export type ServiceCommand =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'list' }
  | { kind: 'status'; name: string }
  | { kind: 'install'; source: string; yes: boolean }
  | { kind: 'uninstall'; name: string; yes: boolean }
  // ADR-0158 §5/§10 — chegam com o runner (fase 2). Reconhecidos aqui já agora p/ o
  // shell NÃO cair em "subcomando desconhecido" (UX ruim) e sim numa resposta honesta.
  | { kind: 'not-yet'; sub: string };

const PHASE2_SUBCOMMANDS = new Set(['create', 'start', 'stop', 'logs', 'update', 'attach']);

const SERVICE_HELP = `aluy service — SERVIÇOS plugáveis (ADR-0158) · fase 1: SEM runner ainda

Uso:
  aluy service [list]
  aluy service status <nome>
  aluy service install <path|git-url> [--yes]
  aluy service uninstall <nome> [--yes]

Subcomandos:
  list                 Lista os serviços instalados (nome, estado, próximo schedule,
                        descrição). Sem argumento, "aluy service" já lista (espelha o
                        /service in-session sem args, ADR-0158 §11).
  status <nome>         Detalhe de um serviço + a validação (cron/workflow) conferida
                        pelo registry. Serviço inválido mostra o motivo (RES-MD-3).
  install <path|url>    Copia um diretório local OU clona um repo git p/
                        ~/.aluy/services/<nome>/. Valida ANTES de ativar e mostra o
                        MANIFESTO VISÍVEL (daemons, skills com script, mcp.json, canal,
                        autonomia) — exige confirmação. --yes pula o prompt (scripts/CI).
  uninstall <nome>      Remove o diretório do serviço. Pede confirmação (--yes pula).

Notas:
  - create/start/stop/logs/update/attach chegam na FASE 2 (o processo-por-serviço,
    ADR-0158 §5). Instalar NÃO liga nada — não há o que ligar ainda nesta fase.
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

  if (PHASE2_SUBCOMMANDS.has(sub)) return { kind: 'not-yet', sub };

  return { kind: 'error', message: `service: subcomando desconhecido "${sub}".` };
}

export interface ServiceDeps {
  readonly io?: TerminalIO;
  readonly store?: UserServicesStore;
  /** Clonador de git injetável p/ teste (default: `git clone --depth 1`). */
  readonly gitClone?: (url: string, dest: string) => void;
}

/** Resposta honesta p/ subcomandos da fase 2 (§5) — nunca finge que já existem. */
function notYetLines(sub: string): readonly string[] {
  return [
    `"aluy service ${sub}" ainda não existe — chega na fase 2 do ADR-0158 (o`,
    'processo-por-serviço, §5). Esta fase entrega a fundação: manifesto, registry,',
    'install/uninstall com o manifesto visível, e a listagem.',
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
      const note = buildServicesNote({
        services,
        errors: errors.map((e) => ({ dirName: e.dirName, reason: e.reason })),
        servicesDir: store.servicesDir,
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
      io.out(`serviço "${m.name}" — parado (fase 1, sem runner ainda)`);
      io.out(`  dir:         ${entry.dir}`);
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
  }
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
    io.out('  PARADO (fase 1, sem runner ainda) — start/stop chegam na fase 2 (ADR-0158 §5).');
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
