// EST-0970 · ADR-0058 · CLI-SEC-12 — o CONTRATO do cliente MCP (PORTÁVEL).
//
// O cliente MCP do Aluy CLI conecta a servers LOCAIS (stdio): lança o processo,
// faz o handshake, lista as tools. A LÓGICA (descoberta, adaptação das tools p/ o
// toolset, classificação de efeito) é portável (cli-core); o SPAWN/STDIO concreto
// (`child_process` + `@modelcontextprotocol/sdk` StdioClientTransport) é injetado
// pelo `@hiperplano/aluy-cli` via a porta `McpTransport`. Fecha a fronteira do §8: a costura
// é testável no core com um transport-mock; o I/O de processo mora no locus.
//
// INVARIANTES (CLI-SEC-12):
//  - Saída de tool MCP = DADO NÃO-CONFIÁVEL (CLI-SEC-4): `callTool()` devolve texto
//    que o loop envelopa como observação; nunca instrução.
//  - Toda tool MCP entra no toolset ATRÁS da catraca (CLI-SEC-H1): o adapter
//    (`tool-adapter.ts`) cria um `NativeTool` cujo `run` só roda DEPOIS do `allow`;
//    a classificação de efeito (E-B2) é por sinais não-confiáveis, não por rótulo.
//  - A config (`mcp.json`) é DADO; o egress do server respeita a malha quando
//    aplicável (CLI-SEC-5); o processo é confinado a workspace + path-deny (best-
//    effort em v1 — ver FU-VAU-11-bis no README/docs).
//
// PORTÁVEL: sem `node:*`. Só tipos + orquestração sobre a porta injetada.

import type { McpServerConfig } from './config.js';

/**
 * Descritor de UMA tool exposta por um server MCP, COMO O SERVER A DECLARA. ⚠ É
 * DADO NÃO-CONFIÁVEL (E-B2): `description`/`inputSchema` vêm do server e podem
 * mentir. NÃO há campo `readonly`/`effect` aqui DE PROPÓSITO — mesmo que o server
 * mandasse um, NÃO seria lido (a classificação de efeito é por sinais do input).
 */
export interface McpToolDescriptor {
  /** Nome da tool no server (sem o prefixo `mcp__<server>__`). */
  readonly name: string;
  /** Descrição declarada pelo server — DADO não-confiável (vai p/ o prompt cercado). */
  readonly description: string;
  /**
   * EST-0970 (E-B2) — JSON Schema do INPUT declarado pelo server (`inputSchema` do
   * MCP). ⚠ DADO NÃO-CONFIÁVEL: o server pode mentir ou embutir texto hostil. NÃO é
   * usado p/ validar/confiar — só p/ DERIVAR os parâmetros que o prompt mostra ao
   * modelo (`paramsFromJsonSchema` + render SANITIZADO no canal de tool-doc). Sem
   * isto, o modelo adivinha os args de tools complexas e a chamada falha por campo
   * faltante. OPCIONAL (`unknown` — shape arbitrário, lido defensivamente): um
   * server que não declare/declare lixo ⇒ a tool entra no prompt SEM params (igual
   * ao de antes). A classificação de EFEITO segue por sinais do INPUT, nunca daqui.
   */
  readonly inputSchema?: unknown;
}

/** Resultado de chamar uma tool MCP: texto (DADO não-confiável, CLI-SEC-4). */
export interface McpCallResult {
  /** `false` ⇒ o server reportou erro; vira observação de erro (não lança). */
  readonly ok: boolean;
  /** Conteúdo textual devolvido pelo server. DADO NÃO-CONFIÁVEL (envelopado a jusante). */
  readonly content: string;
}

/**
 * PORTA do transporte MCP concreto (injetada pelo `@hiperplano/aluy-cli`). Abstrai o
 * lançamento do processo-server e a fala MCP por stdio. O core a consome; o locus
 * a implementa com `@modelcontextprotocol/sdk` + `child_process`. Uma instância =
 * UM server conectado.
 */
export interface McpTransport {
  /**
   * Lança o server (command/args/env do `McpServerConfig`), faz o handshake MCP
   * (initialize) e devolve as tools listadas. ⚠ O spawn concreto (locus) garante:
   * environ MÍNIMO (CLI-SEC-7: SEM a credencial headless do CLI), cwd confinado ao
   * workspace, e os tetos de processo. Lança se o server não subir/handshake falhar.
   */
  connect(server: McpServerConfig): Promise<readonly McpToolDescriptor[]>;
  /** Chama uma tool do server (nome SEM prefixo). Devolve DADO não-confiável.
   *  BUG-0028 — `signal` (o MESMO abort do ESC/Ctrl-C do loop, via `ToolRunContext`)
   *  cancela a chamada EM VOO. Sem ele, o ESC NÃO interrompe uma tool MCP travada
   *  (o usuário esperava até o teto de 60s do transport). Opcional/backward-compat. */
  callTool(
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<McpCallResult>;
  /** Encerra o processo-server (cleanup no fim da sessão / re-handshake). */
  close(): Promise<void>;
}

/**
 * Fábrica de transport por server. O `@hiperplano/aluy-cli` injeta isto; o core a chama uma
 * vez por server declarado. Mantém o core sem `child_process`.
 */
export type McpTransportFactory = (server: McpServerConfig) => McpTransport;

/** Uma tool MCP descoberta, já ligada ao seu server + transport (p/ o adapter). */
export interface DiscoveredMcpTool {
  /** Server de origem (p/ o prefixo e p/ o re-handshake). */
  readonly server: string;
  /** Descritor declarado pelo server (DADO não-confiável). */
  readonly descriptor: McpToolDescriptor;
  /** Transport vivo p/ chamar a tool. */
  readonly transport: McpTransport;
}

/** Resultado da descoberta de UM server (sucesso com tools, ou falha registrada). */
export interface McpServerDiscovery {
  readonly server: string;
  readonly ok: boolean;
  /** Tools descobertas (vazio em falha). */
  readonly tools: readonly DiscoveredMcpTool[];
  /** Mensagem de erro quando `ok=false` (server não subiu / handshake falhou). */
  readonly error?: string;
}

/** Resultado completo da descoberta MCP (todos os servers do `mcp.json`). */
export interface McpDiscoveryResult {
  readonly servers: readonly McpServerDiscovery[];
  /** Todas as tools de todos os servers que subiram (achatado, p/ o registry). */
  readonly tools: readonly DiscoveredMcpTool[];
  /** Transports vivos (p/ fechar no fim da sessão). */
  readonly transports: readonly McpTransport[];
}
