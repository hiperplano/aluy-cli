// EST-0970 (search) · CLI-SEC-5/12 — BUSCA no registro OFICIAL ABERTO do MCP.
//
// FRUGAL: SEM modelo, SEM rede real. A porta `RegistryFetch` é MOCKADA (devolve um
// corpo JSON canned). Cobre: match por nome/descrição/comando; "nenhum server";
// registro indisponível (erro/timeout) ⇒ degrada gracioso; resposta = DADO (parser
// tolerante, nada executado); derivação do comando p/ `aluy mcp add`.

import { describe, expect, it, vi } from 'vitest';
import {
  MCP_REGISTRY_HOST,
  MCP_REGISTRY_SERVERS_URL,
  addCommandFor,
  formatSearchOutcome,
  matchesQuery,
  parseServersPage,
  registryPageUrl,
  searchRegistry,
  suggestServerName,
  type RegistryFetch,
  type RegistryFetchResult,
} from '../../src/index.js';

/** Página canned do registro (formato real `{ servers:[{server,_meta}], metadata }`). */
function registryPage(servers: unknown[], nextCursor?: string): string {
  return JSON.stringify({
    servers,
    metadata: { count: servers.length, ...(nextCursor !== undefined ? { nextCursor } : {}) },
  });
}

const FS_SERVER = {
  server: {
    name: 'io.github.modelcontextprotocol/filesystem',
    title: 'Filesystem',
    description: 'Read and write files on the local filesystem within allowed roots.',
    version: '1.2.3',
    packages: [
      {
        registryType: 'npm',
        identifier: '@modelcontextprotocol/server-filesystem',
        version: '1.2.3',
        runtimeHint: 'npx',
        transport: { type: 'stdio' },
        packageArguments: [{ value: '/workspace', type: 'positional' }],
        environmentVariables: [{ name: 'FS_ROOT', isRequired: true }],
      },
    ],
  },
  _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } },
};

const GIT_SERVER = {
  server: {
    name: 'io.github.acme/git',
    description: 'Git operations via a Python MCP server.',
    version: '0.4.0',
    packages: [
      { registryType: 'pypi', identifier: 'mcp-server-git', version: '0.4.0', runtimeHint: 'uvx' },
    ],
  },
};

const REMOTE_ONLY = {
  server: {
    name: 'ac.inference.sh/mcp',
    description: 'Run 150+ AI apps remotely.',
    version: '1.0.1',
    remotes: [{ type: 'streamable-http', url: 'https://api.inference.sh/mcp' }],
  },
};

/** Porta MOCK: devolve o corpo dado p/ qualquer URL. Conta as chamadas. */
function mockFetch(body: string, status = 200): RegistryFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string): Promise<RegistryFetchResult> => {
    calls.push(url);
    return { ok: true, status, body };
  }) as unknown as RegistryFetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('registryPageUrl — egress FIXO no host oficial (sem key)', () => {
  it('aponta SEMPRE p/ o registro oficial, com search/limit', () => {
    const url = new URL(registryPageUrl('filesystem'));
    expect(url.hostname).toBe(MCP_REGISTRY_HOST);
    expect(url.pathname).toBe('/v0/servers');
    expect(url.searchParams.get('search')).toBe('filesystem');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(MCP_REGISTRY_SERVERS_URL).toContain(MCP_REGISTRY_HOST);
  });

  it('query vazia ⇒ sem param search (lista geral); cursor entra quando dado', () => {
    const url = new URL(registryPageUrl('', 'CUR'));
    expect(url.searchParams.has('search')).toBe(false);
    expect(url.searchParams.get('cursor')).toBe('CUR');
  });
});

describe('searchRegistry — fetch MOCKADO (sem rede real)', () => {
  it('"filesystem" ⇒ casa o server por nome/descrição + deriva o comando npx', async () => {
    const fetch = mockFetch(registryPage([FS_SERVER, GIT_SERVER]));
    const out = await searchRegistry('filesystem', fetch);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results).toHaveLength(1);
    const r = out.results[0]!;
    expect(r.name).toBe('io.github.modelcontextprotocol/filesystem');
    expect(r.description).toContain('Read and write files');
    expect(r.run.command).toBe('npx');
    // npx -y <pkg>@<versão> <pkgArgs>
    expect(r.run.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem@1.2.3',
      '/workspace',
    ]);
    expect(r.run.transport).toBe('stdio');
    expect(r.run.env).toEqual([{ name: 'FS_ROOT', required: true }]);
    // SÓ leitura: o mock devolveu DADO; nada foi "instalado"/executado.
    expect((fetch as unknown as { calls: string[] }).calls).toHaveLength(1);
  });

  it('casa pela DESCRIÇÃO mesmo quando o nome não bate ("python")', async () => {
    // "python" só aparece na descrição do GIT_SERVER (substring no nome do FS é
    // "github", que casaria "git" — por isso buscamos um termo só-da-descrição).
    const fetch = mockFetch(registryPage([FS_SERVER, GIT_SERVER]));
    const out = await searchRegistry('python', fetch);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results.map((r) => r.name)).toEqual(['io.github.acme/git']);
    expect(out.results[0]!.run.command).toBe('uvx'); // pypi ⇒ uvx
    expect(out.results[0]!.run.args).toEqual(['mcp-server-git']);
  });

  it('query SEM match ⇒ lista vazia (a CLI mostra "nenhum server")', async () => {
    const fetch = mockFetch(registryPage([FS_SERVER, GIT_SERVER]));
    const out = await searchRegistry('zzz-nao-existe', fetch);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results).toEqual([]);
  });

  it('registro indisponível (porta devolve erro) ⇒ degrada gracioso (não lança)', async () => {
    const fetch: RegistryFetch = async () => ({ ok: false, reason: 'ECONNREFUSED' });
    const out = await searchRegistry('filesystem', fetch);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('indisponível');
    expect(out.reason).toContain(MCP_REGISTRY_HOST);
  });

  it('timeout (porta REJEITA) ⇒ ainda degrada gracioso (blindagem)', async () => {
    const fetch: RegistryFetch = async () => {
      throw new Error('timeout de 12000ms');
    };
    const out = await searchRegistry('filesystem', fetch);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('timeout');
  });

  it('HTTP não-2xx ⇒ degrada gracioso', async () => {
    const fetch = mockFetch('{}', 503);
    const out = await searchRegistry('x', fetch);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('HTTP 503');
  });

  it('corpo não-JSON ⇒ degrada gracioso (não lança)', async () => {
    const fetch = mockFetch('<html>nope</html>');
    const out = await searchRegistry('x', fetch);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('JSON');
  });

  it('PAGINA via nextCursor até casar, com teto (não loopa infinito)', async () => {
    let page = 0;
    const fetch: RegistryFetch = async () => {
      page++;
      // 1ª página sem match + cursor; 2ª com o git e SEM cursor (fim).
      if (page === 1) return { ok: true, status: 200, body: registryPage([FS_SERVER], 'NEXT') };
      return { ok: true, status: 200, body: registryPage([GIT_SERVER]) };
    };
    const out = await searchRegistry('python', fetch);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results.map((r) => r.name)).toEqual(['io.github.acme/git']);
    expect(page).toBe(2);
  });

  it('resposta TORTA (campos ausentes) ⇒ ignora itens ruins, não derruba a página', async () => {
    const fetch = mockFetch(
      registryPage([{ server: { description: 'sem nome' } }, FS_SERVER, 42, null]),
    );
    const out = await searchRegistry('filesystem', fetch);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results).toHaveLength(1); // só o FS_SERVER válido casa.
  });
});

describe('parseServersPage — DADO_NÃO_CONFIÁVEL, parser tolerante', () => {
  it('não-objeto / servers ausente ⇒ vazio', () => {
    expect(parseServersPage(null).servers).toEqual([]);
    expect(parseServersPage({}).servers).toEqual([]);
    expect(parseServersPage(42).servers).toEqual([]);
  });

  it('extrai nextCursor de metadata quando string', () => {
    const p = parseServersPage({ servers: [], metadata: { nextCursor: 'ABC' } });
    expect(p.nextCursor).toBe('ABC');
  });

  it('server só-remoto ⇒ sem command, com remoteUrls', () => {
    const p = parseServersPage({ servers: [REMOTE_ONLY] });
    expect(p.servers).toHaveLength(1);
    const r = p.servers[0]!;
    expect(r.run.command).toBeUndefined();
    expect(r.run.remoteUrls).toEqual(['https://api.inference.sh/mcp']);
  });

  it('docker/oci ⇒ comando `docker run -i --rm <img>:<ver>`', () => {
    const p = parseServersPage({
      servers: [
        {
          server: {
            name: 'x/y',
            description: 'd',
            packages: [{ registryType: 'oci', identifier: 'ghcr.io/x/y', version: '2.0' }],
          },
        },
      ],
    });
    const r = p.servers[0]!;
    expect(r.run.command).toBe('docker');
    expect(r.run.args).toEqual(['run', '-i', '--rm', 'ghcr.io/x/y@2.0']);
  });
});

describe('matchesQuery — casa nome/título/descrição/comando (case-insensitive)', () => {
  const r = {
    name: 'io.github.foo/bar',
    title: 'Bar Tool',
    description: 'does things',
    run: { args: ['-y', '@foo/bar'], env: [], remoteUrls: [] },
  };
  it('query vazia casa tudo', () => expect(matchesQuery(r, '')).toBe(true));
  it('casa pelo comando/args', () => expect(matchesQuery(r, '@foo/bar')).toBe(true));
  it('casa pelo título (case-insensitive)', () => expect(matchesQuery(r, 'bar tool')).toBe(true));
  it('não casa o que não existe', () => expect(matchesQuery(r, 'nope')).toBe(false));
});

describe('addCommandFor / suggestServerName — LIGAÇÃO com `aluy mcp add`', () => {
  it('monta `aluy mcp add <nome> -- <command> <args>`', () => {
    const r = parseServersPage({ servers: [FS_SERVER] }).servers[0]!;
    const cmd = addCommandFor(r);
    expect(cmd).toBe(
      'aluy mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem@1.2.3 /workspace',
    );
  });

  it('nome lógico = tail do nome canônico, saneado', () => {
    expect(suggestServerName('io.github.foo/bar-server')).toBe('bar-server');
    expect(suggestServerName('weird name!!')).toBe('weird-name');
    expect(suggestServerName('///')).toBe('server');
  });

  it('server só-remoto ⇒ sem comando de add', () => {
    const r = parseServersPage({ servers: [REMOTE_ONLY] }).servers[0]!;
    expect(addCommandFor(r)).toBeUndefined();
  });
});

describe('formatSearchOutcome — saída legível p/ a CLI (nada executado)', () => {
  it('lista com o "→ aluy mcp add" pronto p/ copiar', async () => {
    const fetch = mockFetch(registryPage([FS_SERVER]));
    const out = await searchRegistry('filesystem', fetch);
    const text = formatSearchOutcome(out);
    expect(text).toContain('io.github.modelcontextprotocol/filesystem');
    expect(text).toContain('→ aluy mcp add filesystem -- npx -y');
    expect(text).toContain('requer env: FS_ROOT');
    expect(text).toContain('nada é executado pela busca');
  });

  it('zero resultados ⇒ "nenhum server encontrado"', () => {
    const text = formatSearchOutcome({ ok: true, query: 'zzz', results: [] });
    expect(text).toContain('nenhum server encontrado');
    expect(text).toContain('zzz');
  });

  it('degradação ⇒ aviso legível, sem stack', () => {
    const text = formatSearchOutcome({
      ok: false,
      query: 'x',
      reason: 'registro MCP indisponível (host): timeout',
    });
    expect(text).toContain('⚠');
    expect(text).toContain('indisponível');
    expect(text).not.toContain('Error:');
  });
});
