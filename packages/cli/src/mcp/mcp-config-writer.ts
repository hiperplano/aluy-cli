// EST-0970 · ADR-0058 (E-B1) · CLI-SEC-12 — ESCRITOR de config MCP (`~/.aluy/mcp.json`
// GLOBAL ou `.mcp.json` do PROJETO). A camada de CONVENIÊNCIA por trás de `aluy mcp add`/
// `aluy mcp remove`: escreve a config sem o usuário editar o JSON à mão.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ E-B1 — ESCREVER A CONFIG É ATO DO USUÁRIO, NÃO DO AGENTE.                   ║
// ║  Este escritor roda no comando `aluy mcp …` que o USUÁRIO digita — é o      ║
// ║  EQUIVALENTE a ele editar `mcp.json` à mão (não amplia NADA). NÃO está no    ║
// ║  caminho do agente: a catraca segue NEGANDO (deny, não ask) que o agente    ║
// ║  escreva `~/.aluy/` por qualquer tool (`aluy-config-write-deny`, EST-0974),  ║
// ║  acima até do `--unsafe`. O server adicionado AINDA passa pela catraca no    ║
// ║  runtime (descoberta = `ask` p/ conectar; cada tool = efeito). Esta camada   ║
// ║  só TROCA a edição manual por um comando — o modelo de ameaça é o mesmo.     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// MERGE, NÃO SOBRESCREVE: lê o arquivo atual, insere/atualiza SÓ o server nomeado,
// preserva todo o resto (e qualquer chave extra do objeto-raiz que não conhecemos —
// futuro-compat). Escrita ATÔMICA (tmp + rename) p/ não corromper a config se cair no meio.
//
// SEGREDO (CLI-SEC-7): este escritor NÃO inspeciona/avisa sobre segredo — isso é do
// comando (`runMcpAdd`), que usa `inspectEnvSecret` ANTES de gravar. Aqui só persistimos o
// `McpServerConfig` já-montado. O `env` é gravado COMO VEIO (o usuário é responsável; o
// caminho recomendado é referência `$VAR`, não literal).

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EMPTY_MCP_CONFIG,
  McpConfigError,
  isValidServerName,
  parseMcpConfig,
  type McpConfig,
  type McpServerConfig,
} from '@aluy/cli-core';

/** Teto defensivo de tamanho do arquivo lido p/ merge (anti-arquivo-gigante adulterado). */
const MAX_MCP_BYTES = 256 * 1024;

/** Erro de escrita/validação no nível do comando (mensagem legível p/ a UX). */
export class McpWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpWriteError';
  }
}

export interface McpConfigWriterOptions {
  /**
   * Caminho ABSOLUTO do arquivo de config a escrever:
   *  - global: `<home>/.aluy/mcp.json`
   *  - projeto: `<workspaceRoot>/.mcp.json`
   * O caminho é montado pelo locus (comando), nunca vem de input do modelo.
   */
  readonly file: string;
}

/**
 * Escritor MERGE-SAFE de um arquivo de config MCP (`mcpServers`). Lê o arquivo atual
 * (ausente ⇒ vazio), aplica a operação (add/remove) preservando os demais servers, e
 * grava ATOMICAMENTE. NÃO é caminho do agente (a catraca nega o agente em `~/.aluy/`):
 * roda no comando `aluy mcp …` digitado pelo usuário.
 */
export class McpConfigWriter {
  private readonly file: string;

  constructor(opts: McpConfigWriterOptions) {
    this.file = opts.file;
  }

  /** O caminho do arquivo gerenciado (p/ mensagens/teste). */
  get configPath(): string {
    return this.file;
  }

  /**
   * Lê + parseia a config atual. Ausente ⇒ vazia (caso comum: 1ª escrita). Presente mas
   * inválida (JSON/formato) ⇒ LANÇA `McpWriteError` — não sobrescrevemos cegamente uma
   * config que não entendemos (poderíamos destruir servers do usuário). O usuário conserta
   * à mão ou usa `--force`-equivalente fora deste escopo.
   */
  load(): McpConfig {
    let raw: string;
    try {
      const st = statSync(this.file);
      if (!st.isFile()) {
        throw new McpWriteError(`${this.file}: não é um arquivo regular.`);
      }
      if (st.size > MAX_MCP_BYTES) {
        throw new McpWriteError(`${this.file}: grande demais p/ editar com segurança.`);
      }
      raw = readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e instanceof McpWriteError) throw e;
      return EMPTY_MCP_CONFIG; // ausente/ilegível ⇒ começa do zero (1ª escrita).
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new McpWriteError(
        `${this.file}: JSON inválido — conserte à mão antes de usar 'aluy mcp'.`,
      );
    }
    try {
      return parseMcpConfig(parsed);
    } catch (e) {
      const msg = e instanceof McpConfigError ? e.message : String(e);
      throw new McpWriteError(msg);
    }
  }

  /**
   * Adiciona (ou SUBSTITUI, se `force`) o server `server`. MERGE: preserva todos os outros
   * servers. Nome duplicado SEM `force` ⇒ `McpWriteError` (não sobrescreve por acidente).
   * Retorna `replaced=true` quando `force` sobrescreveu um homônimo existente.
   */
  add(server: McpServerConfig, opts: { force?: boolean } = {}): { replaced: boolean } {
    if (!isValidServerName(server.name)) {
      throw new McpWriteError(
        `nome de server inválido "${server.name}" — use só [A-Za-z0-9_-] (vira prefixo de tool).`,
      );
    }
    if (server.command.trim().length === 0) {
      throw new McpWriteError(`server "${server.name}": "command" não pode ser vazio.`);
    }
    // EST-0970 — defesa: `--` é o SEPARADOR do `aluy mcp add <nome> -- <command>`,
    // nunca um command real. Gravá-lo produziria config quebrada (o server nunca
    // spawna). Qualquer caminho de escrita (CLI ou /mcp add da sessão) bate aqui.
    if (server.command.trim() === '--') {
      throw new McpWriteError(
        `server "${server.name}": "--" não é um command (é o separador do 'aluy mcp add'). ` +
          `Use: aluy mcp add ${server.name} -- <command> [args...].`,
      );
    }
    const current = this.load();
    const existing = current.servers.find((s) => s.name === server.name);
    if (existing && !opts.force) {
      throw new McpWriteError(
        `server "${server.name}" já existe em ${this.file} — use --force p/ sobrescrever.`,
      );
    }
    const merged: McpServerConfig[] = [
      ...current.servers.filter((s) => s.name !== server.name),
      server,
    ];
    this.write({ servers: merged });
    return { replaced: existing !== undefined };
  }

  /**
   * Remove o server `name`. MERGE: preserva os demais. Server ausente ⇒ `removed=false`
   * (o comando avisa, não é erro fatal). Quando o arquivo fica sem nenhum server, gravamos
   * `{ "mcpServers": {} }` (config vazia explícita — não apagamos o arquivo).
   */
  remove(name: string): { removed: boolean } {
    const current = this.load();
    const before = current.servers.length;
    const kept = current.servers.filter((s) => s.name !== name);
    if (kept.length === before) return { removed: false };
    this.write({ servers: kept });
    return { removed: true };
  }

  /**
   * EST-0970 (ciclo MCP na sessão) — liga/desliga o INTERRUPTOR `disabled` do server
   * `name` SEM desinstalar (a declaração command/args/env fica intacta). MERGE: preserva
   * os demais servers. `disabled=false` REMOVE o campo (config mínima — ausente = ativo).
   * Server ausente ⇒ `found:false` (o chamador avisa; não é erro fatal). Mesmo estatuto
   * E-B1 do add/remove: ato do USUÁRIO, nunca do agente.
   */
  setDisabled(name: string, disabled: boolean): { found: boolean } {
    const current = this.load();
    const existing = current.servers.find((s) => s.name === name);
    if (!existing) return { found: false };
    const updated: McpServerConfig = {
      name: existing.name,
      command: existing.command,
      args: existing.args,
      env: existing.env,
      ...(disabled ? { disabled: true } : {}),
    };
    this.write({ servers: current.servers.map((s) => (s.name === name ? updated : s)) });
    return { found: true };
  }

  /** Serializa + grava ATOMICAMENTE (tmp no MESMO dir + rename). Cria o dir se faltar. */
  private write(config: McpConfig): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true });
    const json = serializeMcpConfig(config);
    // tmp no MESMO diretório ⇒ rename atômico (mesmo filesystem). PID+timestamp evita
    // colisão entre escritas concorrentes do mesmo usuário.
    const tmp = join(dir, `.mcp.json.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, json, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * Serializa um `McpConfig` no formato `{ "mcpServers": { … } }` (paridade com o ecossistema
 * MCP / Claude Desktop). Determinístico: servers em ordem de inserção, `env` omitido quando
 * vazio (config mínima). NÃO injeta segredo nem credencial — só o DADO declarado.
 */
export function serializeMcpConfig(config: McpConfig): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of config.servers) {
    const entry: Record<string, unknown> = { command: s.command, args: [...s.args] };
    if (Object.keys(s.env).length > 0) entry['env'] = { ...s.env };
    // EST-0970 — interruptor `disabled` persiste só quando LIGADO (ausente = ativo).
    if (s.disabled === true) entry['disabled'] = true;
    mcpServers[s.name] = entry;
  }
  return JSON.stringify({ mcpServers }, null, 2) + '\n';
}
