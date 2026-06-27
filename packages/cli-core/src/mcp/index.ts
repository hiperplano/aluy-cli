// Barrel do módulo MCP (EST-0970 · ADR-0058 · CLI-SEC-12).
//
// Cliente MCP PORTÁVEL: config (DADO), descoberta+handshake, adaptação das tools
// p/ o toolset (atrás da catraca), e a classificação de efeito por SINAIS
// NÃO-CONFIÁVEIS-DO-SERVER (E-B2). O SPAWN/STDIO concreto (`@modelcontextprotocol/
// sdk` + `child_process`) é injetado pelo `@aluy/cli` via a porta `McpTransport`.

export {
  EMPTY_MCP_CONFIG,
  McpConfigError,
  isValidServerName,
  parseMcpConfig,
  mergeMcpConfigs,
  type McpConfig,
  type McpServerConfig,
} from './config.js';

// EST-0979 (FU-S3-CODEX-TOML) — parser TOML CONFINADO do subconjunto `[mcp_servers]`
// do `~/.codex/config.toml`. Produz o MESMO `McpConfig` das fontes JSON; mesma catraca.
export { parseCodexMcpConfig } from './codex-toml.js';

// EST-0970 — HEURÍSTICA pura: o `--env K=V` de `aluy mcp add` parece um SEGREDO literal?
// (avisa, não bloqueia — preserva "o mcp.json não carrega segredo literal").
export { inspectEnvSecret } from './secret-heuristic.js';
export type { SecretInspection, SecretSignal } from './secret-heuristic.js';

// EST-0970 — LISTAGEM pura de servers MCP (alimenta `aluy mcp list` e o slash `/mcp`):
// resolve origem/precedência e casa o estado da descoberta. Sem I/O.
export { buildMcpListing, invalidCommandWarning, originLabel } from './listing.js';
export type {
  McpListedServer,
  McpListedTool,
  McpServerOrigin,
  McpServerState,
  McpSource,
} from './listing.js';

export {
  type DiscoveredMcpTool,
  type McpCallResult,
  type McpDiscoveryResult,
  type McpServerDiscovery,
  type McpToolDescriptor,
  type McpTransport,
  type McpTransportFactory,
} from './client.js';

export { closeMcpTransports, discoverMcpTools } from './discovery.js';

export {
  adaptMcpTool,
  adaptMcpTools,
  mcpToolName,
  parseMcpToolName,
  MAX_MCP_TOOLS_PER_SERVER,
  MAX_MCP_TOOL_DESC_CHARS,
} from './tool-adapter.js';

export {
  MCP_TOOL_PREFIX,
  collectStrings,
  extractPathCandidates,
  inputHasNetworkSignal,
  isMcpToolName,
} from './effect-signals.js';

// EST-0970 (search) — BUSCA na biblioteca de MCP servers no REGISTRO OFICIAL ABERTO
// (`registry.modelcontextprotocol.io`, sem key). Egress FIXO (CLI-SEC-5) + saída =
// DADO_NÃO_CONFIÁVEL (CLI-SEC-4): só LÊ e MOSTRA; instalar é `aluy mcp add` (catraca).
export {
  MAX_SEARCH_RESULTS,
  MCP_REGISTRY_HOST,
  MCP_REGISTRY_SERVERS_URL,
  matchesQuery,
  parseServersPage,
  registryPageUrl,
  searchRegistry,
  type RegistryFetch,
  type RegistryFetchResult,
  type RegistryRunHint,
  type RegistrySearchOutcome,
  type RegistrySearchResult,
} from './registry.js';

export { addCommandFor, formatSearchOutcome, suggestServerName } from './registry-format.js';
