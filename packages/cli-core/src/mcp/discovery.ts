// EST-0970 · ADR-0058 · CLI-SEC-12 — DESCOBERTA: lança os servers, handshake, lista.
//
// Orquestra a descoberta PORTÁVEL: dada a `McpConfig` (já lida do `~/.aluy/mcp.json`
// confinado, pelo locus) e uma fábrica de transport (injetada pelo `@hiperplano/aluy-cli`),
// para cada server: lança (command/args/env), faz o handshake (initialize) e lista
// as tools. Falha de UM server NÃO derruba os outros (fail-soft: o server some do
// toolset, com erro registrado p/ a UX/log) — um MCP quebrado não trava o agente.
//
// ⚠ RE-HANDSHAKE RE-CLASSIFICA (CLI-SEC-12 / E-B2): NÃO há cache "já aprovei esta
// tool". Cada `discover()` produz tools FRESCAS; a classificação de efeito acontece
// no `decide()` a cada chamada (não na descoberta). Trocar o server (mesmo nome,
// binário diferente) e re-descobrir ⇒ as tools são reavaliadas do zero.
//
// PORTÁVEL: sem `node:*`. Só orquestração sobre a porta `McpTransportFactory`.

import { type McpConfig } from './config.js';
import type {
  DiscoveredMcpTool,
  McpDiscoveryResult,
  McpServerDiscovery,
  McpTransport,
  McpTransportFactory,
} from './client.js';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Descobre as tools de TODOS os servers declarados. Lança cada server pela fábrica
 * de transport, faz o handshake e coleta as tools. Resiliente: um server que falha
 * é registrado (`ok:false`) e omitido do toolset, sem abortar os demais.
 *
 * @param config  config já parseada (do `mcp.json` confinado a `~/.aluy/`).
 * @param makeTransport  fábrica de transport concreto (stdio), injetada pelo locus.
 */
export async function discoverMcpTools(
  config: McpConfig,
  makeTransport: McpTransportFactory,
): Promise<McpDiscoveryResult> {
  const serverResults: McpServerDiscovery[] = [];
  const allTools: DiscoveredMcpTool[] = [];
  const transports: McpTransport[] = [];

  for (const server of config.servers) {
    // EST-0970 (ciclo MCP na sessão) — server DESATIVADO (`disabled: true`) é PULADO:
    // não lança processo, não conecta, nenhuma tool entra no toolset. Ele não aparece
    // no resultado da descoberta — a LISTAGEM (listing.ts) resolve o estado
    // "desativado" direto da config (a fonte da verdade do interruptor).
    if (server.disabled === true) continue;
    const transport = makeTransport(server);
    try {
      const descriptors = await transport.connect(server);
      const tools: DiscoveredMcpTool[] = descriptors.map((descriptor) => ({
        server: server.name,
        descriptor,
        transport,
      }));
      transports.push(transport);
      allTools.push(...tools);
      serverResults.push({ server: server.name, ok: true, tools });
    } catch (e) {
      // fail-soft: o server não subiu / handshake falhou ⇒ some do toolset, com o
      // erro registrado. Fecha o transport (best-effort) p/ não vazar processo.
      void closeQuietly(transport);
      serverResults.push({ server: server.name, ok: false, tools: [], error: errMsg(e) });
    }
  }

  return { servers: serverResults, tools: allTools, transports };
}

/** Fecha todos os transports vivos (cleanup no fim da sessão). Best-effort. */
export async function closeMcpTransports(transports: readonly McpTransport[]): Promise<void> {
  await Promise.all(transports.map((t) => closeQuietly(t)));
}

async function closeQuietly(transport: McpTransport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // cleanup é best-effort; um close que falha não deve quebrar a sessão.
  }
}
