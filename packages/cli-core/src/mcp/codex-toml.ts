// EST-0979 (FU-S3-CODEX-TOML) · ADR-0058 (E-B1) · CLI-SEC-12 — PARSER TOML CONFINADO
// do `~/.codex/config.toml`, restrito ao SUBCONJUNTO `[mcp_servers]`.
//
// PORQUÊ UM PARSER PRÓPRIO (não uma lib): o monorepo é repo PÚBLICO com trava de
// supply-chain forte (CLI-SEC-7/H4 — "binário público limpo", toda dep nova passa
// por provenance-gate). O subconjunto que o Codex usa em `[mcp_servers]` é PEQUENO e
// bem-definido — tabelas `[mcp_servers.<nome>]` com `command` (string), `args`
// (array de string) e `env` (tabela inline de string). Um parser mínimo CONFINADO a
// esse subconjunto evita adicionar uma dependência (sem install-scripts, sem
// superfície transitiva, zero código de terceiro que EXECUTA algo). O parser só LÊ
// texto e produz dado — NUNCA executa nada do arquivo.
//
// CONFINADO (igual aos outros leitores de config):
//   • Subconjunto FECHADO: só reconhece `[mcp_servers.<nome>]`, `command`, `args`,
//     `env`. Tudo o mais é IGNORADO (não é erro — o `config.toml` do Codex tem MUITA
//     outra coisa que não nos interessa). Sintaxe TOML reconhecida só onde precisamos.
//   • FAIL-SAFE: qualquer ambiguidade/erro de sintaxe DENTRO de uma seção `mcp_servers`
//     ⇒ ERRO legível (config vazia no caller, UX avisa) — NUNCA lança, nunca confia.
//   • SEM I/O / SEM `node:*`: recebe a STRING já lida (o teto de tamanho é do caller,
//     locus concreto). PORTÁVEL (vive no core).
//
// SEGURANÇA (E-B1): o `config.toml` é DADO de config do dono (confiável como o
// `mcp.json`), mas os servers que ele declara entram pela MESMA catraca MCP (E-B2:
// conectar = `ask`; credencial do CLI NUNCA no environ do server; saída = dado;
// write-deny do config). Este parser NÃO afrouxa nada — só adiciona a FONTE.

import {
  EMPTY_MCP_CONFIG,
  McpConfigError,
  isValidServerName,
  parseMcpConfig,
  type McpConfig,
} from './config.js';

/** Cabeçalho da config do Codex onde moram os servers MCP (tabela-pai). */
const MCP_SERVERS_TABLE = 'mcp_servers';

/**
 * Estado mutável de UM server enquanto parseamos suas chaves (`command`/`args`/`env`).
 * Vira `McpServerConfig` (re-validado por `parseMcpConfig` no caller via objeto).
 */
interface ServerDraft {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Parseia o SUBCONJUNTO `[mcp_servers]` de um `~/.codex/config.toml` JÁ LIDO (string).
 * Produz o MESMO `McpConfig` que o `~/.aluy/mcp.json` / `.mcp.json` produzem, p/ entrar
 * na MESMA cadeia de merge e na MESMA catraca MCP.
 *
 * DEFENSIVO: o arquivo é DADO do dono (confiável como `mcp.json`), mas pode estar
 * malformado — rejeita o que não casa o subconjunto com `McpConfigError` legível.
 * Linhas/seções FORA de `mcp_servers` são IGNORADAS (o `config.toml` do Codex é cheio
 * de outras chaves). NUNCA executa nada do arquivo (TOML é dado, não código).
 *
 * Formato reconhecido (Codex):
 *   [mcp_servers.everything]
 *   command = "npx"
 *   args = ["-y", "@modelcontextprotocol/server-everything"]
 *   env = { "API_KEY" = "x" }    # tabela inline; ou env.KEY = "v" em linhas próprias
 *
 * @throws McpConfigError se o subconjunto `mcp_servers` for inválido.
 */
export function parseCodexMcpConfig(raw: string): McpConfig {
  const drafts = new Map<string, ServerDraft>();
  // A seção "ativa": chaves soltas pertencem a ela. `kind` distingue o corpo do server
  // (`command`/`args`/`env=...`) do sub-bloco `[mcp_servers.<nome>.env]` (cada chave =
  // var de ambiente). `undefined` ⇒ estamos numa tabela FORA de mcp_servers (ignorada).
  let current: { kind: 'server' | 'env'; name: string; draft: ServerDraft } | undefined;

  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i] ?? '').trim();
    if (line.length === 0) continue;

    // CABEÇALHO DE TABELA: `[...]`. Decide se abrimos um server, ignoramos a tabela,
    // ou (sub-tabela `[mcp_servers.<nome>.env]`) anexamos env ao server corrente.
    if (line.startsWith('[')) {
      const path = parseTableHeader(line, i + 1);
      if (path.length >= 2 && path[0] === MCP_SERVERS_TABLE) {
        const name = path[1]!;
        if (!isValidServerName(name)) {
          throw new McpConfigError(
            `config.toml: nome de server inválido "${name}" em [mcp_servers] — use só [A-Za-z0-9_-].`,
          );
        }
        const draft = drafts.get(name) ?? {};
        drafts.set(name, draft);
        if (path.length === 2) {
          // [mcp_servers.<nome>] — abre o corpo do server p/ as próximas chaves soltas.
          current = { kind: 'server', name, draft };
        } else if (path.length === 3 && path[2] === 'env') {
          // [mcp_servers.<nome>.env] — chaves soltas seguintes são env do server.
          draft.env ??= {};
          current = { kind: 'env', name, draft };
        } else {
          throw new McpConfigError(
            `config.toml: sub-tabela não suportada em [${path.join('.')}] (só command/args/env).`,
          );
        }
      } else {
        // Tabela FORA de mcp_servers (ex.: [model], [profiles.x]) — ignorada por inteiro.
        current = undefined;
      }
      continue;
    }

    // Fora de qualquer seção mcp_servers ⇒ ignora chaves soltas (top-level do Codex).
    if (current === undefined) continue;

    // CHAVE = VALOR dentro de um server (ou de seu sub-bloco env).
    const eq = splitKeyValue(line, i + 1);
    if (current.kind === 'env') {
      // Sob [mcp_servers.<nome>.env] — toda chave é uma var de ambiente (string).
      current.draft.env ??= {};
      current.draft.env[eq.key] = expectString(eq.key, eq.value, i + 1);
      continue;
    }
    applyServerKey(current.name, current.draft, eq.key, eq.value, i + 1);
  }

  if (drafts.size === 0) return EMPTY_MCP_CONFIG;

  // Materializa cada draft no formato `mcpServers` e REUSA `parseMcpConfig` (mesma
  // validação/normalização do mcp.json: command não-vazio, args/env tipados, nome
  // válido) — NÃO duplicamos as regras de formato nem a normalização de defaults.
  const mcpServers: Record<string, unknown> = {};
  for (const [name, d] of drafts) {
    mcpServers[name] = {
      ...(d.command !== undefined ? { command: d.command } : {}),
      ...(d.args ? { args: d.args } : {}),
      ...(d.env ? { env: d.env } : {}),
    };
  }
  return parseMcpConfig({ mcpServers });
}

/** Aplica `command`/`args`/`env = { ... }` (tabela inline) a um server. */
function applyServerKey(
  serverName: string,
  draft: ServerDraft,
  key: string,
  value: string,
  lineNo: number,
): void {
  // `env.<X> = "v"` (chave pontilhada) — uma única var de ambiente do server.
  if (key.startsWith('env.')) {
    const envKey = key.slice('env.'.length);
    draft.env = {
      ...(draft.env ?? {}),
      [envKey]: expectString(`${serverName}.${key}`, value, lineNo),
    };
    return;
  }
  switch (key) {
    case 'command':
      draft.command = expectString(`${serverName}.command`, value, lineNo);
      return;
    case 'args':
      draft.args = parseStringArray(`${serverName}.args`, value, lineNo);
      return;
    case 'env':
      draft.env = { ...(draft.env ?? {}), ...parseInlineTable(`${serverName}.env`, value, lineNo) };
      return;
    default:
      // Chave desconhecida DENTRO de um server (ex.: `startup_timeout_ms`): IGNORA.
      // O Codex pode adicionar chaves que não modelamos; não é erro, só não usamos.
      return;
  }
}

/** Remove um comentário `#` fora de string. Simples mas suficiente p/ o subconjunto. */
function stripComment(line: string): string {
  let inStr = false;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inStr) {
      if (c === quote && line[i - 1] !== '\\') inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Parseia `[a.b.c]` num array de segmentos `["a","b","c"]`. Segmentos podem ser
 * bare-keys (`a`) ou quoted (`"a b"`). Rejeita cabeçalho malformado.
 */
function parseTableHeader(line: string, lineNo: number): string[] {
  if (!line.startsWith('[') || !line.endsWith(']') || line.startsWith('[[')) {
    throw new McpConfigError(`config.toml:${lineNo}: cabeçalho de tabela inválido — "${line}".`);
  }
  const inner = line.slice(1, -1).trim();
  if (inner.length === 0) {
    throw new McpConfigError(`config.toml:${lineNo}: cabeçalho de tabela vazio.`);
  }
  return splitDottedKey(inner, lineNo);
}

/** Divide uma chave pontilhada `a.b."c.d"` respeitando aspas. */
function splitDottedKey(s: string, lineNo: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= s.length) break;
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i]!;
      const end = s.indexOf(quote, i + 1);
      if (end === -1)
        throw new McpConfigError(`config.toml:${lineNo}: aspas não fechadas na chave.`);
      out.push(s.slice(i + 1, end));
      i = end + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] !== '.' && s[j] !== ' ' && s[j] !== '\t') j++;
      const seg = s.slice(i, j);
      if (seg.length === 0)
        throw new McpConfigError(`config.toml:${lineNo}: segmento de chave vazio.`);
      out.push(seg);
      i = j;
    }
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i < s.length) {
      if (s[i] !== '.')
        throw new McpConfigError(`config.toml:${lineNo}: chave malformada — "${s}".`);
      i++; // pula o ponto.
    }
  }
  return out;
}

/** Divide `key = value` numa linha (a `key` é bare/quoted; `value` é o resto cru). */
function splitKeyValue(line: string, lineNo: number): { key: string; value: string } {
  const eq = findTopLevelEquals(line);
  if (eq === -1)
    throw new McpConfigError(`config.toml:${lineNo}: esperava "chave = valor" — "${line}".`);
  const rawKey = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();
  const keySegs = splitDottedKey(rawKey, lineNo);
  if (keySegs.length !== 1) {
    // `env.FOO = "x"` (chave pontilhada num server): tratamos FOO como env quando o
    // prefixo é `env`; senão é fora do subconjunto.
    if (keySegs.length === 2 && keySegs[0] === 'env') {
      return { key: `env.${keySegs[1]}`, value };
    }
    throw new McpConfigError(
      `config.toml:${lineNo}: chave pontilhada não suportada — "${rawKey}".`,
    );
  }
  return { key: keySegs[0]!, value };
}

/** Acha o `=` de topo (fora de string/colchete/chave). */
function findTopLevelEquals(line: string): number {
  let inStr = false;
  let quote = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inStr) {
      if (c === quote && line[i - 1] !== '\\') inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
    } else if (c === '=' && depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Valida + desempacota uma string TOML básica (`"..."` ou `'...'`). */
function expectString(what: string, value: string, lineNo: number): string {
  const s = parseTomlString(value, lineNo);
  if (s === undefined) {
    throw new McpConfigError(`config.toml:${lineNo}: ${what} deve ser uma string entre aspas.`);
  }
  return s;
}

/** Desempacota uma string TOML; retorna undefined se `value` não é uma string. */
function parseTomlString(value: string, lineNo: number): string | undefined {
  const v = value.trim();
  if (v.length < 2) return undefined;
  const q = v[0];
  if (q !== '"' && q !== "'") return undefined;
  if (v[v.length - 1] !== q) {
    throw new McpConfigError(`config.toml:${lineNo}: string não fechada — ${value}.`);
  }
  const body = v.slice(1, -1);
  if (q === "'") return body; // literal string: sem escapes.
  // basic string: trata os escapes comuns; rejeita escape desconhecido (defensivo).
  return body.replace(/\\(.)/g, (_m, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        throw new McpConfigError(`config.toml:${lineNo}: escape não suportado "\\${ch}".`);
    }
  });
}

/** Parseia um array TOML de strings `["a", "b"]` numa única linha. */
function parseStringArray(what: string, value: string, lineNo: number): string[] {
  const v = value.trim();
  if (!v.startsWith('[') || !v.endsWith(']')) {
    throw new McpConfigError(
      `config.toml:${lineNo}: ${what} deve ser um array de strings em uma linha.`,
    );
  }
  const inner = v.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const out: string[] = [];
  for (const part of splitTopLevel(inner, ',')) {
    const item = part.trim();
    if (item.length === 0) continue; // vírgula final.
    const s = parseTomlString(item, lineNo);
    if (s === undefined) {
      throw new McpConfigError(`config.toml:${lineNo}: ${what} — todo item deve ser string.`);
    }
    out.push(s);
  }
  return out;
}

/** Parseia uma tabela inline `{ K = "v", "L" = "w" }` em `Record<string,string>`. */
function parseInlineTable(what: string, value: string, lineNo: number): Record<string, string> {
  const v = value.trim();
  if (!v.startsWith('{') || !v.endsWith('}')) {
    throw new McpConfigError(
      `config.toml:${lineNo}: ${what} deve ser uma tabela inline { K = "v" }.`,
    );
  }
  const inner = v.slice(1, -1).trim();
  const out: Record<string, string> = {};
  if (inner.length === 0) return out;
  for (const part of splitTopLevel(inner, ',')) {
    const item = part.trim();
    if (item.length === 0) continue;
    const eq = findTopLevelEquals(item);
    if (eq === -1) throw new McpConfigError(`config.toml:${lineNo}: ${what} — esperava K = "v".`);
    const keySegs = splitDottedKey(item.slice(0, eq).trim(), lineNo);
    if (keySegs.length !== 1) {
      throw new McpConfigError(`config.toml:${lineNo}: ${what} — chave inválida.`);
    }
    const s = parseTomlString(item.slice(eq + 1).trim(), lineNo);
    if (s === undefined) {
      throw new McpConfigError(`config.toml:${lineNo}: ${what}["${keySegs[0]}"] deve ser string.`);
    }
    out[keySegs[0]!] = s;
  }
  return out;
}

/** Divide por um separador no NÍVEL DE TOPO (respeita string/colchete/chave aninhada). */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let quote = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === quote && s[i - 1] !== '\\') inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
    } else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}
