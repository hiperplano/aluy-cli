// EST-0970 · ADR-0058 (E-B1) · CLI-SEC-12 — ciclo MCP DENTRO da sessão: os subcomandos
// `/mcp add|remove|disable|enable` (a busca `/mcp search` é o #94; a listagem é o #81).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ E-B1 — O SLASH É ATO DO USUÁRIO, NÃO DO AGENTE.                             ║
// ║  `/mcp add …` é o USUÁRIO digitando o comando na composer — MESMO estatuto   ║
// ║  do `aluy mcp add` shell (gate AG-0010 já passou nesse desenho). Este        ║
// ║  handler roda no CAMINHO DO USUÁRIO (onCommand da TUI), NÃO no toolset do    ║
// ║  agente: slash-command NÃO é tool — o modelo não tem como invocá-lo (nenhuma ║
// ║  NativeTool aponta p/ cá). A catraca segue NEGANDO o agente em `~/.aluy/`    ║
// ║  (`aluy-config-write-deny`, EST-0974) por qualquer canal — intocada.         ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// REUSO (#81): a escrita é o MESMO `McpConfigWriter` do `aluy mcp add/remove` shell —
// atômico (tmp+rename), merge-safe, 0600. O aviso de segredo no `--env` (CLI-SEC-7,
// `inspectEnvSecret`) é preservado. `remove` só tira de onde o aluy ESCREVE
// (`~/.aluy/mcp.json`) e avisa quando o server vem do Codex (não-gerenciado).
//
// DESCOBERTA É NO BOOT: gravar o add/enable NÃO conecta o server nesta sessão — a nota
// orienta a reiniciar (ou usar `/mcp reload` quando existir). `disable` grava
// `disabled:true` e avisa que um server ATIVO só desconecta no próximo boot (opção
// garantida; derrubar um transport vivo fica p/ quando houver caminho limpo).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspectEnvSecret, type McpServerConfig } from '@hiperplano/aluy-cli-core';
import { McpConfigWriter, McpWriteError } from '../mcp/mcp-config-writer.js';
import { MCP_CONFIG_FILENAME } from '../mcp/mcp-config-store.js';
import { CodexMcpConfigStore } from '../mcp/codex-mcp-config.js';
import type { SlashNote } from './handlers.js';

/** Subcomando ADMIN do `/mcp` já-parseado (puro, sem I/O). */
export type McpAdminCommand =
  | {
      readonly kind: 'add';
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: readonly (readonly [string, string])[];
      readonly force: boolean;
    }
  | { readonly kind: 'remove'; readonly name: string }
  | { readonly kind: 'disable'; readonly name: string }
  | { readonly kind: 'enable'; readonly name: string }
  // subcomando reconhecido mas malformado ⇒ nota de USO (sem tocar disco).
  | { readonly kind: 'usage'; readonly note: SlashNote };

const ADD_USAGE: SlashNote = {
  title: 'mcp',
  lines: [
    'uso: /mcp add <nome> [--env K=V]... [--force] -- <command> [args...]',
    'ex.: /mcp add pw -- npx -y @playwright/mcp',
    'use REFERÊNCIA no --env (--env TOKEN=$MEU_TOKEN) — nunca segredo literal.',
  ],
};

function nameUsage(sub: string): SlashNote {
  return { title: 'mcp', lines: [`uso: /mcp ${sub} <nome>`] };
}

/**
 * Parser PURO dos subcomandos ADMIN do `/mcp` na sessão. `null` ⇒ NÃO é admin (o
 * chamador segue p/ `search`/listagem — #94/#81 intactos; arg desconhecido NÃO vira
 * subcomando). Tokenização por espaço (sem quoting de shell — args com espaço não são
 * o caso base de um `command [args...]`).
 */
export function parseMcpAdminSlash(args: string): McpAdminCommand | null {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const sub = tokens[0]?.toLowerCase();
  if (sub === undefined) return null;

  if (sub === 'remove' || sub === 'rm' || sub === 'disable' || sub === 'enable') {
    const kind = sub === 'rm' ? 'remove' : sub;
    const name = tokens[1];
    if (name === undefined || tokens.length > 2) return { kind: 'usage', note: nameUsage(kind) };
    return { kind, name };
  }

  if (sub !== 'add') return null; // search/listagem/desconhecido — fora do admin.

  // `/mcp add <nome> [--env K=V]... [--force] -- <command> [args...]`
  // Flags do aluy só ANTES do `--`; depois dele, TUDO é o comando do server (inclusive
  // `--flags` do próprio server). Sem `--`, paridade com o shell: 2º posicional é o
  // <command> e o resto são args (flags do aluy ainda são varridas).
  const rest = tokens.slice(1);
  const env: [string, string][] = [];
  const positionals: string[] = [];
  let force = false;
  let afterDashDash: string[] | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--') {
      afterDashDash = rest.slice(i + 1);
      break;
    }
    if (a === '--force') {
      force = true;
      continue;
    }
    if (a === '--env' || a.startsWith('--env=')) {
      const pair = a === '--env' ? rest[++i] : a.slice('--env='.length);
      const parsed = pair === undefined ? undefined : parseEnvPair(pair);
      if (parsed === undefined) return { kind: 'usage', note: ADD_USAGE };
      env.push(parsed);
      continue;
    }
    positionals.push(a);
  }

  const name = positionals[0];
  if (name === undefined) return { kind: 'usage', note: ADD_USAGE };
  // com `--`: o comando é tudo após ele; sem `--`: posicionais 2+ (paridade c/ o shell).
  const commandTokens = afterDashDash ?? positionals.slice(1);
  const command = commandTokens[0];
  if (command === undefined || command.trim().length === 0) {
    return { kind: 'usage', note: ADD_USAGE };
  }
  return { kind: 'add', name, command, args: commandTokens.slice(1), env, force };
}

/** `K=V` ⇒ `[K, V]`; chave vazia ou sem `=` ⇒ undefined. V pode conter `=`. */
function parseEnvPair(pair: string): [string, string] | undefined {
  const eq = pair.indexOf('=');
  if (eq <= 0) return undefined;
  return [pair.slice(0, eq), pair.slice(eq + 1)];
}

export interface McpAdminDeps {
  /** Raiz do `~/.aluy/` (default `<home>/.aluy`). Injetável p/ teste (tmpdir). */
  readonly aluyHome?: string;
  /** Raiz do `~/.codex/` (default `<home>/.codex`). Injetável p/ teste. */
  readonly codexHome?: string;
}

const RESTART_HINT =
  'reinicie a sessão (ou use /mcp reload quando existir) p/ carregar as tools — a descoberta é no boot.';

/**
 * Executa um subcomando ADMIN do `/mcp` (já-parseado) e devolve a nota a empurrar na
 * conversa. SÍNCRONO (só fs local, atrás do writer #81). NUNCA lança: erro de escrita/
 * validação vira nota honesta (a sessão segue viva). NÃO conecta/derruba server nesta
 * sessão — a config muda; a descoberta acontece no próximo boot (a nota orienta).
 */
export function runMcpAdminSlash(cmd: McpAdminCommand, deps: McpAdminDeps = {}): SlashNote {
  if (cmd.kind === 'usage') return cmd.note;
  const aluyHome = deps.aluyHome ?? join(homedir(), '.aluy');
  const writer = new McpConfigWriter({ file: join(aluyHome, MCP_CONFIG_FILENAME) });
  try {
    switch (cmd.kind) {
      case 'add':
        return runAdd(cmd, writer);
      case 'remove':
        return runRemove(cmd.name, writer, deps);
      case 'disable':
        return runSetDisabled(cmd.name, true, writer, deps);
      case 'enable':
        return runSetDisabled(cmd.name, false, writer, deps);
    }
  } catch (e) {
    const msg = e instanceof McpWriteError ? e.message : String(e);
    return { title: 'mcp', lines: [`⚠ ${msg}`] };
  }
}

function runAdd(
  cmd: Extract<McpAdminCommand, { kind: 'add' }>,
  writer: McpConfigWriter,
): SlashNote {
  const lines: string[] = [];
  // SEGREDO (CLI-SEC-7): aviso preservado do `aluy mcp add` — avisa (não bloqueia)
  // cada `--env` cujo VALOR pareça segredo literal; recomenda referência `$VAR`.
  const env: Record<string, string> = {};
  for (const [k, v] of cmd.env) {
    if (inspectEnvSecret(k, v).looksLikeSecret) {
      lines.push(
        `⚠ --env ${k} parece um SEGREDO literal — o mcp.json é legível e NÃO deve carregar ` +
          `credencial. Prefira referência (--env ${k}=$NOME_DA_VAR). Gravando assim mesmo.`,
      );
    }
    env[k] = v;
  }
  const server: McpServerConfig = { name: cmd.name, command: cmd.command, args: cmd.args, env };
  const { replaced } = writer.add(server, { force: cmd.force });
  lines.push(
    `${replaced ? 'atualizado' : 'adicionado'} "${cmd.name}" em ~/.aluy/mcp.json: ` +
      `${cmd.command}${cmd.args.length ? ' ' + cmd.args.join(' ') : ''}`,
  );
  lines.push(RESTART_HINT);
  lines.push('o server passa pela catraca no runtime (conectar = confirmação).');
  return { title: 'mcp', lines };
}

function runRemove(name: string, writer: McpConfigWriter, deps: McpAdminDeps): SlashNote {
  const { removed } = writer.remove(name);
  if (removed) {
    return {
      title: 'mcp',
      lines: [`removido "${name}" de ~/.aluy/mcp.json.`, RESTART_HINT],
    };
  }
  return { title: 'mcp', lines: notFoundLines(name, deps) };
}

function runSetDisabled(
  name: string,
  disabled: boolean,
  writer: McpConfigWriter,
  deps: McpAdminDeps,
): SlashNote {
  const { found } = writer.setDisabled(name, disabled);
  if (!found) return { title: 'mcp', lines: notFoundLines(name, deps) };
  if (disabled) {
    return {
      title: 'mcp',
      lines: [
        `desativado "${name}" (disabled: true em ~/.aluy/mcp.json) — instalado, mas a`,
        'descoberta o PULA. se está conectado nesta sessão, desconecta no próximo boot.',
        'reative com /mcp enable ' + name + '.',
      ],
    };
  }
  return {
    title: 'mcp',
    lines: [`reativado "${name}" em ~/.aluy/mcp.json.`, RESTART_HINT],
  };
}

/** Server fora do alcance do writer: não está onde o aluy ESCREVE; pode vir do Codex. */
function notFoundLines(name: string, deps: McpAdminDeps): string[] {
  const lines = [`server "${name}" não está em ~/.aluy/mcp.json (onde o aluy escreve).`];
  const codexHome = deps.codexHome ?? join(homedir(), '.codex');
  try {
    const codex = new CodexMcpConfigStore({ baseDir: codexHome }).load();
    if (codex.config.servers.some((s) => s.name === name)) {
      lines.push(
        `"${name}" vem do Codex (~/.codex/config.toml) — o aluy NÃO o gerencia; edite o config.toml à mão.`,
      );
    }
  } catch {
    // checagem do Codex é best-effort (só p/ a dica) — falha não muda o resultado.
  }
  return lines;
}
