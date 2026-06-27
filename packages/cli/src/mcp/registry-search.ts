// EST-0970 (search) · CLI-SEC-5 — I/O CONCRETO de `aluy mcp search <query>`.
//
// Liga a busca PORTÁVEL do core (`searchRegistry`/`formatSearchOutcome`) à rede REAL,
// SÓ p/ o endpoint FIXO do registro OFICIAL ABERTO do MCP. Reusa o `safeFetch`
// anti-SSRF (EST-0971) — resolve→valida→pina→conecta — então NEM O REGISTRO oficial
// é exceção da defesa de profundidade (se o DNS dele apontasse interno, barra).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ EGRESS FIXO (CLI-SEC-5 · AG-0010, p/ o `seguranca` reconferir):             ║
// ║  • A allowlist desta busca contém UM host SÓ: `registry.modelcontextprotocol.io`║
// ║    (MCP_REGISTRY_HOST), com `includeSearchHosts:false` (os hosts do DDG do    ║
// ║    web_search NÃO entram aqui). Toda URL pedida é derivada de                  ║
// ║    MCP_REGISTRY_SERVERS_URL no CORE — não há host vindo de input. Reconferimos ║
// ║    o host aqui (defesa em profundidade) ANTES de qualquer socket.             ║
// ║  • NÃO SEGUE REDIRECT (`maxRedirects:0`). A allowlist de host roda 1× na URL  ║
// ║    de ENTRADA; o safeFetch NÃO a revalida nos hops de redirect (só a denylist ║
// ║    de IP). Por isso um `302 → host-atacante` é BARRADO virando falha, em vez  ║
// ║    de puxar corpo de host arbitrário. Com isso o "1 host só" é de fato fixo.  ║
// ║  • SEM KEY: o registro é aberto; não enviamos Authorization nem cookie.       ║
// ║  • SÓ LÊ: a resposta é DADO_NÃO_CONFIÁVEL — nada é executado. Instalar é       ║
// ║    `aluy mcp add` (outro comando, atrás da catraca).                          ║
// ║  • DEGRADA GRACIOSO: rede fora/timeout/redirect ⇒ `{ ok:false }` legível.     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import {
  MCP_REGISTRY_HOST,
  formatSearchOutcome,
  safeFetch,
  searchRegistry,
  type RegistryFetch,
  type RegistryFetchResult,
  type SafeFetcherPorts,
  type WebFetchPolicy,
} from '@hiperplano/aluy-cli-core';
import { EgressAllowlist } from '../io/egress.js';
import { NodeHostResolver, NodePinnedFetcher } from '../io/web-port.js';

/**
 * Tetos da busca no registro (resposta pode ser grande; corta cedo).
 *
 * `maxRedirects: 0` é DELIBERADO (AG-0010 · CLI-SEC-5). O endpoint oficial
 * `/v0/servers` NÃO redireciona; um redirect só pode vir de um registro
 * MITM/comprometido. CRUCIAL: o `safeFetch` revalida a denylist de IP (anti-SSRF)
 * a CADA hop, mas a allowlist de HOST roda 1× SÓ na URL de ENTRADA
 * (`createRegistryFetch`), nunca sobre os hops de redirect — então um
 * `302 → host-publico-atacante.com` escaparia da garantia "egress fixo: 1 host".
 * Com `maxRedirects: 0` o redirect vira FALHA (degrada gracioso "registro
 * indisponível") em vez de puxar corpo de host arbitrário. AÍ SIM o egress é fixo.
 */
const REGISTRY_POLICY: WebFetchPolicy = {
  maxBytes: 1024 * 1024, // 1 MiB por página (uma página são ~100 servers).
  timeoutMs: 12_000,
  maxRedirects: 0, // egress FIXO: não segue redirect (a allowlist de host não revalida hops).
};

/**
 * Constrói a porta `RegistryFetch` para o CORE: GET seguro, confinado ao host FIXO
 * do registro. NUNCA lança (contrato do core) — erro de rede vira `{ ok:false }`.
 *
 * `ports`/`policy` são injetáveis p/ teste (mock dos sockets), sem rede real.
 */
export function createRegistryFetch(
  opts: {
    readonly ports?: SafeFetcherPorts;
    readonly policy?: WebFetchPolicy;
  } = {},
): RegistryFetch {
  // Allowlist DEDICADA: SÓ o host do registro oficial. Egress FIXO (CLI-SEC-5).
  // Não herda a allowlist da sessão; esta busca fala com 1 host e nada mais.
  // `includeSearchHosts:false` é OBRIGATÓRIO (AG-0010): sem ele os hosts do
  // DuckDuckGo (backend do web_search) entrariam SILENCIOSAMENTE nesta allowlist
  // "dedicada", contradizendo a garantia de 1-host-só. Aqui o search NÃO fala DDG.
  const allowlist = new EgressAllowlist({
    aluyHosts: [MCP_REGISTRY_HOST],
    includeSearchHosts: false,
  });
  const ports: SafeFetcherPorts = opts.ports ?? {
    resolver: new NodeHostResolver(),
    fetcher: new NodePinnedFetcher(),
  };
  const policy = opts.policy ?? REGISTRY_POLICY;

  return async (url: string, signal?: AbortSignal): Promise<RegistryFetchResult> => {
    // Defesa em profundidade: o host PRECISA ser o registro oficial. O core já só
    // monta URLs do host fixo; aqui reconferimos ANTES de tocar a rede (egress fixo).
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return { ok: false, reason: `URL inválida do registro: "${url}"` };
    }
    if (!allowlist.isAllowed(host)) {
      return {
        ok: false,
        reason: `egress bloqueado: "${host}" não é o registro oficial (${MCP_REGISTRY_HOST})`,
      };
    }

    // HUNT-IO-NET — propaga o `signal` ao safeFetch (antes era `void signal` ⇒ o
    // cancelamento da sessão NÃO matava o fetch do registro: ele pendurava até o
    // timeout de 12s). Agora o abort mata o socket na hora. Os tetos por-hop
    // (timeout/maxBytes) seguem aplicados. GET simples (sem corpo).
    const result = await safeFetch(url, ports, policy, signal ? { signal } : {});
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, status: result.status, body: result.body };
  };
}

/** Resultado de uma execução de `mcp search` p/ a CLI imprimir. */
export interface McpSearchRun {
  /** Texto pronto p/ stdout (lista de servers OU mensagem de "nenhum"/degradação). */
  readonly text: string;
  /** Código de saída sugerido (0 = ok/lista/nenhum; 1 = registro indisponível). */
  readonly exitCode: number;
}

/**
 * Executa `aluy mcp search <query>`: busca no registro oficial (egress fixo) e
 * devolve o texto formatado. Query vazia ⇒ aviso de uso (sem rede). Degradação:
 * registro fora ⇒ texto legível + exit 1 (a CLI segue viva).
 */
export async function runMcpSearch(query: string, fetch: RegistryFetch): Promise<McpSearchRun> {
  const q = query.trim();
  if (q.length === 0) {
    return {
      text:
        'uso: aluy mcp search <query>\n' +
        '  Busca servers MCP no registro oficial aberto (sem login). Ex.: aluy mcp search filesystem',
      exitCode: 2,
    };
  }
  const outcome = await searchRegistry(q, fetch);
  return { text: formatSearchOutcome(outcome), exitCode: outcome.ok ? 0 : 1 };
}
