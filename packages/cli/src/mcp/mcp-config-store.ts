// EST-0970 · ADR-0058 (E-B1) · CLI-SEC-12 — LEITOR CONFINADO de `~/.aluy/mcp.json`.
//
// Lê a config de SERVERS MCP (config do usuário, FORA do workspace) e a parseia com
// `parseMcpConfig` (parser PURO no core). É o kernel-de-cliente: o AGENTE não
// alcança `~/.aluy/` (a catraca NEGA read/write sobre ele — categories.ts). Editar
// `mcp.json` (declarar/plugar servers) é ato do USUÁRIO, fora-de-banda.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ WRITE-DENY de `~/.aluy/mcp.json` (E-B1 — o `seguranca` reconfere):          ║
// ║  Este leitor NÃO escreve `mcp.json` — e a CATRACA NEGA (deny, não ask) que o ║
// ║  agente o escreva por qualquer canal (edit_file/run_command/MCP), categoria  ║
// ║  `aluy-config-write-deny`, acima até do `--unsafe`. REUSA a categoria que JÁ  ║
// ║  existe (EST-0974): qualquer `~/.aluy/` é write-deny. Senão um README          ║
// ║  malicioso faria o agente plantar um server MCP que roda sempre.             ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// CONFINAMENTO: só lê de dentro de `~/.aluy/` (a base resolvida); o caminho do
// arquivo é montado por nós (`join(base, 'mcp.json')`), não vem de input do modelo.
//
// FAIL-SAFE: arquivo ausente/ilegível/JSON inválido ⇒ config VAZIA (sem MCP), com
// um erro registrado (p/ a UX avisar), NUNCA lança nem derruba o startup.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { EMPTY_MCP_CONFIG, McpConfigError, parseMcpConfig, type McpConfig } from '@hiperplano/aluy-cli-core';

/** Nome do arquivo de config de MCP (dentro de `~/.aluy/`). */
export const MCP_CONFIG_FILENAME = 'mcp.json';

/** Teto defensivo de tamanho do `mcp.json` (anti-arquivo-gigante adulterado). */
const MAX_MCP_BYTES = 256 * 1024;

export interface McpConfigStoreOptions {
  /**
   * Raiz do `~/.aluy/` (default: `<home>/.aluy`). Injetável p/ teste (tmpdir), sem
   * tocar o `~/.aluy/` real do dev. O `mcp.json` é resolvido SÓ sob ela (confinado).
   */
  readonly baseDir?: string;
}

/** Resultado da leitura: a config + um erro legível quando o arquivo é inválido. */
export interface McpConfigLoad {
  readonly config: McpConfig;
  /** Mensagem de erro quando o `mcp.json` existe mas é inválido (p/ a UX avisar). */
  readonly error?: string;
}

/**
 * Leitor de `~/.aluy/mcp.json`. SÓ-LEITURA: o agente nunca escreve aqui (a catraca
 * nega via `aluy-config-write-deny`), e a edição é ato do usuário fora-de-banda.
 * `load()` relê a cada chamada (config é DADO; sem cache).
 */
export class McpConfigStore {
  private readonly file: string;

  constructor(opts: McpConfigStoreOptions = {}) {
    const base = opts.baseDir ?? join(homedir(), '.aluy');
    this.file = join(base, MCP_CONFIG_FILENAME);
  }

  /** O caminho do `mcp.json` (p/ mensagens/teste). */
  get configPath(): string {
    return this.file;
  }

  /**
   * Lê + parseia o `mcp.json`. Ausente/ilegível/grande-demais ⇒ config VAZIA (sem
   * MCP, sem erro: é o caso comum de quem não usa MCP). JSON/formato inválido ⇒
   * config VAZIA + `error` (a UX avisa, mas o agente segue). NUNCA lança.
   */
  load(): McpConfigLoad {
    let raw: string;
    try {
      const st = statSync(this.file);
      if (!st.isFile() || st.size > MAX_MCP_BYTES) return { config: EMPTY_MCP_CONFIG };
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return { config: EMPTY_MCP_CONFIG }; // ausente/ilegível ⇒ sem MCP (caso comum).
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { config: EMPTY_MCP_CONFIG, error: `${this.file}: JSON inválido — MCP desativado.` };
    }
    try {
      return { config: parseMcpConfig(parsed) };
    } catch (e) {
      const msg = e instanceof McpConfigError ? e.message : String(e);
      return { config: EMPTY_MCP_CONFIG, error: msg };
    }
  }
}
