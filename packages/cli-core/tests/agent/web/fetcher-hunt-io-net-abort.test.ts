// HUNT-IO-NET — abort NÃO propagado: `web_fetch`/`web_search`/`mcp search` aceitavam
// o `AbortSignal` do loop mas o DESCARTAVAM antes do `safeFetch` (que nem tinha o
// parâmetro). Resultado: cancelar a sessão (Esc/Ctrl-C) NÃO matava o socket — ele
// pendurava até o timeout do hop (~15s p/ web, 12s p/ registro). Agora o signal é
// propagado a CADA hop pinado E checado entre redirects.
//
// O verde atual NÃO pega: nenhum teste passava um signal ABORTADO ao safeFetch.
import { describe, expect, it } from 'vitest';
import {
  safeFetch,
  type HostResolver,
  type PinnedFetcher,
  type PinnedFetchArgs,
  type PinnedResponse,
  type SafeFetcherPorts,
} from '../../../src/index.js';

function resolverReturning(map: Record<string, string[]>): HostResolver {
  return {
    resolve: async (host) => {
      const ips = map[host];
      if (!ips) throw new Error(`NXDOMAIN ${host}`);
      return ips;
    },
  };
}

describe('HUNT-IO-NET · safeFetch propaga AbortSignal', () => {
  it('signal JÁ abortado ⇒ NÃO abre socket (fail-soft, não pendura até o timeout)', async () => {
    let opened = false;
    const fetcher: PinnedFetcher = {
      fetchPinned: async (): Promise<PinnedResponse> => {
        opened = true;
        return { status: 200, body: 'ok' };
      },
    };
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({ 'ex.public': ['93.184.216.34'] }),
      fetcher,
    };
    const ac = new AbortController();
    ac.abort();
    const r = await safeFetch('http://ex.public/', ports, {}, { signal: ac.signal });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('cancelada');
    // Sem o fix, o socket abriria mesmo abortado (signal descartado).
    expect(opened).toBe(false);
  });

  it('signal é ENTREGUE ao fetchPinned (o socket recebe o abort p/ se matar)', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetcher: PinnedFetcher = {
      fetchPinned: async (args: PinnedFetchArgs): Promise<PinnedResponse> => {
        receivedSignal = args.signal;
        return { status: 200, body: 'ok' };
      },
    };
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({ 'ex.public': ['93.184.216.34'] }),
      fetcher,
    };
    const ac = new AbortController();
    const r = await safeFetch('http://ex.public/', ports, {}, { signal: ac.signal });
    expect(r.ok).toBe(true);
    // O MESMO signal do loop chega ao fetcher (antes era undefined sempre).
    expect(receivedSignal).toBe(ac.signal);
  });

  it('abort ENTRE redirects ⇒ para no próximo hop (não segue a cadeia)', async () => {
    const ac = new AbortController();
    let hops = 0;
    const fetcher: PinnedFetcher = {
      fetchPinned: async (args: PinnedFetchArgs): Promise<PinnedResponse> => {
        hops++;
        // No 1º hop devolve um redirect e ABORTA — o 2º hop não deve abrir.
        if (args.url.includes('hop1.public')) {
          ac.abort();
          return { status: 302, location: 'http://hop2.public/', body: '' };
        }
        return { status: 200, body: 'should-not-reach' };
      },
    };
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({
        'hop1.public': ['93.184.216.34'],
        'hop2.public': ['93.184.216.35'],
      }),
      fetcher,
    };
    const r = await safeFetch('http://hop1.public/', ports, {}, { signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(hops).toBe(1); // só o 1º hop abriu; o redirect foi barrado pelo abort.
  });
});
