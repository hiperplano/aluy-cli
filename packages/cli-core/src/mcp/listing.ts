// EST-0970 · ADR-0058 (E-B1) · CLI-SEC-12 — LISTAGEM unificada de servers MCP
// (alimenta `aluy mcp list` e o slash `/mcp`).
//
// PURO (sem I/O): recebe os servers JÁ-LIDOS de CADA fonte (na ordem de precedência) e,
// opcionalmente, o resultado da DESCOBERTA (handshake — nº de tools/estado por server), e
// produz uma listagem determinística com ORIGEM resolvida. Quem lê os arquivos do disco é
// o `@aluy/cli` (locus confinado); aqui só compomos a vista.
//
// PRECEDÊNCIA (igual ao `mergeMcpConfigs` / setup.ts): da fonte MENOS p/ a MAIS específica
// — Codex global < `.aluy` global < projeto `.mcp.json`. Em colisão de nome, a fonte mais
// específica VENCE (é a que aparece na lista, com a sua origem). A listagem reflete isso:
// um server homônimo só aparece UMA vez, com a origem vencedora.
//
// SEGURANÇA: a listagem é DADO de exibição — não relaxa nada. O `command`/`args` exibidos
// são os declarados; o `env` é mostrado só por CHAVE (nunca o valor — pode ser referência a
// segredo do ambiente; CLI-SEC-7). A descoberta (estado de conexão/tools) é opcional: sem
// ela, listamos só a config (caso de `aluy mcp list` fora de sessão).

import type { McpConfig, McpServerConfig } from './config.js';
import type { McpDiscoveryResult } from './client.js';

/** Origem de um server na listagem (de onde o aluy o leu). */
export type McpServerOrigin =
  | 'aluy-global' // ~/.aluy/mcp.json (escrito por `aluy mcp add`)
  | 'project' // .mcp.json do workspace (escrito por `aluy mcp add --project`)
  | 'codex'; // ~/.codex/config.toml [mcp_servers] (NÃO gerenciado pelo aluy)

/** Estado de descoberta de um server (quando há handshake). */
export type McpServerState =
  | { readonly kind: 'unknown' } // sem descoberta (ex.: `aluy mcp list` fora de sessão)
  | { readonly kind: 'ok'; readonly toolCount: number } // handshake ok, N tools
  | { readonly kind: 'error'; readonly error: string } // handshake falhou
  // EST-0970 — `disabled: true` na config: a descoberta PULOU o server (sem processo,
  // sem tools). O estado vem da CONFIG (fonte da verdade), não do handshake.
  | { readonly kind: 'disabled' };

/** Uma tool descoberta de um server, com o nome JÁ prefixado (`mcp__<server>__<tool>`). */
export interface McpListedTool {
  /** Nome prefixado, como entra no toolset do agente. */
  readonly qualifiedName: string;
  /** Descrição declarada pelo server (DADO não-confiável — exibição apenas). */
  readonly description?: string;
}

/** Uma linha da listagem: um server, sua origem, declaração e estado. */
export interface McpListedServer {
  readonly name: string;
  readonly origin: McpServerOrigin;
  readonly command: string;
  readonly args: readonly string[];
  /** Chaves de env declaradas (NUNCA os valores — CLI-SEC-7). */
  readonly envKeys: readonly string[];
  /** `true` ⇒ o aluy gerencia este server (pode `remove`); `false` ⇒ vem do Codex. */
  readonly managed: boolean;
  readonly state: McpServerState;
  /** Tools descobertas (vazio quando não houve descoberta ou o server falhou). */
  readonly tools: readonly McpListedTool[];
}

/** Uma fonte de config + sua origem (na ordem de precedência: menos → mais específica). */
export interface McpSource {
  readonly origin: McpServerOrigin;
  readonly config: McpConfig;
}

/** Prefixo de uma tool no toolset (espelha `mcpToolName`, sem import circular). */
function qualify(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** O aluy gerencia (escreve) só `.aluy global` e `project`; Codex é leitura-só. */
function isManaged(origin: McpServerOrigin): boolean {
  return origin === 'aluy-global' || origin === 'project';
}

/**
 * Monta a listagem unificada de servers a partir das fontes (na ordem de precedência:
 * menos → mais específica) e, opcionalmente, do resultado da descoberta.
 *
 * - PRECEDÊNCIA: a ÚLTIMA fonte que declara um nome VENCE (origem + declaração dela). A
 *   ordem da SAÍDA é a 1ª aparição do nome (determinística), com a declaração/origem
 *   vencedora.
 * - ESTADO: se `discovery` for dado, casa por nome de server (ok+nº tools / erro). Sem
 *   `discovery`, todo server fica `unknown`.
 */
export function buildMcpListing(
  sources: readonly McpSource[],
  discovery?: McpDiscoveryResult,
): readonly McpListedServer[] {
  // Resolve a fonte vencedora por nome (última vence), preservando a 1ª posição.
  const order: string[] = [];
  const winner = new Map<string, { origin: McpServerOrigin; server: McpServerConfig }>();
  for (const { origin, config } of sources) {
    for (const server of config.servers) {
      if (!winner.has(server.name)) order.push(server.name);
      winner.set(server.name, { origin, server });
    }
  }

  // Índice de descoberta por nome de server (estado + tools).
  const discByServer = discovery ? indexDiscovery(discovery) : undefined;

  return order.map((name) => {
    const { origin, server } = winner.get(name)!;
    const disc = discByServer?.get(name);
    // EST-0970 — `disabled` na config VENCE qualquer estado de descoberta (a descoberta
    // o pulou; se houver entrada residual por nome, a config é a fonte da verdade).
    const state: McpServerState =
      server.disabled === true
        ? { kind: 'disabled' }
        : disc
          ? disc.ok
            ? { kind: 'ok', toolCount: disc.tools.length }
            : { kind: 'error', error: disc.error ?? 'falha na conexão' }
          : { kind: 'unknown' };
    const tools: McpListedTool[] = state.kind === 'ok' && disc ? disc.tools : [];
    return {
      name,
      origin,
      command: server.command,
      args: server.args,
      envKeys: Object.keys(server.env),
      managed: isManaged(origin),
      state,
      tools,
    };
  });
}

interface DiscEntry {
  readonly ok: boolean;
  readonly error?: string;
  readonly tools: McpListedTool[];
}

function indexDiscovery(discovery: McpDiscoveryResult): Map<string, DiscEntry> {
  const byName = new Map<string, DiscEntry>();
  for (const s of discovery.servers) {
    const tools: McpListedTool[] = s.tools.map((t) => ({
      qualifiedName: qualify(s.server, t.descriptor.name),
      ...(t.descriptor.description !== undefined ? { description: t.descriptor.description } : {}),
    }));
    byName.set(s.server, {
      ok: s.ok,
      ...(s.error !== undefined ? { error: s.error } : {}),
      tools,
    });
  }
  return byName;
}

/**
 * EST-0970 — detecta config LEGADA quebrada: `command:"--"` (o separador do
 * `aluy mcp add <nome> -- <command>` gravado por engano por versões antigas do parser).
 * Um server assim NUNCA spawna — em vez de falhar silencioso na descoberta, a listagem
 * (`aluy mcp list` e o `/mcp` da sessão) AVISA com a correção pronta. PURO (só string);
 * `undefined` ⇒ server ok.
 */
export function invalidCommandWarning(server: McpListedServer): string | undefined {
  if (server.command.trim() !== '--') return undefined;
  const realCmd = server.args.length > 0 ? server.args.join(' ') : '<command> [args...]';
  return (
    `server "${server.name}" com command inválido "--" (separador gravado por engano — ` +
    `nunca vai conectar). Re-adicione: aluy mcp add ${server.name} --force -- ${realCmd}`
  );
}

/** Rótulo PT-BR curto de uma origem (p/ a coluna "origem" da listagem). */
export function originLabel(origin: McpServerOrigin): string {
  switch (origin) {
    case 'aluy-global':
      return '~/.aluy/mcp.json';
    case 'project':
      return '.mcp.json (projeto)';
    case 'codex':
      return '~/.codex (Codex)';
  }
}
