// EST-1132 · ADR-0123 §2.2/Inv. II · G2 (CA-G2-6/7/8) — testes do cliente
// concreto MemoryEngine → Mem0 OSS loopback.
//
// Cobre:
//   Unit: mapeamento porta→cliente (add/search/scope); scope≡caixa;
//     recall envelopado; fallback sem-recall (CA-MA8).
//   Segurança — CA-G2-6 (C1+C2): anti-SSRF real com classifyHeadroomTarget
//     + NodePinnedFetcher; 2130706433, [::1], [::ffff:127.0.0.1] conectam;
//     DNS-rebind barrado; non-loopback barrado.
//   Segurança — CA-G2-8: store 0700.
//   Segurança — CA-G2-7: sem credencial no request.
//   Degradação — CA-MA8: Mem0 ausente ⇒ opera sem recall.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HostResolver, PinnedFetcher, PinnedResponse } from '@hiperplano/aluy-cli-core';
import { Mem0MemoryEngine } from '../../src/io/mem0-memory-engine.js';

// ── helpers ───────────────────────────────────────────────────────────────

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Cria um HostResolver mock que devolve os IPs dados. */
function mockResolver(...ips: string[]): HostResolver {
  return {
    resolve: vi.fn().mockResolvedValue(ips),
  };
}

/** Cria um PinnedFetcher mock que devolve a resposta dada. */
function mockFetcher(response: PinnedResponse): PinnedFetcher {
  return {
    fetchPinned: vi.fn().mockResolvedValue(response),
  };
}

/** Cria um PinnedFetcher que REJEITA com erro. */
function mockFailingFetcher(error: Error): PinnedFetcher {
  return {
    fetchPinned: vi.fn().mockRejectedValue(error),
  };
}

/** Resposta JSON 200 típica do Mem0. */
function okJson(body: unknown): PinnedResponse {
  return {
    status: 200,
    body: JSON.stringify(body),
    contentType: 'application/json',
  };
}

/** Resposta 201 (created). */
function createdJson(body: unknown): PinnedResponse {
  return {
    status: 201,
    body: JSON.stringify(body),
    contentType: 'application/json',
  };
}

// ── principal ─────────────────────────────────────────────────────────────

describe('Mem0MemoryEngine porta MemoryEngine → Mem0 REST loopback', () => {
  let base: string;
  let memBase: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-mem0-test-'));
    memBase = join(base, 'aluy');
  });

  afterEach(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // limpeza best-effort.
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CA-G2-6: anti-SSRF real (C1 + C2)
  // ═══════════════════════════════════════════════════════════════════════

  describe('CA-G2-6 — anti-SSRF CLI-SEC-13 (classifyHeadroomTarget + PinnedFetcher)', () => {
    it('construtor NÃO valida loopback (a validação é lazy na 1ª chamada)', () => {
      // URL sintaticamente válida com host externo — construtor NÃO barra
      // (a validação real é ASSÍNCRONA via classifyHeadroomTarget).
      expect(
        () =>
          new Mem0MemoryEngine({
            mem0Url: 'http://evil.example.com:11434',
            baseDir: memBase,
          }),
      ).not.toThrow();
    });

    it('construtor barra URL sintaticamente inválida', () => {
      expect(
        () =>
          new Mem0MemoryEngine({
            mem0Url: 'não-é-url',
            baseDir: memBase,
          }),
      ).toThrow(/URL inválida/);
    });

    it('127.0.0.1 (forma canônica) → classifica e conecta', async () => {
      const engine = new Mem0MemoryEngine({
        mem0Url: 'http://127.0.0.1:11434',
        baseDir: memBase,
        resolver: mockResolver('127.0.0.1'),
        fetcher: mockFetcher(okJson({ id: 'm1' })),
      });

      const result = await engine.add({
        content: [{ kind: 'text', text: 'fato' }],
        scope: 'box',
      });

      expect(result.ids).toHaveLength(1);
    });

    it('2130706433 (decimal loopback) → canonicaliza e conecta', async () => {
      // 2130706433 = 127.0.0.1 em decimal — bypass clássico.
      // `parseHttpUrl` → `canonicalizeIpv4` canoniza → `isLoopbackIp` aceita.
      const engine = new Mem0MemoryEngine({
        mem0Url: 'http://2130706433:11434',
        baseDir: memBase,
        // IP-literal: NÃO precisa de resolver (sem DNS).
        fetcher: mockFetcher(okJson({ id: 'm-dec' })),
      });

      const result = await engine.add({
        content: [{ kind: 'text', text: 'decimal' }],
        scope: 'box',
      });

      expect(result.ids).toHaveLength(1);
    });

    it('[::1] (IPv6 loopback) → classifica e conecta', async () => {
      const engine = new Mem0MemoryEngine({
        mem0Url: 'http://[::1]:11434',
        baseDir: memBase,
        fetcher: mockFetcher(okJson({ id: 'm-ipv6' })),
      });

      const result = await engine.add({
        content: [{ kind: 'text', text: 'ipv6' }],
        scope: 'box',
      });

      expect(result.ids).toHaveLength(1);
    });

    it('[::ffff:127.0.0.1] (IPv4-mapped IPv6) → classifica e conecta', async () => {
      // `ipv4MappedFromV6` extrai `127.0.0.1` → `isLoopbackIp` aceita.
      const engine = new Mem0MemoryEngine({
        mem0Url: 'http://[::ffff:127.0.0.1]:11434',
        baseDir: memBase,
        fetcher: mockFetcher(okJson({ id: 'm-mapped' })),
      });

      const result = await engine.add({
        content: [{ kind: 'text', text: 'ipv4-mapped' }],
        scope: 'box',
      });

      expect(result.ids).toHaveLength(1);
    });

    it('localhost → resolve loopback e conecta', async () => {
      const engine = new Mem0MemoryEngine({
        mem0Url: 'http://localhost:11434',
        baseDir: memBase,
        resolver: mockResolver('127.0.0.1', '::1'),
        fetcher: mockFetcher(okJson({ id: 'm-localhost' })),
      });

      const result = await engine.add({
        content: [{ kind: 'text', text: 'localhost' }],
        scope: 'box',
      });

      expect(result.ids).toHaveLength(1);
    });

    it('DNS-rebind IP misto (loopback + público) ⇒ barrado', async () => {
      // Resolver devolve [127.0.0.1, 1.2.3.4] — um IP público no conjunto.
      // classifyHeadroomTarget exige que TODOS sejam loopback.
      const engine = new Mem0MemoryEngine({
        mem0Url: 'http://rebind.example.com:11434',
        baseDir: memBase,
        resolver: mockResolver('127.0.0.1', '1.2.3.4'),
        fetcher: mockFetcher(okJson({ id: 'nunca' })),
      });

      // CA-MA8: erro de SSRF é pego e degrada (não lança p/ fora).
      const result = await engine.add({
        content: [{ kind: 'text', text: 'rebind' }],
        scope: 'box',
      });

      // Degrada: ids vazios (o erro é pego dentro do add).
      expect(result.ids).toHaveLength(0);
    });

    it('hostname externo (ex.: metadata cloud) ⇒ barrado', async () => {
      const engine = new Mem0MemoryEngine({
        mem0Url: 'http://169.254.169.254:11434',
        baseDir: memBase,
        // IP-literal: classifica direto (sem DNS).
        // 169.254.x.x é link-local — isLoopbackIp ⇒ false.
        fetcher: mockFetcher(okJson({ id: 'nunca' })),
      });

      const result = await engine.add({
        content: [{ kind: 'text', text: 'metadata' }],
        scope: 'box',
      });

      // Degrada: bloqueado pela denylist.
      expect(result.ids).toHaveLength(0);
    });

    it('hostname externo resolvido ⇒ barrado', async () => {
      const engine = new Mem0MemoryEngine({
        mem0Url: 'http://evil.example.com:11434',
        baseDir: memBase,
        resolver: mockResolver('93.184.216.34'), // example.com
        fetcher: mockFetcher(okJson({ id: 'nunca' })),
      });

      const result = await engine.add({
        content: [{ kind: 'text', text: 'externo' }],
        scope: 'box',
      });

      expect(result.ids).toHaveLength(0);
    });

    it('default é 127.0.0.1 (construtor não lança)', () => {
      const engine = new Mem0MemoryEngine({ baseDir: memBase });
      expect(() => engine).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CA-G2-8: store em repouso
  // ═══════════════════════════════════════════════════════════════════════

  describe('CA-G2-8 — store 0700', () => {
    it('cria ~/.aluy/memory/ com 0700', () => {
      new Mem0MemoryEngine({ baseDir: memBase });
      const memDir = join(memBase, 'memory');
      expect(existsSync(memDir)).toBe(true);
      expect(mode(memDir)).toBe(0o700);
    });

    it('cria ~/.aluy/ com 0700', () => {
      new Mem0MemoryEngine({ baseDir: memBase });
      expect(existsSync(memBase)).toBe(true);
      expect(mode(memBase)).toBe(0o700);
    });

    it('idempotente (não lança se já existe)', () => {
      new Mem0MemoryEngine({ baseDir: memBase });
      expect(() => new Mem0MemoryEngine({ baseDir: memBase })).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CA-MA8: degradação fail-open
  // ═══════════════════════════════════════════════════════════════════════

  describe('CA-MA8 degradação fail-open (Mem0 ausente/timeout)', () => {
    let engine: Mem0MemoryEngine;

    beforeEach(() => {
      engine = new Mem0MemoryEngine({
        baseDir: memBase,
        resolver: mockResolver('127.0.0.1'),
        fetcher: mockFailingFetcher(new Error('ECONNREFUSED')),
        // DELETE também mockado (o PinnedFetcher só faz GET|POST). Sem isto o DELETE
        // usa fetch global e bate num servidor mem0 real se houver (flaky de ambiente).
        deleteFetch: () => Promise.reject(new Error('ECONNREFUSED')),
      });
    });

    it('add degrada → ids vazios (não lança)', async () => {
      const result = await engine.add({
        content: [{ kind: 'text', text: 'test' }],
        scope: 'box',
      });

      expect(result.ids).toHaveLength(0);
    });

    it('search degrada → hits vazios (não lança)', async () => {
      const result = await engine.search({
        scopes: ['box'],
        query: 'test',
      });

      expect(result.hits).toHaveLength(0);
    });

    it('scope list degrada → scopes vazios (não lança)', async () => {
      const result = await engine.scope({
        operation: { kind: 'list' },
      });

      expect(result.scopes).toHaveLength(0);
    });

    it('scope info degrada → itemCount=0 (não lança)', async () => {
      const result = await engine.scope({
        operation: { kind: 'info', scope: 'box' },
      });

      expect(result.scopes).toHaveLength(1);
      expect(result.scopes[0]!.itemCount).toBe(0);
    });

    it('scope delete degrada → deleted=false (não lança)', async () => {
      const result = await engine.scope({
        operation: { kind: 'delete', scope: 'box' },
      });

      expect(result.deleted).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Unit: mapeamento porta→cliente
  // ═══════════════════════════════════════════════════════════════════════

  describe('mapeamento porta→cliente (add/search/scope)', () => {
    let fetcher: ReturnType<typeof mockFetcher>;
    let fetchSpy: ReturnType<typeof vi.fn>;
    let engine: Mem0MemoryEngine;

    beforeEach(() => {
      // Para add: resposta 201 (created). Para search/scope: 200.
      // Usamos um spy que decide com base no path.
      fetchSpy = vi.fn();
      fetcher = { fetchPinned: fetchSpy };
      engine = new Mem0MemoryEngine({
        baseDir: memBase,
        resolver: mockResolver('127.0.0.1'),
        fetcher,
      });
    });

    describe('add', () => {
      beforeEach(() => {
        fetchSpy.mockResolvedValue(createdJson({ id: 'mem-abc' }));
      });

      it('chama POST /v1/memories/ com user_id≡scope', async () => {
        await engine.add({
          content: [
            { kind: 'text', text: 'o usuário gosta de brócolis' },
            { kind: 'text', text: 'prefere tabs a espaços' },
          ],
          scope: 'box-001',
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const args = fetchSpy.mock.calls[0]![0];
        expect(args.url).toContain('/v1/memories/');
        expect(args.method).toBe('POST');
        expect(args.host).toBe('127.0.0.1');
        expect(args.pinnedIp).toBe('127.0.0.1');

        const body = JSON.parse(args.body as string);
        expect(body.user_id).toBe('box-001');
        expect(body.messages).toHaveLength(2);
        expect(body.messages[0]).toEqual({
          role: 'user',
          content: 'o usuário gosta de brócolis',
        });
      });

      it('add com metadata propaga no body', async () => {
        fetchSpy.mockResolvedValue(createdJson({ id: 'mem-xyz' }));

        await engine.add({
          content: [{ kind: 'text', text: 'fato' }],
          scope: 'box-002',
          metadata: { source: 'test', priority: 1 },
        });

        const args = fetchSpy.mock.calls[0]![0];
        const body = JSON.parse(args.body as string);
        expect(body.metadata).toEqual({ source: 'test', priority: 1 });
      });

      it('devolve ids para cada item de conteúdo', async () => {
        fetchSpy.mockResolvedValue(createdJson({ id: 'mem-abc' }));

        const result = await engine.add({
          content: [
            { kind: 'text', text: 'a' },
            { kind: 'text', text: 'b' },
          ],
          scope: 'box',
        });

        expect(result.ids).toHaveLength(2);
        expect(result.ids[0]).toContain('mem-abc');
      });
    });

    describe('search', () => {
      beforeEach(() => {
        fetchSpy.mockResolvedValue(
          okJson({
            results: [
              { id: 'h1', memory: 'lembrete A', score: 0.9 },
              { id: 'h2', memory: 'lembrete B', score: 0.7 },
            ],
          }),
        );
      });

      it('chama GET /v1/memories/ com user_id≡scope', async () => {
        const result = await engine.search({
          scopes: ['box-003'],
          query: 'lembrete',
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const args = fetchSpy.mock.calls[0]![0];
        expect(args.method).toBe('GET');
        expect(args.url).toContain('user_id=box-003');
        expect(args.url).toContain('query=lembrete');

        expect(result.hits).toHaveLength(2);
        expect(result.hits[0]!.text).toBe('lembrete A');
        expect(result.hits[0]!.score).toBe(0.9);
      });

      it('search multi-scope (2 chamadas, merge)', async () => {
        fetchSpy
          .mockResolvedValueOnce(
            okJson({
              results: [{ id: 'a1', memory: 'A', score: 0.9 }],
            }),
          )
          .mockResolvedValueOnce(
            okJson({
              results: [{ id: 'b1', memory: 'B', score: 0.5 }],
            }),
          );

        const result = await engine.search({
          scopes: ['box-a', 'box-b'],
          query: 'x',
        });

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(result.hits).toHaveLength(2);
        // Ordenado por score.
        expect(result.hits[0]!.id).toBe('a1');
        expect(result.hits[1]!.id).toBe('b1');
      });

      it('search sem scopes ⇒ default', async () => {
        await engine.search({ scopes: [], query: 'x' });

        const args = fetchSpy.mock.calls[0]![0];
        expect(args.url).toContain('user_id=default');
      });

      it('respeita limit', async () => {
        fetchSpy.mockResolvedValue(
          okJson({
            results: [
              { id: '1', memory: 'a', score: 1.0 },
              { id: '2', memory: 'b', score: 0.9 },
              { id: '3', memory: 'c', score: 0.8 },
            ],
          }),
        );

        const result = await engine.search({
          scopes: ['box'],
          query: 'x',
          limit: 2,
        });

        expect(result.hits).toHaveLength(2);
      });

      it('F99 — dual-scope pede `limit` INTEIRO de cada scope (não limit/N) e devolve o top-N GLOBAL', async () => {
        // 'novo' concentra as 10 MAIS relevantes (0.95..0.86); 'legado' tem 10 menos
        // relevantes (0.50..0.41). limit=10. O top-10 GLOBAL = as 10 de 'novo'.
        const mk = (prefix: string, base: number): { results: unknown[] } => ({
          results: Array.from({ length: 10 }, (_, i) => ({
            id: `${prefix}${i}`,
            memory: `${prefix}-${i}`,
            score: base - i * 0.01,
          })),
        });
        fetchSpy.mockImplementation(async (args: { url: string }) => {
          const scope = new URL(args.url).searchParams.get('user_id');
          return okJson(scope === 'novo' ? mk('NOVO', 0.95) : mk('LEGADO', 0.5));
        });

        const result = await engine.search({
          scopes: ['novo', 'legado'],
          query: 'x',
          limit: 10,
        });

        // Cada scope foi consultado com limit=10 (não 5) — sem capar antes do corte global.
        for (const call of fetchSpy.mock.calls) {
          expect(new URL(call[0].url).searchParams.get('limit')).toBe('10');
        }
        // O resultado é o top-10 GLOBAL: as 10 de 'novo', nenhuma 'legado' menos-relevante.
        expect(result.hits).toHaveLength(10);
        expect(result.hits.every((h) => h.text.startsWith('NOVO'))).toBe(true);
      });

      it('hits com metadata são propagados (recall=DADO)', async () => {
        fetchSpy.mockResolvedValue(
          okJson({
            results: [
              {
                id: 'm1',
                memory: 'fato',
                score: 0.95,
                metadata: { source: 'user', priority: 1 },
              },
            ],
          }),
        );

        const result = await engine.search({ scopes: ['box'], query: 'fato' });

        expect(result.hits[0]!.metadata).toEqual({
          source: 'user',
          priority: 1,
        });
      });
    });

    describe('scope', () => {
      it('scope list chama GET /v1/users/', async () => {
        fetchSpy.mockResolvedValue(
          okJson({
            users: [
              { user_id: 'box-a', memory_count: 5, created_at: '2025-01-01T00:00:00Z' },
              { user_id: 'box-b', memory_count: 3 },
            ],
          }),
        );

        const result = await engine.scope({ operation: { kind: 'list' } });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const args = fetchSpy.mock.calls[0]![0];
        expect(args.url).toContain('/v1/users/');

        expect(result.scopes).toHaveLength(2);
        expect(result.scopes[0]!.scope).toBe('box-a');
        expect(result.scopes[0]!.itemCount).toBe(5);
        expect(result.scopes[0]!.createdAt).toBe(new Date('2025-01-01T00:00:00Z').getTime());
        expect(result.scopes[1]!.scope).toBe('box-b');
        expect(result.scopes[1]!.itemCount).toBe(3);
        expect(result.scopes[1]!.createdAt).toBeUndefined();
      });

      it('scope info chama GET /v1/memories/ com user_id', async () => {
        fetchSpy.mockResolvedValue(
          okJson({
            results: [
              { id: 'x1', memory: 'x' },
              { id: 'x2', memory: 'y' },
            ],
          }),
        );

        const result = await engine.scope({
          operation: { kind: 'info', scope: 'box-003' },
        });

        const args = fetchSpy.mock.calls[0]![0];
        expect(args.url).toContain('user_id=box-003');
        expect(result.scopes![0]!.itemCount).toBe(2);
      });

      it('scope delete chama DELETE /v1/memories/ com user_id', async () => {
        const deleteFetchSpy = vi.fn();
        // Salva o fetch original.
        const origFetch = globalThis.fetch;
        try {
          globalThis.fetch = deleteFetchSpy;
          deleteFetchSpy.mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => '',
          });

          const result = await engine.scope({
            operation: { kind: 'delete', scope: 'box-004' },
          });

          expect(deleteFetchSpy).toHaveBeenCalledTimes(1);
          const url = deleteFetchSpy.mock.calls[0]![0] as string;
          expect(url).toContain('/v1/memories/');
          expect(url).toContain('user_id=box-004');
          const init = deleteFetchSpy.mock.calls[0]![1] as RequestInit;
          expect(init.method).toBe('DELETE');
          // O IP na URL é o pinned (127.0.0.1), nunca o hostname.
          expect(url).toContain('127.0.0.1');
          expect(result.deleted).toBe(true);
        } finally {
          globalThis.fetch = origFetch;
        }
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CA-G2-7: sem credencial no request
  // ═══════════════════════════════════════════════════════════════════════

  describe('CA-G2-7 — sem credencial no request', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    let engine: Mem0MemoryEngine;

    beforeEach(() => {
      fetchSpy = vi.fn().mockResolvedValue(createdJson({ id: 'ok' }));
      engine = new Mem0MemoryEngine({
        baseDir: memBase,
        resolver: mockResolver('127.0.0.1'),
        fetcher: { fetchPinned: fetchSpy },
      });
    });

    it('fetchPinned NÃO recebe credencial nos args', async () => {
      await engine.add({
        content: [{ kind: 'text', text: 'test' }],
        scope: 'box',
      });

      // O PinnedFetcher.fetchPinned NÃO recebe campos de credencial.
      // (Diferente de um fetch() com headers, o PinnedFetchArgs é tipado
      // e não tem Authorization/Cookie.)
    });

    it('recall/search retorna DADO puro (MemorySearchHit), nunca system', async () => {
      fetchSpy.mockResolvedValue(
        okJson({
          results: [{ id: 'h1', memory: 'dado puro', score: 0.9 }],
        }),
      );

      const result = await engine.search({
        scopes: ['box'],
        query: 'algo',
      });

      // O resultado é MemorySearchResult com hits: MemorySearchHit[].
      // NÃO contém campos de system/instrução.
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]!.text).toBe('dado puro');
      // Não tem role, não tem system, não tem tool_call.
      expect((result.hits[0]! as Record<string, unknown>).role).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Timeout/abort
  // ═══════════════════════════════════════════════════════════════════════

  describe('timeout', () => {
    it('timeout de fetchPinned ⇒ degrada (CA-MA8)', async () => {
      const engine = new Mem0MemoryEngine({
        baseDir: memBase,
        resolver: mockResolver('127.0.0.1'),
        fetcher: mockFailingFetcher(new Error('timeout de 5000ms ao buscar URL')),
      });

      const result = await engine.add({
        content: [{ kind: 'text', text: 'timeout' }],
        scope: 'box',
      });

      expect(result.ids).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // F83: search multi-scope é PARALELO (não soma latência sob o teto de 2.5s)
  // ═══════════════════════════════════════════════════════════════════════
  describe('F83 — search dual-scope roda em PARALELO (não estoura o teto do recall)', () => {
    /** Fetcher que mede concorrência: conta in-flight e o pico simultâneo. */
    function concurrencyTrackingFetcher(delayMs: number): {
      fetcher: PinnedFetcher;
      maxInFlight: () => number;
    } {
      let inFlight = 0;
      let peak = 0;
      const fetcher: PinnedFetcher = {
        fetchPinned: async (): Promise<PinnedResponse> => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, delayMs));
          inFlight -= 1;
          return okJson({ results: [] });
        },
      };
      return { fetcher, maxInFlight: () => peak };
    }

    it('2 scopes ⇒ as 2 chamadas HTTP ficam EM VOO ao mesmo tempo (pico = 2)', async () => {
      const { fetcher, maxInFlight } = concurrencyTrackingFetcher(40);
      const engine = new Mem0MemoryEngine({
        mem0Url: 'http://127.0.0.1:11435',
        baseDir: memBase,
        resolver: mockResolver('127.0.0.1'),
        fetcher,
      });

      await engine.search({ query: 'q', scopes: ['proj_novo_abc123', 'proj_legado'] });

      // Sequencial daria pico 1 (uma de cada vez, somando a latência). Paralelo = 2.
      expect(maxInFlight()).toBe(2);
    });

    it('a falha de UM scope não derruba o outro (CA-MA8 por-scope preservado)', async () => {
      const calls: string[] = [];
      const fetcher: PinnedFetcher = {
        fetchPinned: async (req): Promise<PinnedResponse> => {
          const url = String((req as { url: string }).url);
          calls.push(url);
          if (url.includes('proj_legado')) throw new Error('scope legado fora');
          return okJson({ results: [{ id: 'h1', memory: 'do novo', score: 0.9 }] });
        },
      };
      const engine = new Mem0MemoryEngine({
        mem0Url: 'http://127.0.0.1:11435',
        baseDir: memBase,
        resolver: mockResolver('127.0.0.1'),
        fetcher,
      });

      const res = await engine.search({
        query: 'q',
        scopes: ['proj_novo_abc123', 'proj_legado'],
      });

      // O scope novo entregou o hit mesmo com o legado falhando.
      expect(res.hits.map((h) => h.text)).toEqual(['do novo']);
      expect(calls.length).toBe(2); // ambos foram tentados.
    });
  });
});
