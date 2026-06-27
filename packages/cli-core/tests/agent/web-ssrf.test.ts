// EST-0971 · CLI-SEC-13 — BATERIA CA-C1 (anti-SSRF) + classificação de IP.
//
// O gate FORTE do `seguranca`: resolve→valida→pina→conecta, revalidando cada
// redirect. Esta suíte prova a denylist dura, a canonicalização de IP-literal
// (decimal/octal/hex/IPv4-mapped), o PIN (conecta ao IP validado, sem re-resolver)
// e os 7 casos do gate, incl. DNS-rebinding (mock TTL0) e redirect 302→IP-interno.

import { describe, expect, it, vi } from 'vitest';
import {
  classifyIp,
  validateResolvedIps,
  canonicalizeIpv4,
  ipv4MappedFromV6,
  safeFetch,
  type HostResolver,
  type PinnedFetcher,
  type PinnedFetchArgs,
  type PinnedResponse,
  type SafeFetcherPorts,
} from '../../src/index.js';

// ── classificação de IP (a denylist dura) ─────────────────────────────────────
describe('classifyIp — denylist dura (não-liberável por allowlist)', () => {
  it('bloqueia metadata da cloud 169.254.169.254', () => {
    expect(classifyIp('169.254.169.254').blocked).toBe(true);
  });
  it('bloqueia loopback 127.0.0.1 e ::1 e 0.0.0.0', () => {
    expect(classifyIp('127.0.0.1').blocked).toBe(true);
    expect(classifyIp('127.5.5.5').blocked).toBe(true);
    expect(classifyIp('::1').blocked).toBe(true);
    expect(classifyIp('0.0.0.0').blocked).toBe(true);
  });
  it('bloqueia RFC1918: 10/8, 192.168/16, 172.16-31/12', () => {
    expect(classifyIp('10.0.0.5').blocked).toBe(true);
    expect(classifyIp('192.168.1.1').blocked).toBe(true);
    expect(classifyIp('172.16.0.1').blocked).toBe(true);
    expect(classifyIp('172.31.255.255').blocked).toBe(true);
    // 172.15 e 172.32 NÃO são RFC1918 (fora da faixa /12).
    expect(classifyIp('172.15.0.1').blocked).toBe(false);
    expect(classifyIp('172.32.0.1').blocked).toBe(false);
  });
  it('bloqueia link-local 169.254/16 e CGNAT 100.64/10', () => {
    expect(classifyIp('169.254.0.1').blocked).toBe(true);
    expect(classifyIp('100.64.0.1').blocked).toBe(true);
    expect(classifyIp('100.127.255.255').blocked).toBe(true);
    // 100.63 e 100.128 estão FORA do CGNAT.
    expect(classifyIp('100.63.0.1').blocked).toBe(false);
    expect(classifyIp('100.128.0.1').blocked).toBe(false);
  });
  it('PERMITE IP público comum (1.1.1.1, 8.8.8.8, 93.184.216.34)', () => {
    expect(classifyIp('1.1.1.1').blocked).toBe(false);
    expect(classifyIp('8.8.8.8').blocked).toBe(false);
    expect(classifyIp('93.184.216.34').blocked).toBe(false);
  });

  // IP decimal/octal/hex — o bypass clássico.
  it('canonicaliza e bloqueia IP DECIMAL 2130706433 = 127.0.0.1', () => {
    expect(canonicalizeIpv4('2130706433')).toBe('127.0.0.1');
    expect(classifyIp('2130706433').blocked).toBe(true);
  });
  it('canonicaliza e bloqueia IP OCTAL 0177.0.0.1 = 127.0.0.1', () => {
    expect(canonicalizeIpv4('0177.0.0.1')).toBe('127.0.0.1');
    expect(classifyIp('0177.0.0.1').blocked).toBe(true);
  });
  it('canonicaliza e bloqueia IP HEX 0x7f.0.0.1 e 0x7f000001', () => {
    expect(canonicalizeIpv4('0x7f000001')).toBe('127.0.0.1');
    expect(classifyIp('0x7f000001').blocked).toBe(true);
  });
  it('formas curtas: 127.1 = 127.0.0.1; 10.1 = 10.0.0.1', () => {
    expect(canonicalizeIpv4('127.1')).toBe('127.0.0.1');
    expect(classifyIp('127.1').blocked).toBe(true);
    expect(classifyIp('10.1').blocked).toBe(true);
  });

  // IPv4-mapped IPv6 — o loopback disfarçado de v6.
  it('IPv4-mapped-IPv6 ::ffff:127.0.0.1 cai na denylist do IPv4', () => {
    expect(ipv4MappedFromV6('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(classifyIp('::ffff:127.0.0.1').blocked).toBe(true);
    expect(classifyIp('::ffff:169.254.169.254').blocked).toBe(true);
  });
  it('IPv6 ULA fc00::/7 e link-local fe80::/10 bloqueados', () => {
    expect(classifyIp('fd00::1').blocked).toBe(true);
    expect(classifyIp('fe80::1').blocked).toBe(true);
  });

  it('fail-safe: string não-reconhecível ⇒ BLOQUEADA', () => {
    expect(classifyIp('not-an-ip').blocked).toBe(true);
    expect(classifyIp('').blocked).toBe(true);
  });
});

describe('validateResolvedIps — 1 IP interno reprova o conjunto inteiro', () => {
  it('host com IP público + interno (dual-A) ⇒ BLOQUEADO', () => {
    const r = validateResolvedIps(['1.2.3.4', '127.0.0.1']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.offendingIp).toBe('127.0.0.1');
  });
  it('todos públicos ⇒ pina o 1º', () => {
    const r = validateResolvedIps(['93.184.216.34', '1.1.1.1']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pinnedIp).toBe('93.184.216.34');
  });
  it('nenhum IP ⇒ bloqueado', () => {
    expect(validateResolvedIps([]).ok).toBe(false);
  });
});

// ── helpers de mock p/ a bateria de safeFetch ─────────────────────────────────
function resolverReturning(map: Record<string, string[]>): HostResolver {
  return {
    resolve: async (host) => {
      const ips = map[host];
      if (!ips) throw new Error(`NXDOMAIN ${host}`);
      return ips;
    },
  };
}

/** Fetcher que registra a QUE IP conectou (prova o pin) e devolve respostas fixas. */
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

// ── BATERIA CA-C1 — os 7 casos do gate ────────────────────────────────────────
describe('CA-C1 — bateria anti-SSRF (safeFetch)', () => {
  const ok200 = (): PinnedResponse => ({ status: 200, body: '<html>ok</html>' });

  it('1) metadata 169.254.169.254 (host resolve p/ ela) ⇒ BLOQUEADO, sem conectar', async () => {
    const { fetcher, connectedIps } = recordingFetcher(ok200);
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({ 'evil.example': ['169.254.169.254'] }),
      fetcher,
    };
    const r = await safeFetch('http://evil.example/latest/meta-data/', ports);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/anti-SSRF|metadata/i);
    expect(connectedIps).toEqual([]); // NUNCA conectou
  });

  it('2) localhost (host resolve p/ 127.0.0.1) ⇒ BLOQUEADO', async () => {
    const { fetcher, connectedIps } = recordingFetcher(ok200);
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({ 'localhost.evil': ['127.0.0.1'] }),
      fetcher,
    };
    const r = await safeFetch('http://localhost.evil/', ports);
    expect(r.ok).toBe(false);
    expect(connectedIps).toEqual([]);
  });

  it('3) RFC1918 (host resolve p/ 10.0.0.5) ⇒ BLOQUEADO', async () => {
    const { fetcher, connectedIps } = recordingFetcher(ok200);
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({ 'intranet.evil': ['10.0.0.5'] }),
      fetcher,
    };
    const r = await safeFetch('http://intranet.evil/admin', ports);
    expect(r.ok).toBe(false);
    expect(connectedIps).toEqual([]);
  });

  it('4) DNS-REBINDING (mock TTL0): resolve é chamado UMA vez; o PIN conecta ao IP validado, não ao 2º lookup', async () => {
    // O resolver, a CADA chamada, devolve um IP DIFERENTE: 1ª vez público, 2ª vez
    // interno (simula TTL0 + rebind). A defesa: o core resolve UMA vez, valida o
    // IP público, PINA, e conecta a ele. Não há 2ª resolução p/ o rebind explorar.
    let calls = 0;
    const rebindResolver: HostResolver = {
      resolve: async () => {
        calls += 1;
        return calls === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
      },
    };
    const { fetcher, connectedIps } = recordingFetcher(ok200);
    const ports: SafeFetcherPorts = { resolver: rebindResolver, fetcher };
    const r = await safeFetch('http://rebind.evil/', ports);
    expect(r.ok).toBe(true);
    expect(calls).toBe(1); // resolveu UMA vez (sem 2º lookup p/ o rebind)
    expect(connectedIps).toEqual(['93.184.216.34']); // conectou ao IP VALIDADO (pin)
  });

  it('5) REDIRECT 302 → host interno ⇒ o PRÓXIMO hop é revalidado e BLOQUEADO', async () => {
    const responder = (args: PinnedFetchArgs): PinnedResponse => {
      if (args.url.includes('start.public')) {
        return { status: 302, location: 'http://internal.evil/secret', body: '' };
      }
      return ok200();
    };
    const { fetcher, connectedIps } = recordingFetcher(responder);
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({
        'start.public': ['93.184.216.34'],
        'internal.evil': ['169.254.169.254'], // o redirect aponta p/ metadata
      }),
      fetcher,
    };
    const r = await safeFetch('http://start.public/', ports);
    expect(r.ok).toBe(false); // o 2º hop foi barrado
    if (!r.ok) expect(r.url).toContain('internal.evil');
    // conectou só ao 1º (público); o 2º hop nem chegou ao fetcher (barrado na validação).
    expect(connectedIps).toEqual(['93.184.216.34']);
  });

  it('6) IP literal exótico: http://2130706433 (decimal=127.0.0.1) ⇒ BLOQUEADO sem DNS', async () => {
    const resolveSpy = vi.fn(async () => ['1.2.3.4']);
    const { fetcher, connectedIps } = recordingFetcher(ok200);
    const ports: SafeFetcherPorts = { resolver: { resolve: resolveSpy }, fetcher };
    const r = await safeFetch('http://2130706433/', ports);
    expect(r.ok).toBe(false);
    expect(resolveSpy).not.toHaveBeenCalled(); // IP-literal: nem resolve
    expect(connectedIps).toEqual([]);
    // e o IPv4-mapped-IPv6 disfarçado:
    const r2 = await safeFetch('http://[::ffff:127.0.0.1]/', ports);
    expect(r2.ok).toBe(false);
  });

  it('6b) NAT64/6to4 que EMBUTE IPv4 interno ⇒ BLOQUEADO (literal e via DNS64)', async () => {
    const resolveSpy = vi.fn(async () => ['1.2.3.4']);
    const { fetcher, connectedIps } = recordingFetcher(ok200);

    // (a) IPv6-LITERAL NAT64 p/ a metadata da cloud (169.254.169.254 = a9fe:a9fe):
    //     antes do fix passava como "IPv6 público" e CONECTAVA à metadata.
    const portsLiteral: SafeFetcherPorts = { resolver: { resolve: resolveSpy }, fetcher };
    const rLiteral = await safeFetch('http://[64:ff9b::a9fe:a9fe]/latest/meta-data/', portsLiteral);
    expect(rLiteral.ok).toBe(false);
    expect(resolveSpy).not.toHaveBeenCalled(); // IP-literal: nem resolve

    // (b) host público que RESOLVE (DNS64) p/ um NAT64 da metadata — o resolver
    //     devolve `64:ff9b::a9fe:a9fe`; o core deve barrá-lo na validação do IP.
    const ports64: SafeFetcherPorts = {
      resolver: resolverReturning({ 'dns64.evil': ['64:ff9b::a9fe:a9fe'] }),
      fetcher,
    };
    const r64 = await safeFetch('http://dns64.evil/', ports64);
    expect(r64.ok).toBe(false);
    if (!r64.ok) expect(r64.reason).toMatch(/NAT64|metadata/i);

    // (c) 6to4 literal p/ loopback (2002:7f00:1:: = 127.0.0.1):
    const r6to4 = await safeFetch('http://[2002:7f00:1::]/', portsLiteral);
    expect(r6to4.ok).toBe(false);

    // nenhum dos casos internos conectou ao fetcher.
    expect(connectedIps).toEqual([]);
  });

  it('7) DDG/host público resolve p/ IP público ⇒ ALLOW (conecta e devolve corpo)', async () => {
    const { fetcher, connectedIps } = recordingFetcher(() => ({
      status: 200,
      body: '<html>resultado público</html>',
      contentType: 'text/html',
    }));
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({ 'html.duckduckgo.com': ['93.184.216.34'] }),
      fetcher,
    };
    const r = await safeFetch('https://html.duckduckgo.com/html/?q=aluy', ports);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).toContain('resultado público');
      expect(r.status).toBe(200);
    }
    expect(connectedIps).toEqual(['93.184.216.34']);
  });

  it('redirect que CHEGA num público é seguido até o fim', async () => {
    const responder = (args: PinnedFetchArgs): PinnedResponse =>
      args.url.includes('a.public')
        ? { status: 301, location: 'https://b.public/final', body: '' }
        : { status: 200, body: 'OK FINAL' };
    const { fetcher, connectedIps } = recordingFetcher(responder);
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({
        'a.public': ['8.8.8.8'],
        'b.public': ['1.1.1.1'],
      }),
      fetcher,
    };
    const r = await safeFetch('https://a.public/', ports);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toBe('OK FINAL');
    expect(connectedIps).toEqual(['8.8.8.8', '1.1.1.1']); // ambos validados+pinados
  });

  it('TETO de redirects: loop infinito ⇒ aborta', async () => {
    const { fetcher } = recordingFetcher(() => ({
      status: 302,
      location: 'https://loop.public/next',
      body: '',
    }));
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({ 'loop.public': ['8.8.8.8'] }),
      fetcher,
    };
    const r = await safeFetch('https://loop.public/', ports, { maxRedirects: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/redirect/i);
  });

  it('esquema não-http (file://, gopher://) ⇒ rejeitado', async () => {
    const { fetcher, connectedIps } = recordingFetcher(ok200);
    const ports: SafeFetcherPorts = { resolver: resolverReturning({}), fetcher };
    expect((await safeFetch('file:///etc/passwd', ports)).ok).toBe(false);
    expect((await safeFetch('gopher://x/', ports)).ok).toBe(false);
    expect(connectedIps).toEqual([]);
  });

  // EST-0971 (fix) — o descritor POST (web_search) flui ao 1º hop; um redirect
  // reverte a GET sem corpo (não reenvia o corpo a outro destino).
  it('POST: o método+corpo chegam ao 1º hop; o anti-SSRF é idêntico', async () => {
    const seen: PinnedFetchArgs[] = [];
    const fetcher: PinnedFetcher = {
      fetchPinned: async (args) => {
        seen.push(args);
        return { status: 200, body: 'ok' };
      },
    };
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({ 'html.duckduckgo.com': ['93.184.216.34'] }),
      fetcher,
    };
    const r = await safeFetch(
      'https://html.duckduckgo.com/html/?q=rust',
      ports,
      {},
      { method: 'POST', body: 'q=rust&b=', contentType: 'application/x-www-form-urlencoded' },
    );
    expect(r.ok).toBe(true);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.body).toBe('q=rust&b=');
    expect(seen[0]!.pinnedIp).toBe('93.184.216.34'); // pin idêntico
  });

  it('POST seguido de REDIRECT ⇒ o 2º hop é GET sem corpo (não reenvia o corpo)', async () => {
    const seen: PinnedFetchArgs[] = [];
    const responder = (args: PinnedFetchArgs): PinnedResponse => {
      seen.push(args);
      return args.url.includes('start.public')
        ? { status: 303, location: 'https://other.public/final', body: '' }
        : { status: 200, body: 'FINAL' };
    };
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({
        'start.public': ['8.8.8.8'],
        'other.public': ['1.1.1.1'],
      }),
      fetcher: { fetchPinned: async (a) => responder(a) },
    };
    const r = await safeFetch('https://start.public/', ports, {}, { method: 'POST', body: 'q=x' });
    expect(r.ok).toBe(true);
    expect(seen[0]!.method).toBe('POST'); // 1º hop: POST com corpo
    expect(seen[0]!.body).toBe('q=x');
    expect(seen[1]!.method).toBeUndefined(); // 2º hop: GET (default)
    expect(seen[1]!.body).toBeUndefined(); // SEM reenvio do corpo a outro host
  });
});

// ── EST-0991 · ADR-0072 — YOLO suspende a DENYLIST de faixa interna (não o PIN) ──
describe('EST-0991 · ADR-0072 — YOLO (allowInternalHosts) alcança a rede interna', () => {
  const ok200 = (): PinnedResponse => ({ status: 200, body: '<html>ok</html>' });

  it('NÃO-REGRESSÃO — sem YOLO, metadata/loopback/RFC1918 ⇒ BLOQUEADO', async () => {
    for (const [host, ip] of [
      ['evil.example', '169.254.169.254'],
      ['localhost.evil', '127.0.0.1'],
      ['intranet.evil', '10.0.0.5'],
    ] as const) {
      const { fetcher, connectedIps } = recordingFetcher(ok200);
      const ports: SafeFetcherPorts = { resolver: resolverReturning({ [host]: [ip] }), fetcher };
      const r = await safeFetch(`http://${host}/x`, ports); // policy default (anti-SSRF DURO)
      expect(r.ok, `${host} deveria ser bloqueado sem YOLO`).toBe(false);
      expect(connectedIps).toEqual([]);
    }
  });

  it('YOLO — host que resolve p/ metadata 169.254.169.254 ⇒ ALCANÇA (pina e conecta)', async () => {
    const { fetcher, connectedIps } = recordingFetcher(ok200);
    const ports: SafeFetcherPorts = {
      resolver: resolverReturning({ 'metadata.evil': ['169.254.169.254'] }),
      fetcher,
    };
    const r = await safeFetch('http://metadata.evil/latest/meta-data/', ports, {
      allowInternalHosts: true,
    });
    expect(r.ok).toBe(true);
    expect(connectedIps).toEqual(['169.254.169.254']); // PIN preservado
  });

  it('YOLO — loopback e RFC1918 também alcançados', async () => {
    for (const [host, ip] of [
      ['local.evil', '127.0.0.1'],
      ['intranet.evil', '10.0.0.5'],
    ] as const) {
      const { fetcher, connectedIps } = recordingFetcher(ok200);
      const ports: SafeFetcherPorts = { resolver: resolverReturning({ [host]: [ip] }), fetcher };
      const r = await safeFetch(`http://${host}/admin`, ports, { allowInternalHosts: true });
      expect(r.ok, `${host} deveria ser alcançado sob YOLO`).toBe(true);
      expect(connectedIps).toEqual([ip]);
    }
  });

  it('YOLO — IP-LITERAL interno (http://127.0.0.1) também alcança', async () => {
    const { fetcher, connectedIps } = recordingFetcher(ok200);
    const ports: SafeFetcherPorts = { resolver: resolverReturning({}), fetcher };
    const r = await safeFetch('http://127.0.0.1/x', ports, { allowInternalHosts: true });
    expect(r.ok).toBe(true);
    expect(connectedIps).toEqual(['127.0.0.1']);
  });

  it('YOLO — o PIN/anti-rebind continua: resolve UMA vez, conecta ao IP resolvido', async () => {
    let calls = 0;
    const rebind: HostResolver = {
      resolve: async () => {
        calls += 1;
        return ['10.0.0.5'];
      },
    };
    const { fetcher, connectedIps } = recordingFetcher(ok200);
    const r = await safeFetch(
      'http://rebind.internal/',
      { resolver: rebind, fetcher },
      {
        allowInternalHosts: true,
      },
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(1); // resolveu UMA vez (PIN intacto, só a denylist some)
    expect(connectedIps).toEqual(['10.0.0.5']);
  });
});
