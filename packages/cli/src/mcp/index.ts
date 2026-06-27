// Barrel do MCP concreto (@aluy/cli) — EST-0970 · ADR-0058 · CLI-SEC-12.
//
// Liga o cliente MCP PORTÁVEL (cli-core) ao I/O concreto: leitura confinada do
// `~/.aluy/mcp.json` + o transporte stdio do SDK MCP oficial. O `setupMcp` é o
// ponto de entrada do wiring (lê a config, descobre as tools, devolve-as adaptadas
// p/ o registro do agente ATRÁS da catraca).

export { McpConfigStore, MCP_CONFIG_FILENAME } from './mcp-config-store.js';
export type { McpConfigStoreOptions, McpConfigLoad } from './mcp-config-store.js';

// EST-0979 — leitor confinado do `.mcp.json` do PROJETO (padrão Claude Code, no
// workspace). Config de PROJETO = DADO confinado; mesclada com projeto > global.
export { ProjectMcpConfigStore, PROJECT_MCP_CONFIG_FILENAME } from './project-mcp-config.js';
export type { ProjectMcpConfigStoreOptions } from './project-mcp-config.js';

// EST-0979 (FU-S3-CODEX-TOML) — leitor confinado do `~/.codex/config.toml` (Codex
// GLOBAL, seção `[mcp_servers]` em TOML). Config GLOBAL = DADO; mesma catraca MCP.
export { CodexMcpConfigStore, CODEX_CONFIG_FILENAME } from './codex-mcp-config.js';
export type { CodexMcpConfigStoreOptions } from './codex-mcp-config.js';

export { StdioMcpTransport, buildServerEnv } from './stdio-transport.js';
export type { StdioMcpTransportOptions } from './stdio-transport.js';

export { setupMcp, MCP_TRUST_WARNING } from './setup.js';
export type { McpSetup, SetupMcpOptions } from './setup.js';

// EST-0970 — ESCRITOR merge-safe da config MCP (`~/.aluy/mcp.json` global ou `.mcp.json` do
// projeto). É a camada de CONVENIÊNCIA por trás de `aluy mcp add/remove` — ato do USUÁRIO
// (o comando que ele digita), fora do caminho do agente (a catraca segue negando o agente).
export { McpConfigWriter, McpWriteError, serializeMcpConfig } from './mcp-config-writer.js';
export type { McpConfigWriterOptions } from './mcp-config-writer.js';
