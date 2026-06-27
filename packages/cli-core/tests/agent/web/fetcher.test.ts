// EST-1014 — endurece cobertura de packages/cli-core/src/agent/web/fetcher.ts:
//   (1) REDIRECT com Location inválido (resolveLocation retorna undefined)
//   (2) TETO de redirects excedido (loop termina sem resposta final)
//
// Reusa o mesmo harness de mocks do web-ssrf.test.ts: resolverReturning e
// recordingFetcher, safeFetch, tipos etc.

import { describe, expect, it } from 'vitest';
import {
  safeFetch,
  type HostResolver,
  type PinnedFetcher,
  type PinnedFetchArgs,
  type PinnedResponse,
  type SafeFetcherPorts,
} from '../../../src/index.js';

// ── helpers de mock (mesmo padrão do web-ssrf.test.ts) ────────────────────────

function resolverReturning(map: Record<string, string[]>): HostResolver {
  return {
    resolve: async (host) => {
      const ips = map[host];
      if (!ips) throw new Error(`NXDOMAIN ${host}`);
      return ips;
    },
  };
}

function recordingFetcher(responder: (args: PinnedFetchArgs) => PinnedResponse): {
  fetcher: PinnedFetcher;
  connectedIps: string[];
} {
  const connectedIps: string[] = [];
  const fetcher: PinnedFetcher = {
    fetchPinned: async (args) => {
      connectedIps.push(args.pinnedIp);
      return responder(args);
    },
  };
  return { fetcher, connectedIps };
}

// ── testes alvo: cobertura endurecida ─────────────────────────────────────────

describe('EST-1014 — endurance de fetcher.ts (redirect + teto)', () => {
  describe('(1) REDIRECT com Location inválido', () => {
    it('Location vazio (string "") ⇒ { ok: false, reason contendo Location inválido }', async () => {
      // O 1º hop devolve 302 com location vazio — o resolveLocation recebe ""
      // e new URL("", base) resolve corretamente para a base, então não cai no
      // catch. Precisamos de algo que FAÇA new URL(location, base) lançar.
      // Vamos usar location: "http://" — que é uma URL inválida (falta host).
      const responder = (args: PinnedFetchArgs): PinnedResponse => {
        if (args.url.includes('hop1.public')) {
          return { status: 302, location: 'http://', body: '' };
        }
        return { status: 200, body: 'ok' };
      };
      const { fetcher, connectedIps } = recordingFetcher(responder);
      const ports: SafeFetcherPorts = {
        resolver: resolverReturning({ 'hop1.public': ['93.184.216.34'] }),
        fetcher,
      };
      const r = await safeFetch('http://hop1.public/', ports);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain('Location inválido');
        expect(r.url).toBe('http://hop1.public/');
      }
      expect(connectedIps).toEqual(['93.184.216.34']); // 1º hop conectou
    });

    it('Location com espaço no host (http://a b.com/) ⇒ { ok:false, reason contendo Location inválido }', async () => {
      // new URL rejeita espaço no hostname.
      const responder = (args: PinnedFetchArgs): PinnedResponse => {
        if (args.url.includes('hop2.public')) {
          return { status: 302, location: 'http://a b.com/', body: '' };
        }
        return { status: 200, body: 'ok' };
      };
      const { fetcher } = recordingFetcher(responder);
      const ports: SafeFetcherPorts = {
        resolver: resolverReturning({ 'hop2.public': ['8.8.8.8'] }),
        fetcher,
      };
      const r = await safeFetch('http://hop2.public/', ports);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain('Location inválido');
      }
    });

    it('Location com IPv6 malformado (http://[::1) ⇒ { ok:false, reason contendo Location inválido }', async () => {
      // new URL rejeita colchete sem fechar.
      const responder = (args: PinnedFetchArgs): PinnedResponse => {
        if (args.url.includes('hop3.public')) {
          return { status: 302, location: 'http://[::1', body: '' };
        }
        return { status: 200, body: 'ok' };
      };
      const { fetcher } = recordingFetcher(responder);
      const ports: SafeFetcherPorts = {
        resolver: resolverReturning({ 'hop3.public': ['1.1.1.1'] }),
        fetcher,
      };
      const r = await safeFetch('http://hop3.public/', ports);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain('Location inválido');
      }
    });
  });

  describe('(2) TETO de redirects excedido', () => {
    it('maxRedirects=1 com 2 redirects consecutivos ⇒ { ok:false, reason contendo "teto" ou "redirects" }', async () => {
      // Cada hop devolve 302 → next (valida publico, então só o teto barra)
      const responder = (): PinnedResponse => {
        return {
          status: 302,
          location: 'http://loop.public/step',
          body: '',
        };
      };
      const { fetcher, connectedIps } = recordingFetcher(responder);
      const ports: SafeFetcherPorts = {
        resolver: resolverReturning({ 'loop.public': ['93.184.216.34'] }),
        fetcher,
      };
      const r = await safeFetch('http://loop.public/', ports, { maxRedirects: 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toMatch(/teto|redirects/i);
        expect(r.url).toBe('http://loop.public/step');
      }
      // Com maxRedirects=1, o loop permite hops 0 e 1; o hop 1 devolve redirect,
      // então tenta hop 2 (que excede o teto). Conectou só pros 2 primeiros.
      expect(connectedIps.length).toBe(2);
    });

    it('maxRedirects=0 (nenhum redirect permitido) + 1 redirect ⇒ { ok:false, reason contendo "teto" ou "redirects" }', async () => {
      const responder = (): PinnedResponse => ({
        status: 302,
        location: 'http://other.public/',
        body: '',
      });
      const { fetcher, connectedIps } = recordingFetcher(responder);
      const ports: SafeFetcherPorts = {
        resolver: resolverReturning({ 'first.public': ['8.8.8.8'] }),
        fetcher,
      };
      const r = await safeFetch('http://first.public/', ports, { maxRedirects: 0 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toMatch(/teto|redirects|redirect|loop/i);
      }
      // Só um hop foi conectado (o 1º, que devolveu redirect)
      expect(connectedIps.length).toBe(1);
    });

    it('maxRedirects=2 com redirect que sempre aponta para o mesmo destino (loop infinito) ⇒ { ok:false, reason contendo "teto" ou "redirects" }', async () => {
      // Loop redirect: cada hop devolve 302 → ele mesmo (ciclo)
      const responder = (): PinnedResponse => ({
        status: 302,
        location: 'http://selfloop.public/',
        body: '',
      });
      const { fetcher, connectedIps } = recordingFetcher(responder);
      const ports: SafeFetcherPorts = {
        resolver: resolverReturning({ 'selfloop.public': ['1.1.1.1'] }),
        fetcher,
      };
      const r = await safeFetch('http://selfloop.public/', ports, { maxRedirects: 2 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toMatch(/teto|redirects/i);
      }
      // maxRedirects=2: hops 0,1,2 — todos redirecionam, então 3 conexões
      expect(connectedIps.length).toBe(3);
    });
  });
});
