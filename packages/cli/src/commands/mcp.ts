// EST-0970 · ADR-0058 (E-B1) · CLI-SEC-12 — comando `aluy mcp add/list/remove`.
//
// A camada de CONVENIÊNCIA p/ gerenciar servers MCP sem editar `~/.aluy/mcp.json` à mão.
// SEM registro/API-key externo: só o `command`/`args`/`env` que o usuário passar (server
// stdio é o caso base — ADR-0058). É ato do USUÁRIO (o comando que ele digita), equivalente
// a editar o arquivo — NÃO é caminho do agente (a catraca segue negando o agente em
// `~/.aluy/`; o server adicionado AINDA passa pela catraca no runtime).
//
//   aluy mcp add <nome> [--] <command> [args...] [--env K=V]... [--project] [--force]
//   aluy mcp list
//   aluy mcp remove <nome> [--project]
//
// SEGREDO (CLI-SEC-7): no `add`, cada `--env K=V` passa por `inspectEnvSecret` — se o VALOR
// parece um segredo LITERAL, AVISAMOS a usar referência (`$VAR`) em vez do cru (não
// bloqueamos: a config é DADO do usuário). Preserva a regra "o mcp.json não carrega segredo
// literal".

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import {
  buildMcpListing,
  inspectEnvSecret,
  invalidCommandWarning,
  originLabel,
  parseMcpConfig,
  EMPTY_MCP_CONFIG,
  McpConfigError,
  type McpConfig,
  type McpServerConfig,
  type McpSource,
} from '@hiperplano/aluy-cli-core';
import { realTerminalIO, type TerminalIO } from '../auth/io.js';
import { McpConfigStore } from './../mcp/mcp-config-store.js';
import { CodexMcpConfigStore } from './../mcp/codex-mcp-config.js';
import { McpConfigWriter, McpWriteError } from './../mcp/mcp-config-writer.js';
import { MCP_CONFIG_FILENAME } from './../mcp/mcp-config-store.js';
import { PROJECT_MCP_CONFIG_FILENAME } from './../mcp/project-mcp-config.js';

/** Operação resolvida do parser (puro) p/ o runner. */
export type McpCommand =
  | {
      readonly kind: 'add';
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: readonly (readonly [string, string])[];
      readonly project: boolean;
      readonly force: boolean;
    }
  | { readonly kind: 'list' }
  | { readonly kind: 'remove'; readonly name: string; readonly project: boolean }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string };

export const MCP_HELP_TEXT = `aluy mcp — gerencia servers MCP locais (stdio) sem editar o JSON à mão.

Uso:
  aluy mcp add <nome> [--] <command> [args...] [--env K=V]... [--project] [--force]
  aluy mcp list
  aluy mcp remove <nome> [--project]

Opções:
  --env K=V    Variável de ambiente do server (repetível). Use REFERÊNCIA
               (--env TOKEN=\\$MEU_TOKEN) em vez de segredo literal — o mcp.json é
               legível/versionável e NÃO deve carregar credencial (CLI-SEC-7).
  --project    Escreve no .mcp.json do PROJETO (cwd) em vez do ~/.aluy/mcp.json global.
  --force      Sobrescreve um server de mesmo nome (por padrão duplicado é erro).

Notas:
  - Server stdio é o caso base: o aluy lança <command> [args...] e fala MCP por stdio.
  - O separador POSIX \`--\` antes do <command> é aceito (e PULADO): \`aluy mcp add pw
    -- npx -y X\` ≡ \`aluy mcp add pw npx -y X\`. Após o \`--\`, tudo é do server.
  - SEM registro/API-key externo: só o comando que você passar.
  - As tools do server entram no toolset ATRÁS da catraca (efeito ⇒ confirmação).
  - ⚠ v1 NÃO isola o server em sandbox de SO: roda com OS TEUS
    privilégios. Só plugue servers que você confia. A credencial do Aluy NUNCA é
    repassada ao server.`;

/** Parser PURO do `aluy mcp …` (sem o prefixo `mcp`). Determinístico, sem I/O. */
export function parseMcpCommand(argv: readonly string[]): McpCommand {
  const sub = argv[0];
  if (sub === undefined || sub === 'help' || sub === '-h' || sub === '--help') {
    return { kind: 'help' };
  }

  if (sub === 'list') {
    return { kind: 'list' };
  }

  if (sub === 'remove' || sub === 'rm') {
    const rest = argv.slice(1);
    const { flags, positionals } = splitFlags(rest);
    const name = positionals[0];
    if (name === undefined) {
      return { kind: 'error', message: 'mcp remove: falta o <nome> do server.' };
    }
    if (positionals.length > 1) {
      return { kind: 'error', message: `mcp remove: argumento inesperado "${positionals[1]}".` };
    }
    return { kind: 'remove', name, project: flags.project };
  }

  if (sub === 'add') {
    const rest = argv.slice(1);
    const env: [string, string][] = [];
    const positionals: string[] = [];
    let project = false;
    let force = false;
    // Separador POSIX `--` ANTES do <command> (a forma que o `mcp search` sugere:
    // `aluy mcp add <nome> -- npx …`): o `--` é PULADO (não é o command!) e tudo que
    // segue é literal do server (<command> [args...]) — paramos de interpretar flags
    // do aluy. Sem isto o `--` virava `command:"--"` e o server nunca spawnava.
    let afterSeparator = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (!afterSeparator) {
        if (a === '--' && positionals.length <= 1) {
          afterSeparator = true;
          continue;
        }
        if (a === '--project') {
          project = true;
          continue;
        }
        if (a === '--force') {
          force = true;
          continue;
        }
        if (a === '--env' || a.startsWith('--env=')) {
          const pair = a === '--env' ? rest[++i] : a.slice('--env='.length);
          if (pair === undefined) {
            return { kind: 'error', message: 'mcp add: --env requer K=V.' };
          }
          const parsed = parseEnvPair(pair);
          if (parsed === undefined) {
            return { kind: 'error', message: `mcp add: --env inválido "${pair}" — use K=V.` };
          }
          env.push(parsed);
          continue;
        }
      }
      // O 1º posicional é <nome>, o 2º é <command>; do 3º em diante são args do command.
      // Após o `--`, NADA é flag do aluy (tudo é do server); sem `--`, as flags do aluy
      // (--env/--project/--force) são consumidas por varredura acima, e aqui basta
      // empilhar os posicionais na ordem.
      positionals.push(a);
    }
    const name = positionals[0];
    const command = positionals[1];
    if (name === undefined) {
      return { kind: 'error', message: 'mcp add: falta o <nome> do server.' };
    }
    if (command === undefined) {
      return { kind: 'error', message: `mcp add: falta o <command> do server "${name}".` };
    }
    // Defesa extra: `--` NUNCA é um command válido (é o separador). Mesmo que algum
    // caminho futuro re-introduza o bug, o parse rejeita com erro claro em vez de
    // gravar config quebrada (o writer também rejeita — cinto e suspensório).
    if (command === '--') {
      return {
        kind: 'error',
        message:
          `mcp add: "--" não é um <command> — é o separador. ` +
          `Use: aluy mcp add ${name} -- <command> [args...].`,
      };
    }
    return {
      kind: 'add',
      name,
      command,
      args: positionals.slice(2),
      env,
      project,
      force,
    };
  }

  return { kind: 'error', message: `mcp: subcomando desconhecido "${sub}".` };
}

/** Separa flags conhecidas (`--project`) dos posicionais (p/ list/remove). */
function splitFlags(argv: readonly string[]): {
  flags: { project: boolean };
  positionals: string[];
} {
  const positionals: string[] = [];
  let project = false;
  for (const a of argv) {
    if (a === '--project') project = true;
    else positionals.push(a);
  }
  return { flags: { project }, positionals };
}

/** `K=V` ⇒ `[K, V]`; chave vazia ou sem `=` ⇒ undefined. V pode conter `=`. */
function parseEnvPair(pair: string): [string, string] | undefined {
  const eq = pair.indexOf('=');
  if (eq <= 0) return undefined; // sem `=` ou chave vazia.
  return [pair.slice(0, eq), pair.slice(eq + 1)];
}

export interface McpCommandDeps {
  readonly io?: TerminalIO;
  /** Raiz do `~/.aluy/` (default `<home>/.aluy`). Injetável p/ teste. */
  readonly aluyHome?: string;
  /** Raiz do `~/.codex/` (default `<home>/.codex`). Injetável p/ teste. */
  readonly codexHome?: string;
  /** Raiz do workspace (cwd) p/ `--project`. Default process.cwd(). */
  readonly workspaceRoot?: string;
}

/** Despacha o `aluy mcp …` já-parseado. Retorna o exit-code. */
export async function runMcp(argv: readonly string[], deps: McpCommandDeps = {}): Promise<number> {
  const io = deps.io ?? realTerminalIO();
  const cmd = parseMcpCommand(argv);
  switch (cmd.kind) {
    case 'help':
      io.out(MCP_HELP_TEXT);
      return 0;
    case 'error':
      io.err(`aluy: ${cmd.message}`);
      io.err("rode 'aluy mcp --help' p/ ver o uso.");
      return 2;
    case 'add':
      return runAdd(cmd, deps, io);
    case 'remove':
      return runRemove(cmd, deps, io);
    case 'list':
      return runList(deps, io);
  }
}

function aluyHomeOf(deps: McpCommandDeps): string {
  return deps.aluyHome ?? join(homedir(), '.aluy');
}
function codexHomeOf(deps: McpCommandDeps): string {
  return deps.codexHome ?? join(homedir(), '.codex');
}
function workspaceRootOf(deps: McpCommandDeps): string {
  return deps.workspaceRoot ?? process.cwd();
}

/** Caminho do arquivo gerenciado, conforme `--project`. */
function targetFile(project: boolean, deps: McpCommandDeps): string {
  return project
    ? join(workspaceRootOf(deps), PROJECT_MCP_CONFIG_FILENAME)
    : join(aluyHomeOf(deps), MCP_CONFIG_FILENAME);
}

function runAdd(
  cmd: Extract<McpCommand, { kind: 'add' }>,
  deps: McpCommandDeps,
  io: TerminalIO,
): number {
  // SEGREDO (CLI-SEC-7): avisa (não bloqueia) cada env que pareça segredo literal.
  const env: Record<string, string> = {};
  for (const [k, v] of cmd.env) {
    const inspection = inspectEnvSecret(k, v);
    if (inspection.looksLikeSecret) {
      io.err(
        `aluy: ⚠ --env ${k} parece um SEGREDO literal. O mcp.json é legível e versionável, ` +
          'então não deve guardar credenciais. Prefira uma REFERÊNCIA ' +
          `(--env ${k}=$NOME_DA_VAR), resolvida do teu ambiente no spawn. Gravando assim mesmo.`,
      );
    }
    env[k] = v;
  }

  const server: McpServerConfig = {
    name: cmd.name,
    command: cmd.command,
    args: cmd.args,
    env,
  };
  const file = targetFile(cmd.project, deps);
  const writer = new McpConfigWriter({ file });
  try {
    const { replaced } = writer.add(server, { force: cmd.force });
    const where = cmd.project ? '.mcp.json (projeto)' : '~/.aluy/mcp.json';
    io.out(
      `${replaced ? 'atualizado' : 'adicionado'} "${cmd.name}" em ${where}: ` +
        `${cmd.command}${cmd.args.length ? ' ' + cmd.args.join(' ') : ''}`,
    );
    io.out('o server passa pela catraca no runtime (conectar = confirmação). `aluy mcp list`.');
    return 0;
  } catch (e) {
    io.err(`aluy: ${e instanceof McpWriteError ? e.message : String(e)}`);
    return 1;
  }
}

function runRemove(
  cmd: Extract<McpCommand, { kind: 'remove' }>,
  deps: McpCommandDeps,
  io: TerminalIO,
): number {
  const file = targetFile(cmd.project, deps);
  const writer = new McpConfigWriter({ file });
  try {
    const { removed } = writer.remove(cmd.name);
    if (removed) {
      const where = cmd.project ? '.mcp.json (projeto)' : '~/.aluy/mcp.json';
      io.out(`removido "${cmd.name}" de ${where}.`);
      return 0;
    }
    // Não estava onde o aluy escreve — pode vir do Codex (que o aluy NÃO gerencia).
    io.err(
      `aluy: server "${cmd.name}" não está em ${cmd.project ? '.mcp.json' : '~/.aluy/mcp.json'}.`,
    );
    const codex = new CodexMcpConfigStore({ baseDir: codexHomeOf(deps) }).load();
    if (codex.config.servers.some((s) => s.name === cmd.name)) {
      io.err(
        `aluy: "${cmd.name}" vem do Codex (~/.codex/config.toml) — o aluy NÃO o gerencia; ` +
          'edite o config.toml do Codex à mão.',
      );
    }
    return 1;
  } catch (e) {
    io.err(`aluy: ${e instanceof McpWriteError ? e.message : String(e)}`);
    return 1;
  }
}

function runList(deps: McpCommandDeps, io: TerminalIO): number {
  // Lê de TODAS as fontes que o aluy conhece (a descoberta/handshake é da SESSÃO; aqui,
  // fora de sessão, listamos só a CONFIG — estado = "—"). Precedência: menos → mais
  // específica (Codex < ~/.aluy global < projeto), igual ao setup.ts.
  const codex = new CodexMcpConfigStore({ baseDir: codexHomeOf(deps) }).load();
  const global = new McpConfigStore({ baseDir: aluyHomeOf(deps) }).load();
  // O `.mcp.json` do projeto é lido aqui por leitura direta simples (cwd), só p/ listar.
  const project = readProjectMcp(workspaceRootOf(deps));

  const errors = [codex.error, global.error, project.error].filter((e): e is string => !!e);
  for (const e of errors) io.err(`aluy: MCP — ${e}`);

  const sources: McpSource[] = [
    { origin: 'codex', config: codex.config },
    { origin: 'aluy-global', config: global.config },
    { origin: 'project', config: project.config },
  ];
  const listing = buildMcpListing(sources);

  if (listing.length === 0) {
    io.out('nenhum server MCP configurado. Adicione com: aluy mcp add <nome> <command> [args...]');
    return 0;
  }
  io.out(`servers MCP (${listing.length}):`);
  for (const s of listing) {
    const managed = s.managed ? '' : ' [não-gerenciado]';
    io.out(`  ${s.name}  — ${originLabel(s.origin)}${managed}`);
    io.out(`      ${s.command}${s.args.length ? ' ' + s.args.join(' ') : ''}`);
    if (s.envKeys.length) io.out(`      env: ${s.envKeys.join(', ')}`);
    // EST-0970 — config legada quebrada (`command:"--"`): avisa com a correção pronta
    // em vez de deixar o server falhar silencioso na descoberta.
    const warning = invalidCommandWarning(s);
    if (warning !== undefined) io.err(`aluy: ⚠ ${warning}`);
  }
  io.out('estado/tools por server: use /mcp dentro da sessão (handshake ao vivo).');
  return 0;
}

const MAX_MCP_BYTES = 256 * 1024;

/** Lê `<root>/.mcp.json` direto (fail-safe), só p/ a listagem fora de sessão. */
function readProjectMcp(root: string): { config: McpConfig; error?: string } {
  const file = join(root, PROJECT_MCP_CONFIG_FILENAME);
  let raw: string;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_MCP_BYTES) return { config: EMPTY_MCP_CONFIG };
    raw = readFileSync(file, 'utf8');
  } catch {
    return { config: EMPTY_MCP_CONFIG };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: EMPTY_MCP_CONFIG, error: `${file}: JSON inválido.` };
  }
  try {
    return { config: parseMcpConfig(parsed) };
  } catch (e) {
    return { config: EMPTY_MCP_CONFIG, error: e instanceof McpConfigError ? e.message : String(e) };
  }
}
