// EST-0979 (FU-S3-CODEX-TOML) · ADR-0058 (E-B1) · CLI-SEC-12 — LEITOR CONFINADO do
// `~/.codex/config.toml`, espelhando o `McpConfigStore` do `~/.aluy/mcp.json` global.
//
// O OpenAI Codex declara seus servers MCP numa seção `[mcp_servers]` (TOML) do seu
// `config.toml` GLOBAL. A EST-0979 já lê do Codex o `AGENTS.md` (instruções) e o
// `.mcp.json` (formato compartilhado); FALTAVA o `config.toml` porque o monorepo não
// tinha parser TOML. Este leitor fecha a compat: lê o arquivo CONFINADO a `~/.codex/`,
// extrai SÓ `[mcp_servers]` (parser confinado no core) e produz o MESMO `McpConfig`
// das fontes JSON — p/ entrar na MESMA cadeia de merge e na MESMA catraca MCP.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ MESMA CATRACA, FONTE NOVA (gate `seguranca` — CLI-SEC-12 / E-B1):           ║
// ║  O `config.toml` é DADO de config do DONO (confiável como o `mcp.json`), mas ║
// ║  os servers que ele declara entram pela MESMA catraca: conectar cada server  ║
// ║  é `ask` (E-B2: efeito por padrão); a credencial headless do CLI JAMAIS vai  ║
// ║  ao environ do server (CLI-SEC-7, garantido no `stdio-transport.ts`); a saída ║
// ║  é dado não-confiável (CLI-SEC-4); Plan nega. O parser TOML NÃO executa nada  ║
// ║  do arquivo. WRITE-DENY: o agente não escreve `~/.codex/` (efeito → catraca). ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// CONFINAMENTO: só lê de `~/.codex/config.toml` (a base resolvida); o caminho é montado
// por nós (`join(base, 'config.toml')`), não vem de input do modelo.
//
// FAIL-SAFE: ausente/ilegível/grande-demais ⇒ config VAZIA (sem MCP do Codex — caso
// comum de quem não usa Codex). TOML inválido no subconjunto `[mcp_servers]` ⇒ config
// VAZIA + `error` (a UX avisa, o agente segue). NUNCA lança nem derruba o startup.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import {
  EMPTY_MCP_CONFIG,
  McpConfigError,
  parseCodexMcpConfig,
  type McpConfig,
} from '@aluy/cli-core';
import type { McpConfigLoad } from './mcp-config-store.js';

/** Nome do arquivo de config global do Codex (dentro de `~/.codex/`). */
export const CODEX_CONFIG_FILENAME = 'config.toml';

/** Teto defensivo de tamanho do `config.toml` (anti-arquivo-gigante adulterado). */
const MAX_CODEX_BYTES = 256 * 1024;

export interface CodexMcpConfigStoreOptions {
  /**
   * Raiz do `~/.codex/` (default: `<home>/.codex`). Injetável p/ teste (tmpdir), sem
   * tocar o `~/.codex/` real do dev. O `config.toml` é resolvido SÓ sob ela (confinado).
   */
  readonly baseDir?: string;
}

/**
 * Leitor de `~/.codex/config.toml` (seção `[mcp_servers]`). SÓ-LEITURA: o agente nunca
 * escreve aqui (escrever em `~/.codex/` é efeito que passa pela catraca normal), e a
 * edição é ato do usuário fora-de-banda. `load()` relê a cada chamada (config = DADO).
 */
export class CodexMcpConfigStore {
  private readonly file: string;

  constructor(opts: CodexMcpConfigStoreOptions = {}) {
    const base = opts.baseDir ?? join(homedir(), '.codex');
    this.file = join(base, CODEX_CONFIG_FILENAME);
  }

  /** O caminho do `config.toml` (p/ mensagens/teste). */
  get configPath(): string {
    return this.file;
  }

  /**
   * Lê + parseia o subconjunto `[mcp_servers]` do `config.toml`. Ausente/ilegível/
   * grande-demais ⇒ config VAZIA (sem MCP do Codex, sem erro: caso comum de quem não
   * usa Codex). TOML inválido no subconjunto ⇒ config VAZIA + `error` (UX avisa, o
   * agente segue). NUNCA lança.
   */
  load(): McpConfigLoad {
    let raw: string;
    try {
      const st = statSync(this.file);
      if (!st.isFile() || st.size > MAX_CODEX_BYTES) return { config: EMPTY_MCP_CONFIG };
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return { config: EMPTY_MCP_CONFIG }; // ausente/ilegível ⇒ sem MCP do Codex (comum).
    }
    try {
      return { config: parseCodexMcpConfig(raw) };
    } catch (e) {
      const msg = e instanceof McpConfigError ? e.message : String(e);
      return { config: EMPTY_MCP_CONFIG, error: msg };
    }
  }
}

/** Re-export do tipo-resultado p/ quem consome só este módulo. */
export type { McpConfig };
