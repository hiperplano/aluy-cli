// EST-1075 · HR-SEC-1 + HR-SEC-2 (ADR-0102) — a defesa dura do destino headroom.
// Resolver MOCKADO (sem DNS real). Prova: metadata/público/interno recusam, rebinding
// misto recusa, loopback (incl. formas exóticas) aceita, e o string-match preguiçoso
// `includes('127.0.0.1')` NÃO passaria (host `127.0.0.1.attacker.com` → público recusa).

import { describe, expect, it } from 'vitest';
import { classifyHeadroomTarget, isLoopbackIp, type HostResolver } from '../../src/index.js';

/** Resolver mockado: mapa host→IPs. Host ausente ⇒ rejeita (não resolve). */
function mockResolver(map: Record<string, readonly string[]>): HostResolver {
  return {
    resolve: async (host: string) => {
      const ips = map[host];
      if (ips === undefined) throw new Error(`NXDOMAIN: ${host}`);
      return ips;
    },
  };
}

describe('isLoopbackIp — só loopback, canonicalizando (HR-SEC-2)', () => {
  it('aceita loopback em todas as formas', () => {
    for (const ip of [
      '127.0.0.1',
      '127.1.2.3',
      '2130706433',
      '0177.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLoopbackIp(ip), ip).toBe(true);
    }
  });
  it('recusa público, interno e metadata', () => {
    for (const ip of [
      '1.2.3.4',
      '203.0.113.10',
      '169.254.169.254',
      '10.0.0.1',
      '192.168.1.1',
      '0.0.0.0',
      '::',
    ]) {
      expect(isLoopbackIp(ip), ip).toBe(false);
    }
  });
});

describe('classifyHeadroomTarget — loopback-only + anti-rebinding (HR-SEC-1/2)', () => {
  it('loopback literal ⇒ ok, pina o IP', async () => {
    const r = await classifyHeadroomTarget('http://127.0.0.1:8787', mockResolver({}));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pinnedIp).toBe('127.0.0.1');
  });

  it('localhost que resolve p/ loopback ⇒ ok', async () => {
    const r = await classifyHeadroomTarget(
      'http://localhost:8787',
      mockResolver({ localhost: ['127.0.0.1'] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pinnedIp).toBe('127.0.0.1');
  });

  it('metadata da cloud (169.254.169.254) ⇒ RECUSA', async () => {
    const r = await classifyHeadroomTarget('http://169.254.169.254/', mockResolver({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/loopback/i);
  });

  it('host público ⇒ RECUSA', async () => {
    const r = await classifyHeadroomTarget(
      'http://proxy.evil.com:8787',
      mockResolver({ 'proxy.evil.com': ['203.0.113.10'] }),
    );
    expect(r.ok).toBe(false);
  });

  it('DNS-rebinding: conjunto MISTO [loopback, público] ⇒ RECUSA (atacante não escolhe)', async () => {
    const r = await classifyHeadroomTarget(
      'http://rebind.example:8787',
      mockResolver({ 'rebind.example': ['127.0.0.1', '93.184.216.34'] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/não-loopback|loopback/i);
  });

  it('IPv4-mapped metadata (::ffff:169.254.169.254) ⇒ RECUSA (reusa classifyIp, não string-match)', async () => {
    const r = await classifyHeadroomTarget('http://[::ffff:169.254.169.254]/', mockResolver({}));
    expect(r.ok).toBe(false);
  });

  it('ANTI string-match: host `127.0.0.1.attacker.com` que resolve p/ público ⇒ RECUSA', async () => {
    // Um `url.includes('127.0.0.1')` ingênuo passaria isto — o teste mata essa impl.
    const r = await classifyHeadroomTarget(
      'http://127.0.0.1.attacker.com:8787',
      mockResolver({ '127.0.0.1.attacker.com': ['198.51.100.7'] }),
    );
    expect(r.ok).toBe(false);
  });

  it('decimal loopback `http://2130706433` ⇒ ok (canonicaliza)', async () => {
    const r = await classifyHeadroomTarget('http://2130706433:8787', mockResolver({}));
    expect(r.ok).toBe(true);
  });

  it('host que não resolve ⇒ recusa (sem vazar)', async () => {
    const r = await classifyHeadroomTarget('http://nope.invalid:8787', mockResolver({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/resolver|resolveu/i);
  });

  it('esquema não-http ⇒ recusa', async () => {
    const r = await classifyHeadroomTarget('ftp://127.0.0.1/', mockResolver({}));
    expect(r.ok).toBe(false);
  });
});
