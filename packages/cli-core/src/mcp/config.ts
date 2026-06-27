// EST-0970 · ADR-0058 (E-B1) · CLI-SEC-12 — o FORMATO do `~/.aluy/mcp.json`.
//
// A config de MCP é DADO do usuário (ADR-0053 §2.2), nunca código nem segredo
// literal versionável: declara QUAIS servers locais (stdio) o usuário pluga, e
// COMO lançá-los (command/args/env). Este arquivo define o formato + um parser
// PORTÁVEL (sem I/O): quem LÊ o arquivo do disco (confinado a `~/.aluy/`) é o
// `@hiperplano/aluy-cli` (locus concreto); aqui só validamos o objeto JÁ carregado.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ E-B1 (gate FORTE do `seguranca`) — `~/.aluy/mcp.json` É CONFIG DO USUÁRIO. ║
// ║ Escrevê-lo é ato do USUÁRIO, nunca do agente: a escrita do agente em        ║
// ║ `~/.aluy/` já é DENY pela categoria `always-ask:aluy-config-write-deny`     ║
// ║ (EST-0974), acima até do `--unsafe`. Esta camada NÃO reabre esse caminho —  ║
// ║ só LÊ a config que o usuário escreveu à mão.                                ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// SEGREDO (CLI-SEC-7 / E-B1): o `env` de um server é RESOLVIDO por-server, escopo
// mínimo. O `mcp.json` NÃO deve carregar segredo literal — referencia, no máximo,
// nomes de variável que o locus resolve do ambiente do usuário. A credencial
// HEADLESS do CLI (CLI-SEC-1/7) JAMAIS entra no `environ` de um server (isso é
// garantido no spawn concreto, @hiperplano/aluy-cli — ver `stdio-transport.ts`).
//
// PORTÁVEL: só validação de objeto/string (sem `node:*`, sem `fs`).

/**
 * Declaração de UM server MCP local (transporte stdio). O Aluy CLI v1 só fala com
 * servers LOCAIS via stdio (ADR-0058): lança o processo (`command` + `args`),
 * fala MCP pelo stdin/stdout, e as tools dele entram no toolset do agente ATRÁS da
 * catraca. Servers REMOTOS (HTTP/SSE) são FU (não-v1) — egress remoto exigiria a
 * malha CLI-SEC-5 por-request, fora do escopo desta estória.
 */
export interface McpServerConfig {
  /** Nome lógico do server (chave no `mcp.json`). Prefixo das tools: `mcp__<nome>__`. */
  readonly name: string;
  /** Executável a lançar (ex.: "npx", "node", "python", caminho absoluto). */
  readonly command: string;
  /** Argumentos do executável (ex.: ["-y", "@some/mcp-server"]). */
  readonly args: readonly string[];
  /**
   * Variáveis de ambiente do PROCESSO-server (escopo mínimo, por-server). DADO de
   * config. ⚠ CLI-SEC-7: a credencial headless do CLI (`ALUY_TOKEN`/refresh) NUNCA
   * é injetada aqui — o spawn concreto parte de um environ MÍNIMO e adiciona SÓ
   * estas chaves explícitas (ver `stdio-transport.ts`). Default: nenhuma.
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * EST-0970 (ciclo MCP na sessão) — server DESATIVADO sem desinstalar: a descoberta
   * o PULA (não lança o processo, não conecta, nenhuma tool entra no toolset). É um
   * interruptor de DADO (config do usuário; `/mcp disable|enable` ou edição à mão).
   * TOLERANTE: ausente ⇒ ativo (todo `mcp.json` pré-existente segue idêntico).
   */
  readonly disabled?: boolean;
}

/** A config inteira: o conjunto de servers MCP declarados. */
export interface McpConfig {
  readonly servers: readonly McpServerConfig[];
}

/** Config vazia: nenhum server (default seguro — sem `mcp.json`, sem MCP). */
export const EMPTY_MCP_CONFIG: McpConfig = { servers: [] };

/**
 * EST-0979 — MERGE de fontes de config MCP, da MENOS p/ a MAIS específica (a última
 * VENCE em colisão de nome). Espelha a precedência das instruções/comandos: o
 * **projeto especializa o global**. O caso de uso é unir o `~/.aluy/mcp.json` (global,
 * nativo Aluy) ao `.mcp.json` (projeto, padrão Claude Code) — passe-os nessa ordem
 * (`[global, project]`) p/ que um server homônimo no projeto sobreponha o global.
 *
 * PURO: só compõe `McpConfig` já-parseados/validados; não relaxa NADA — a catraca
 * (E-B2: efeito por padrão ⇒ `ask` p/ conectar) age igual sobre todo server, venha de
 * onde vier. A ordem dos servers no resultado é determinística: ordem de 1ª aparição,
 * com a DECLARAÇÃO vencedora (a da fonte mais específica) no lugar.
 */
export function mergeMcpConfigs(...configs: readonly McpConfig[]): McpConfig {
  const byName = new Map<string, McpServerConfig>();
  for (const cfg of configs) {
    for (const server of cfg.servers) {
      // `set` numa Map preserva a posição da 1ª inserção mas troca o VALOR — assim a
      // fonte mais específica (mais à direita) vence sem reordenar arbitrariamente.
      byName.set(server.name, server);
    }
  }
  return { servers: [...byName.values()] };
}

/** Erro de parse do `mcp.json` (formato inválido) — não lança no caminho feliz. */
export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Valida + normaliza o objeto JÁ-parseado de um `mcp.json` num `McpConfig`.
 * DEFENSIVO (o arquivo é DADO do usuário, pode estar malformado): rejeita o que
 * não casa o formato com `McpConfigError` legível, NUNCA confia cegamente.
 *
 * Formato aceito (`mcpServers` p/ paridade com o ecossistema MCP / Claude Desktop):
 *   {
 *     "mcpServers": {
 *       "<nome>": { "command": "npx", "args": ["-y", "@x/y"], "env": { "K": "v" } }
 *     }
 *   }
 *
 * @throws McpConfigError se o formato for inválido.
 */
export function parseMcpConfig(raw: unknown): McpConfig {
  if (raw === undefined || raw === null) return EMPTY_MCP_CONFIG;
  if (!isRecord(raw)) {
    throw new McpConfigError('mcp.json: raiz deve ser um objeto.');
  }
  const serversObj = raw['mcpServers'];
  // ausente/vazio ⇒ config vazia (sem MCP), não é erro.
  if (serversObj === undefined || serversObj === null) return EMPTY_MCP_CONFIG;
  if (!isRecord(serversObj)) {
    throw new McpConfigError('mcp.json: "mcpServers" deve ser um objeto { nome: server }.');
  }

  const servers: McpServerConfig[] = [];
  for (const [name, decl] of Object.entries(serversObj)) {
    if (!isValidServerName(name)) {
      throw new McpConfigError(
        `mcp.json: nome de server inválido "${name}" — use só [A-Za-z0-9_-] (vira prefixo de tool).`,
      );
    }
    if (!isRecord(decl)) {
      throw new McpConfigError(`mcp.json: server "${name}" deve ser um objeto.`);
    }
    const command = decl['command'];
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new McpConfigError(`mcp.json: server "${name}" requer "command" (string não-vazia).`);
    }
    const args = parseArgs(name, decl['args']);
    const env = parseEnv(name, decl['env']);
    const disabled = parseDisabled(name, decl['disabled']);
    servers.push({ name, command, args, env, ...(disabled ? { disabled: true } : {}) });
  }
  return { servers };
}

/**
 * Nomes de server viram PREFIXO de tool (`mcp__<nome>__<tool>`). Restringimos a
 * `[A-Za-z0-9_-]` (não-vazio) p/ o prefixo ser inequívoco e p/ um nome não
 * carregar `__` (o separador) nem caracteres que confundam o parsing do prefixo.
 */
export function isValidServerName(name: string): boolean {
  // Só [A-Za-z0-9_-], não-vazio, e sem `__` (que é o separador do prefixo de tool).
  return /^[A-Za-z0-9_-]+$/.test(name) && !name.includes('__');
}

function parseArgs(name: string, raw: unknown): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new McpConfigError(`mcp.json: server "${name}" — "args" deve ser um array de strings.`);
  }
  const out: string[] = [];
  for (const a of raw) {
    if (typeof a !== 'string') {
      throw new McpConfigError(`mcp.json: server "${name}" — todo item de "args" deve ser string.`);
    }
    out.push(a);
  }
  return out;
}

/**
 * EST-0970 — `disabled` TOLERANTE: ausente/null ⇒ ativo (compat com todo `mcp.json`
 * pré-existente). Presente, só aceita boolean (formato defensivo, como o resto).
 */
function parseDisabled(name: string, raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') {
    throw new McpConfigError(`mcp.json: server "${name}" — "disabled" deve ser boolean.`);
  }
  return raw;
}

function parseEnv(name: string, raw: unknown): Readonly<Record<string, string>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    throw new McpConfigError(`mcp.json: server "${name}" — "env" deve ser um objeto { K: "v" }.`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') {
      throw new McpConfigError(
        `mcp.json: server "${name}" — env["${k}"] deve ser string (sem segredo literal recomendado).`,
      );
    }
    out[k] = v;
  }
  return out;
}
