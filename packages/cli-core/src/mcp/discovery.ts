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
/** Resultado interno de UM server — nunca lança (fail-soft já resolvido aqui). */
interface OneServerOutcome {
  readonly result: McpServerDiscovery;
  readonly transport?: McpTransport;
}

export async function discoverMcpTools(
  config: McpConfig,
  makeTransport: McpTransportFactory,
): Promise<McpDiscoveryResult> {
  // EST-0970/ADR-0058 (paralelização do boot) — cada server ATIVO conecta EM
  // PARALELO: `Promise.all` sobre um array de promises que NUNCA rejeitam (o
  // try/catch por-server abaixo resolve o fail-soft POR DENTRO de cada uma). Antes,
  // o `for...of` com `await` dentro do loop fazia cada server esperar o anterior —
  // o pior caso era a SOMA dos tempos de conexão. Agora o pior caso é o server MAIS
  // LENTO (limitado pelo watchdog do transport), porque todos conectam ao mesmo
  // tempo. `Promise.all` (não `allSettled`) é seguro aqui exatamente PORQUE nenhuma
  // promise do array rejeita — o catch é interno.
  const active = config.servers.filter((server) => server.disabled !== true);

  const outcomes = await Promise.all(
    active.map(async (server): Promise<OneServerOutcome> => {
      // EST-0970 (ciclo MCP na sessão) — server DESATIVADO já foi filtrado acima:
      // não lança processo, não conecta, nenhuma tool entra no toolset. Ele não
      // aparece no resultado da descoberta — a LISTAGEM (listing.ts) resolve o
      // estado "desativado" direto da config (a fonte da verdade do interruptor).
      const transport = makeTransport(server);
      try {
        const descriptors = await transport.connect(server);
        const tools: DiscoveredMcpTool[] = descriptors.map((descriptor) => ({
          server: server.name,
          descriptor,
          transport,
        }));
        return { result: { server: server.name, ok: true, tools }, transport };
      } catch (e) {
        // fail-soft: o server não subiu / handshake falhou ⇒ some do toolset, com o
        // erro registrado. Fecha o transport (best-effort) p/ não vazar processo.
        // Isolado por server: a falha de UM `await connect()` não aborta os demais
        // `Promise.all` porque é capturada AQUI, dentro da própria promise do map —
        // nunca propaga pra fora e derruba as outras conexões em voo.
        void closeQuietly(transport);
        return { result: { server: server.name, ok: false, tools: [], error: errMsg(e) } };
      }
    }),
  );

  // ORDEM DETERMINÍSTICA: `outcomes` está na MESMA posição de `active` (o `.map`
  // preserva índice mesmo com conexões concluindo fora de ordem, porque cada
  // servidor conecta em paralelo mas cada promise devolve seu resultado na posição
  // que entrou) — o `Promise.all` reordena os resultados pela ordem de ENTRADA, não
  // pela ordem de CONCLUSÃO. O resultado final segue a ordem do `mcp.json`.
  const serverResults: McpServerDiscovery[] = [];
  const allTools: DiscoveredMcpTool[] = [];
  const transports: McpTransport[] = [];
  for (const outcome of outcomes) {
    serverResults.push(outcome.result);
    allTools.push(...outcome.result.tools);
    if (outcome.transport) transports.push(outcome.transport);
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
