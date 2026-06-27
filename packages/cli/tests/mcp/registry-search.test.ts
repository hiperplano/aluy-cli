// EST-0970 (search) — `aluy mcp search <query>` no @hiperplano/aluy-cli:
//   (1) parser: `mcp search <query…>` ⇒ action `mcp-search` (sem tocar add/list/remove);
//   (2) wiring: `createRegistryFetch` confina o egress ao host FIXO do registro
//       oficial e reusa o safeFetch (anti-SSRF) com SOCKET MOCKADO (sem rede real);
//       AG-0010: redirect cross-host (302→outro host) é BARRADO (maxRedirects:0) e
//       os hosts do search/DDG NÃO entram na allowlist dedicada (includeSearchHosts:false);
//   (3) `runMcpSearch` formata e degrada gracioso.
//
// FRUGAL: nenhuma rede real, nenhum modelo. O `PinnedFetcher` é um mock em memória.

import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli.js';
import { createRegistryFetch, runMcpSearch } from '../../src/mcp/registry-search.js';
import {
  MCP_REGISTRY_HOST,
  type HostResolver,
  type PinnedFetcher,
  type PinnedFetchArgs,
  type PinnedResponse,
  type RegistryFetch,
} from '@hiperplano/aluy-cli-core';

// ───────────────────────── (1) parser ─────────────────────────

describe('parseArgs — `mcp search`', () => {
  it('`mcp search filesystem` ⇒ mcp-search com a query', () => {
    const a = parseArgs(['mcp', 'search', 'filesystem']);
    expect(a.kind).toBe('mcp-search');
    if (a.kind !== 'mcp-search') return;
    expect(a.query).toBe('filesystem');
  });

  it('junta vários tokens posicionais na query', () => {
    const a = parseArgs(['mcp', 'search', 'github', 'mcp']);
    if (a.kind !== 'mcp-search') throw new Error('esperava mcp-search');
    expect(a.query).toBe('github mcp');
  });

  it('`mcp search` sem query ⇒ mcp-search com query vazia (a CLI mostra uso)', () => {
    const a = parseArgs(['mcp', 'search']);
    if (a.kind !== 'mcp-search') throw new Error('esperava mcp-search');
    expect(a.query).toBe('');
  });

  it('NÃO captura outros subcomandos de mcp (add/list/remove são de outra estória)', () => {
    // Sem o nosso branch, `mcp add` cai no fluxo default (launch) — provamos que o
    // search NÃO os intercepta (não vira mcp-search).
    expect(parseArgs(['mcp', 'add', 'x']).kind).not.toBe('mcp-search');
    expect(parseArgs(['mcp', 'list']).kind).not.toBe('mcp-search');
    expect(parseArgs(['mcp', 'remove', 'x']).kind).not.toBe('mcp-search');
  });

  it('`mcp search --help` ⇒ delega ao runner do mcp (help unificado), NÃO vira busca', () => {
    // Pós-merge com `mcp add/list/remove` (#81): o `--help` cai no handler genérico
    // `mcp` (que mostra o help do MCP via runner), não no help geral. O essencial é
    // que `--help` NÃO dispara uma busca (mcp-search).
    const action = parseArgs(['mcp', 'search', '--help']);
    expect(action.kind).not.toBe('mcp-search');
    expect(action.kind).toBe('mcp');
  });
});

// ──────────────────── (2) wiring: egress FIXO + safeFetch mockado ────────────────────

/** Resolver MOCK: resolve qualquer host p/ um IP público (não toca DNS real). */
const fakeResolver: HostResolver = {
  async resolve() {
    return ['93.184.216.34'];
  },
};

/** Fetcher pinado MOCK: devolve um corpo/STATUS canned, registra a URL pedida. */
function fakeFetcher(body: string, status = 200): PinnedFetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async fetchPinned(args: PinnedFetchArgs): Promise<PinnedResponse> {
      urls.push(args.url);
      return { status, body, contentType: 'application/json' };
    },
  };
}

/**
 * Fetcher pinado MOCK que RESPONDE 302 → `location` no 1º hop e 200 depois.
 * Simula um registro MITM/comprometido tentando desviar o egress p/ outro host.
 * Registra cada URL pedida p/ provarmos que o 2º host NUNCA é tocado.
 */
function redirectingFetcher(location: string): PinnedFetcher & { urls: string[] } {
  const urls: string[] = [];
  let hop = 0;
  return {
    urls,
    async fetchPinned(args: PinnedFetchArgs): Promise<PinnedResponse> {
      urls.push(args.url);
      if (hop++ === 0) {
        // 1º hop: o registro responde redirect p/ um host arbitrário.
        return { status: 302, location, body: '' };
      }
      // Se o search seguisse o redirect, cairia AQUI (corpo do atacante).
      return {
        status: 200,
        body: '{"servers":[],"metadata":{"count":0}}',
        contentType: 'application/json',
      };
    },
  };
}

const PAGE = JSON.stringify({
  servers: [
    {
      server: {
        name: 'io.github.mcp/filesystem',
        description: 'Filesystem access for the agent.',
        version: '1.0.0',
        packages: [
          {
            registryType: 'npm',
            identifier: '@mcp/server-filesystem',
            version: '1.0.0',
            runtimeHint: 'npx',
            transport: { type: 'stdio' },
          },
        ],
      },
    },
  ],
  metadata: { count: 1 },
});

describe('createRegistryFetch — egress FIXO no registro oficial (sem rede real)', () => {
  it('busca o host oficial e devolve o corpo (socket MOCKADO)', async () => {
    const fetcher = fakeFetcher(PAGE);
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher } });
    const res = await fetch(`https://${MCP_REGISTRY_HOST}/v0/servers?search=filesystem&limit=100`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe(200);
    expect(res.body).toContain('io.github.mcp/filesystem');
    // foi ao host fixo, uma vez:
    expect(fetcher.urls).toHaveLength(1);
    expect(new URL(fetcher.urls[0]!).hostname).toBe(MCP_REGISTRY_HOST);
  });

  it('NEGA qualquer host fora do registro oficial (egress fixo, default-deny)', async () => {
    const fetcher = fakeFetcher(PAGE);
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher } });
    const res = await fetch('https://evil.example.com/v0/servers');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('egress bloqueado');
    // nem chegou a abrir socket:
    expect(fetcher.urls).toHaveLength(0);
  });

  it('NÃO inclui os hosts do search (DDG) na allowlist dedicada — includeSearchHosts:false (AG-0010)', async () => {
    // Sem `includeSearchHosts:false`, os hosts do DuckDuckGo (backend do web_search)
    // entrariam silenciosamente nesta allowlist "dedicada". Provamos que NÃO entram:
    const fetcher = fakeFetcher(PAGE);
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher } });
    for (const ddg of ['duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com']) {
      const res = await fetch(`https://${ddg}/v0/servers`);
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.reason).toContain('egress bloqueado');
    }
    // nenhum host de busca chegou a abrir socket:
    expect(fetcher.urls).toHaveLength(0);
  });

  it('URL malformada ⇒ erro legível, sem socket', async () => {
    const fetcher = fakeFetcher(PAGE);
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher } });
    const res = await fetch('not a url');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('URL inválida');
    expect(fetcher.urls).toHaveLength(0);
  });

  // ── AG-0010 (CLI-SEC-5): redirect cross-host BARRADO (egress de fato fixo) ──

  it('302 → outro host NÃO é seguido (maxRedirects:0 ⇒ degrada, não puxa o atacante)', async () => {
    // Registro MITM/comprometido responde `302 → host-publico-atacante.com`.
    const fetcher = redirectingFetcher('https://host-publico-atacante.com/exfil');
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher } });
    const res = await fetch(`https://${MCP_REGISTRY_HOST}/v0/servers?search=x&limit=100`);
    // o redirect vira FALHA legível (degrada gracioso "registro indisponível"):
    expect(res.ok).toBe(false);
    // o SOCKET só tocou o host oficial UMA vez — o host do atacante NUNCA foi pedido:
    expect(fetcher.urls).toHaveLength(1);
    expect(new URL(fetcher.urls[0]!).hostname).toBe(MCP_REGISTRY_HOST);
    expect(fetcher.urls.some((u) => u.includes('host-publico-atacante.com'))).toBe(false);
  });

  it('redirect p/ outro host degrada o `mcp search` (exit 1), sem corpo do atacante', async () => {
    const fetcher = redirectingFetcher('https://host-publico-atacante.com/exfil');
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher } });
    const { exitCode, text } = await runMcpSearch('filesystem', fetch);
    expect(exitCode).toBe(1); // registro indisponível — CLI segue viva
    expect(text).toContain('⚠');
    // nada do corpo do atacante (que teria count:0/lista vazia) vaza como "nenhum server":
    expect(fetcher.urls).toHaveLength(1);
    expect(new URL(fetcher.urls[0]!).hostname).toBe(MCP_REGISTRY_HOST);
  });

  it('falha de socket (fetcher REJEITA) ⇒ degrada gracioso (não lança)', async () => {
    const failing: PinnedFetcher = {
      async fetchPinned() {
        throw new Error('ECONNREFUSED');
      },
    };
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher: failing } });
    const res = await fetch(`https://${MCP_REGISTRY_HOST}/v0/servers`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason.toLowerCase()).toContain('econnrefused');
  });
});

// ──────────────────── (3) runMcpSearch: ponta a ponta com fetch mockado ────────────────────

describe('runMcpSearch — orquestra busca + formato + exit code', () => {
  it('query com match ⇒ lista + comando de add, exit 0', async () => {
    const fetcher = fakeFetcher(PAGE);
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher } });
    const { text, exitCode } = await runMcpSearch('filesystem', fetch);
    expect(exitCode).toBe(0);
    expect(text).toContain('io.github.mcp/filesystem');
    expect(text).toContain('→ aluy mcp add filesystem -- npx -y @mcp/server-filesystem@1.0.0');
  });

  it('query SEM match ⇒ "nenhum server", exit 0', async () => {
    const fetcher = fakeFetcher(PAGE);
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher } });
    const { text, exitCode } = await runMcpSearch('inexistente-xyz', fetch);
    expect(exitCode).toBe(0);
    expect(text).toContain('nenhum server encontrado');
  });

  it('query vazia ⇒ mensagem de uso, exit 2, SEM rede', async () => {
    const fetch = vi.fn() as unknown as RegistryFetch;
    const { text, exitCode } = await runMcpSearch('   ', fetch);
    expect(exitCode).toBe(2);
    expect(text).toContain('uso: aluy mcp search');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('registro indisponível ⇒ aviso legível, exit 1 (CLI segue viva)', async () => {
    const failing: PinnedFetcher = {
      async fetchPinned() {
        throw new Error('timeout de 12000ms');
      },
    };
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher: failing } });
    const { text, exitCode } = await runMcpSearch('filesystem', fetch);
    expect(exitCode).toBe(1);
    expect(text).toContain('⚠');
    expect(text).toContain(MCP_REGISTRY_HOST);
  });
});
