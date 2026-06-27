// EST-0970 (search na sessão) — `/mcp search <termo>` DENTRO da sessão:
//   (1) parseMcpSlash: `/mcp` puro / arg desconhecido ⇒ null (LISTA, #81 intacto);
//       `search <termo>` ⇒ { query }; `search` sem termo ⇒ { query: '' } (uso, sem rede);
//   (2) runMcpSearchSlash: REUSA o `runMcpSearch` do #80 (egress fixo, socket mockado)
//       ⇒ nota com os servers + a linha `→ aluy mcp add …`; registro fora ⇒ degrada
//       gracioso (nota com aviso, NÃO lança — a sessão segue viva).
//
// FRUGAL: nenhuma rede real, nenhum modelo. O `PinnedFetcher` é um mock em memória.

import { describe, expect, it, vi } from 'vitest';
import {
  parseMcpSlash,
  mcpSearchUsageNote,
  mcpSearchPendingNote,
  runMcpSearchSlash,
} from '../../src/slash/handlers.js';
import { createRegistryFetch } from '../../src/mcp/registry-search.js';
import {
  MCP_REGISTRY_HOST,
  type HostResolver,
  type PinnedFetcher,
  type PinnedFetchArgs,
  type PinnedResponse,
  type RegistryFetch,
} from '@aluy/cli-core';

// ───────────────────────── (1) parseMcpSlash ─────────────────────────

describe('parseMcpSlash — só `search` vira busca; o resto continua LISTANDO (#81)', () => {
  it('`/mcp` sem args ⇒ null (lista os configurados, inalterado)', () => {
    expect(parseMcpSlash('')).toBeNull();
    expect(parseMcpSlash('   ')).toBeNull();
  });

  it('`/mcp search github` ⇒ { query: "github" }', () => {
    expect(parseMcpSlash('search github')).toEqual({ query: 'github' });
  });

  it('junta vários tokens na query', () => {
    expect(parseMcpSlash('search  github  mcp ')).toEqual({ query: 'github mcp' });
  });

  it('`/mcp search` sem termo ⇒ { query: "" } (o chamador mostra o uso, sem rede)', () => {
    expect(parseMcpSlash('search')).toEqual({ query: '' });
    expect(parseMcpSlash('search   ')).toEqual({ query: '' });
  });

  it('`search` é case-insensitive', () => {
    expect(parseMcpSlash('SEARCH github')).toEqual({ query: 'github' });
  });

  it('arg DESCONHECIDO (não-search) ⇒ null (não inventa subcomando; cai na listagem)', () => {
    expect(parseMcpSlash('add x')).toBeNull();
    expect(parseMcpSlash('list')).toBeNull();
    expect(parseMcpSlash('searching')).toBeNull(); // não confunde prefixo
  });
});

// ───────────────────────── infra de mock (socket em memória) ─────────────────────────

const fakeResolver: HostResolver = {
  async resolve() {
    return ['93.184.216.34'];
  },
};

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

const PAGE = JSON.stringify({
  servers: [
    {
      server: {
        name: 'io.github.mcp/github',
        description: 'GitHub access for the agent.',
        version: '1.0.0',
        packages: [
          {
            registryType: 'npm',
            identifier: '@mcp/server-github',
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

// ───────────────────────── (2) runMcpSearchSlash ─────────────────────────

describe('runMcpSearchSlash — reusa runMcpSearch (#80), nota na sessão', () => {
  it('`/mcp search github` (fetch mockado) ⇒ nota com os servers + a linha `aluy mcp add`', async () => {
    const fetcher = fakeFetcher(PAGE);
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher } });
    const note = await runMcpSearchSlash('github', fetch);
    const text = note.lines.join('\n');
    expect(note.title).toBe('mcp');
    expect(text).toContain('io.github.mcp/github');
    // a linha pronta p/ copiar (instalar é `aluy mcp add`, atrás da catraca — não aqui):
    expect(text).toContain('→ aluy mcp add github -- npx -y @mcp/server-github@1.0.0');
    // tocou o host FIXO uma vez (egress fixo do #80):
    expect(fetcher.urls).toHaveLength(1);
    expect(new URL(fetcher.urls[0]!).hostname).toBe(MCP_REGISTRY_HOST);
  });

  it('registro FORA ⇒ degrada gracioso (nota com ⚠ + host), NÃO lança (sessão viva)', async () => {
    const failing: PinnedFetcher = {
      async fetchPinned() {
        throw new Error('timeout de 12000ms');
      },
    };
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher: failing } });
    const note = await runMcpSearchSlash('github', fetch);
    const text = note.lines.join('\n');
    expect(note.title).toBe('mcp');
    expect(text).toContain('⚠');
    expect(text).toContain(MCP_REGISTRY_HOST);
  });

  it('query SEM match ⇒ nota "nenhum server" (não quebra)', async () => {
    const fetcher = fakeFetcher(PAGE);
    const fetch = createRegistryFetch({ ports: { resolver: fakeResolver, fetcher } });
    const note = await runMcpSearchSlash('inexistente-xyz', fetch);
    expect(note.lines.join('\n')).toContain('nenhum server encontrado');
  });
});

// ───────────────────────── notas INTERINAS (sem rede) ─────────────────────────

describe('notas auxiliares do `/mcp search` (sem rede)', () => {
  it('mcpSearchUsageNote ⇒ explica o uso (sem disparar busca)', () => {
    const note = mcpSearchUsageNote();
    expect(note.title).toBe('mcp');
    expect(note.lines.join('\n')).toContain('/mcp search <termo>');
  });

  it('mcpSearchPendingNote ⇒ "buscando…" com o termo', () => {
    const note = mcpSearchPendingNote('github');
    expect(note.lines.join('\n')).toContain('buscando "github"');
  });

  it('a nota de uso NÃO usa a porta de rede (uso é puro)', () => {
    const fetch = vi.fn() as unknown as RegistryFetch;
    mcpSearchUsageNote();
    expect(fetch).not.toHaveBeenCalled();
  });
});
