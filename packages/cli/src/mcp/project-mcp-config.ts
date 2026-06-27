// EST-0979 · ADR-0058 (E-B1) · CLI-SEC-12 — LEITOR CONFINADO do `.mcp.json` do
// PROJETO (padrão Claude Code, no workspace), espelhando o `~/.aluy/mcp.json` global.
//
// MESMA CATRACA, FONTE NOVA: o `.mcp.json` do projeto declara servers MCP no MESMO
// formato (`mcpServers`) do `~/.aluy/mcp.json`. EST-0979 só amplia o LOCUS de
// descoberta — NÃO muda a segurança:
//
//   • CONFINAMENTO (WorkspacePort/EST-0948): o `.mcp.json` é lido SÓ de DENTRO da raiz
//     do workspace, canonicalizado (um symlink `.mcp.json` → fora ⇒ rejeitado, nada
//     lido). É config de PROJETO = DADO confinado ao workspace.
//   • É DADO, NÃO relaxa a catraca: conectar CADA server descoberto continua sendo
//     `ask` (E-B2: efeito por padrão). Um `.mcp.json` de um repo clonado NÃO
//     auto-pluga um server — pede confirmação como qualquer efeito.
//   • SEGREDO por-server / CLI-SEC-7: o `env` é por-server (escopo mínimo); a
//     credencial headless do CLI JAMAIS entra no environ do server (garantido no
//     spawn concreto — `stdio-transport.ts`). Isso vale igual p/ global e projeto.
//   • WRITE-DENY: o agente NÃO escreve `.mcp.json` por conta própria — escrita dentro
//     do workspace é efeito (`edit_file`) e passa pela catraca normal; isto aqui só LÊ.
//
// PRECEDÊNCIA (cravada/documentada): **projeto especializa o global** — em colisão de
// nome de server, a declaração do `.mcp.json` (projeto) VENCE a do `~/.aluy/mcp.json`
// (global). Alinha EST-0964/0974 (projeto > global). O merge é puro (`mergeMcpConfigs`).
//
// FAIL-SAFE: ausente/ilegível/JSON inválido/escapa-a-raiz ⇒ config VAZIA (sem MCP de
// projeto), com erro legível quando o arquivo existe mas é inválido. NUNCA lança.

import { parseMcpConfig, EMPTY_MCP_CONFIG, McpConfigError } from '@aluy/cli-core';
import type { McpConfig } from '@aluy/cli-core';
import { classifyAttachPath } from '../attach/path-deny.js';
import type { WorkspacePort } from '../io/workspace.js';
import type { McpConfigLoad } from './mcp-config-store.js';

/** Nome do arquivo de config MCP do PROJETO (padrão Claude Code, na raiz do workspace). */
export const PROJECT_MCP_CONFIG_FILENAME = '.mcp.json';

/** Teto defensivo de tamanho do `.mcp.json` (anti-arquivo-gigante adulterado). */
const MAX_MCP_BYTES = 256 * 1024;

export interface ProjectMcpConfigStoreOptions {
  /** Workspace confinado — `.mcp.json` é resolvido/canonicalizado SÓ sob a raiz. */
  readonly workspace: WorkspacePort;
  /**
   * Leitor de arquivo confinado (FileSystemPort do @aluy/cli). Recebe um path
   * RELATIVO à raiz; reconfina internamente. Devolve o conteúdo (string).
   */
  readonly readFile: (path: string) => Promise<string>;
  /** Existência confinada (FileSystemPort.exists). */
  readonly exists: (path: string) => Promise<boolean>;
}

/**
 * Leitor do `.mcp.json` do PROJETO (no workspace confinado). Config de PROJETO =
 * DADO; lida pela borda confinada; NÃO relaxa a catraca. `load()` relê a cada chamada
 * (config é DADO; sem cache). Ausente ⇒ config VAZIA (caso comum — repo sem MCP).
 */
export class ProjectMcpConfigStore {
  private readonly workspace: WorkspacePort;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly exists: (path: string) => Promise<boolean>;

  constructor(opts: ProjectMcpConfigStoreOptions) {
    this.workspace = opts.workspace;
    this.readFile = opts.readFile;
    this.exists = opts.exists;
  }

  /** O caminho confinado do `.mcp.json` do projeto (p/ mensagens/teste). */
  get configPath(): string {
    return `${this.workspace.root}/${PROJECT_MCP_CONFIG_FILENAME}`;
  }

  /**
   * Lê + parseia o `.mcp.json` do projeto, CONFINADO à raiz. Escapa-a-raiz/path-deny/
   * ausente/grande-demais ⇒ config VAZIA (sem MCP de projeto). JSON/formato inválido ⇒
   * config VAZIA + `error` (a UX avisa, o agente segue). NUNCA lança.
   */
  async load(): Promise<McpConfigLoad> {
    // CONFINAMENTO: rejeita se o `.mcp.json` escapa a raiz (symlink p/ fora, etc.).
    try {
      this.workspace.resolveInside(PROJECT_MCP_CONFIG_FILENAME);
    } catch {
      return { config: EMPTY_MCP_CONFIG };
    }
    // PATH-DENY explícito (não é BYPASS do regime; `.mcp.json` é `allow`).
    if (classifyAttachPath(PROJECT_MCP_CONFIG_FILENAME).kind !== 'allow') {
      return { config: EMPTY_MCP_CONFIG };
    }

    let raw: string;
    try {
      if (!(await this.exists(PROJECT_MCP_CONFIG_FILENAME))) {
        return { config: EMPTY_MCP_CONFIG }; // ausente ⇒ sem MCP de projeto (comum).
      }
      raw = await this.readFile(PROJECT_MCP_CONFIG_FILENAME);
    } catch {
      return { config: EMPTY_MCP_CONFIG }; // ilegível ⇒ sem MCP de projeto.
    }
    if (raw.length > MAX_MCP_BYTES) {
      return {
        config: EMPTY_MCP_CONFIG,
        error: `${PROJECT_MCP_CONFIG_FILENAME}: grande demais — MCP de projeto desativado.`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        config: EMPTY_MCP_CONFIG,
        error: `${PROJECT_MCP_CONFIG_FILENAME}: JSON inválido — MCP de projeto desativado.`,
      };
    }
    try {
      return { config: parseMcpConfig(parsed) };
    } catch (e) {
      const msg = e instanceof McpConfigError ? e.message : String(e);
      return { config: EMPTY_MCP_CONFIG, error: msg };
    }
  }
}

/** Re-export do tipo-resultado p/ quem consome só este módulo. */
export type { McpConfig };
