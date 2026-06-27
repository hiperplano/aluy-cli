// EST-1014 · CLI-SEC-13 — bateria de cobertura da denylist dura anti-SSRF.
// Faixas de IP que NÃO estavam cobertas: metadata, CGNAT, benchmark,
// multicast/reservado/broadcast, IPv6 ULA/link-local, IPv4-mapped-IPv6,
// unspecifed, e o fail-safe para string não-IP.
//
// IMPORTANTE: só testa as funções PURAS exportadas (classifyIp, validateResolvedIps).
// Nenhum mock de DNS — é lógica de string/bits pura (portável, ADR-0053 §8).

import { describe, it, expect } from 'vitest';
import { classifyIp, validateResolvedIps } from '../../../src/agent/web/ssrf.js';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Afirma que `classifyIp(raw)` resulta em `blocked: true` com uma reason que contém `reasonHint`. */
function assertBlocked(raw: string, reasonHint: string): void {
  const r = classifyIp(raw);
  expect(r.blocked, `${raw} deveria ser BLOQUEADO`).toBe(true);
  expect(r.reason, `${raw}: reason deveria mencionar "${reasonHint}"`).toMatch(
    new RegExp(reasonHint, 'i'),
  );
}

/** Afirma que `classifyIp(raw)` resulta em `blocked: false`. */
function assertAllowed(raw: string): void {
  const r = classifyIp(raw);
  expect(r.blocked, `${raw} deveria ser PERMITIDO`).toBe(false);
  expect(r.canonical).toBeTruthy();
}

// ─── IPv4: faixas perigosas ─────────────────────────────────────────────────

describe('classifyIp — IPv4 denylist', () => {
  it('bloqueia metadata cloud 169.254.169.254', () => {
    assertBlocked('169.254.169.254', 'metadata');
  });

  it('bloqueia CGNAT 100.64.0.0/10', () => {
    assertBlocked('100.64.0.1', 'CGNAT');
  });

  it('bloqueia benchmark 198.18.0.0/15 — 198.18.0.1', () => {
    assertBlocked('198.18.0.1', 'benchmark');
  });

  it('bloqueia benchmark 198.18.0.0/15 — 198.19.0.1', () => {
    assertBlocked('198.19.0.1', 'benchmark');
  });

  it('bloqueia multicast (224.0.0.0/4)', () => {
    assertBlocked('224.0.0.1', 'multicast|reservado');
  });

  it('bloqueia reservado (240.0.0.0/4)', () => {
    assertBlocked('240.0.0.1', 'multicast|reservado');
  });

  it('bloqueia broadcast 255.255.255.255', () => {
    // ACHADO: o ramo de broadcast (`dotted === '255.255.255.255'`) e CODIGO MORTO —
    // o guard `a >= 224` (multicast/reservado) vem antes e ja casa 255. O IP segue
    // BLOQUEADO (garantia de seguranca intacta), so com reason 'multicast/reservado'.
    assertBlocked('255.255.255.255', 'multicast|reservado');
  });

  it('permite IP público 8.8.8.8', () => {
    assertAllowed('8.8.8.8');
  });
});

// ─── IPv6: faixas perigosas ─────────────────────────────────────────────────

describe('classifyIp — IPv6 denylist', () => {
  it('bloqueia loopback ::1', () => {
    assertBlocked('::1', 'loopback');
  });

  it('bloqueia unspecified ::', () => {
    assertBlocked('::', 'unspecified');
  });

  it('bloqueia ULA fc00::1', () => {
    assertBlocked('fc00::1', 'ULA');
  });

  it('bloqueia ULA fd12::1', () => {
    assertBlocked('fd12::1', 'ULA');
  });

  it('bloqueia link-local fe80::1', () => {
    assertBlocked('fe80::1', 'link-local');
  });

  // F123 — PARIDADE IPv4/IPv6: o lado IPv4 já bloqueia multicast `224.0.0.0/4`, mas o IPv6
  // deixava `ff00::/8` PASSAR como "público" (all-nodes ff02::1, site-local ff05::c, mDNS
  // ff02::fb). Special-use (RFC 4291 §2.7), NÃO unicast público ⇒ a denylist deve barrar.
  it('F123 — bloqueia multicast ff00::/8 (paridade c/ IPv4 224/4)', () => {
    assertBlocked('ff02::1', 'multicast'); // all-nodes
    assertBlocked('ff05::c', 'multicast'); // site-local
    assertBlocked('ff0e::1', 'multicast'); // global
    assertBlocked('ff02::fb', 'multicast'); // mDNS
  });

  it('F123 — NÃO super-bloqueia: unicast global IPv6 segue liberado', () => {
    expect(classifyIp('2606:4700::1111').blocked, 'Cloudflare DNS IPv6').toBe(false);
    expect(classifyIp('2001:4860:4860::8888').blocked, 'Google DNS IPv6').toBe(false);
  });
});

// ─── IPv4-mapped-IPv6 ───────────────────────────────────────────────────────

describe('classifyIp — IPv4-mapped-IPv6', () => {
  it('bloqueia ::ffff:127.0.0.1 (loopback via mapped)', () => {
    const r = classifyIp('::ffff:127.0.0.1');
    expect(r.blocked, '::ffff:127.0.0.1 deveria ser BLOQUEADO').toBe(true);
    // A reason DEVE indicar o mapeamento (ex.: "IPv4-mapped-IPv6") e loopback.
    expect(r.reason).toMatch(/IPv4-mapped/i);
    expect(r.reason).toMatch(/loopback/i);
  });
});

// ─── IPv6 de transição que EMBUTE IPv4 interno (NAT64 / 6to4) ────────────────
// EST-1014 (hunt SSRF): em rede com gateway NAT64/6to4 o kernel ROTEIA esses
// literais ao IPv4 embutido. Antes do fix, `64:ff9b::a9fe:a9fe` (= metadata
// 169.254.169.254) passava como "IPv6 público" — bypass direto da denylist.

describe('classifyIp — IPv6 de transição (NAT64 / 6to4) embute IPv4 interno', () => {
  it('bloqueia NAT64 64:ff9b::a9fe:a9fe (metadata 169.254.169.254)', () => {
    const r = classifyIp('64:ff9b::a9fe:a9fe');
    expect(r.blocked, '64:ff9b::a9fe:a9fe deveria ser BLOQUEADO').toBe(true);
    expect(r.reason).toMatch(/NAT64/i);
    expect(r.reason).toMatch(/metadata/i);
  });

  it('bloqueia NAT64 64:ff9b::a00:1 (privada 10.0.0.1)', () => {
    const r = classifyIp('64:ff9b::a00:1');
    expect(r.blocked, '64:ff9b::a00:1 deveria ser BLOQUEADO').toBe(true);
    expect(r.reason).toMatch(/NAT64/i);
    expect(r.reason).toMatch(/RFC1918|privada|10\.0\.0\.0/i);
  });

  it('bloqueia NAT64 64:ff9b::7f00:1 (loopback 127.0.0.1)', () => {
    assertBlocked('64:ff9b::7f00:1', 'NAT64');
  });

  it('bloqueia NAT64 local-use 64:ff9b:1::7f00:1 (loopback 127.0.0.1)', () => {
    assertBlocked('64:ff9b:1::7f00:1', 'NAT64');
  });

  it('bloqueia 6to4 2002:7f00:1:: (loopback 127.0.0.1)', () => {
    const r = classifyIp('2002:7f00:1::');
    expect(r.blocked, '2002:7f00:1:: deveria ser BLOQUEADO').toBe(true);
    expect(r.reason).toMatch(/6to4/i);
    expect(r.reason).toMatch(/loopback/i);
  });

  it('bloqueia 6to4 2002:a9fe:a9fe:: (metadata 169.254.169.254)', () => {
    const r = classifyIp('2002:a9fe:a9fe::');
    expect(r.blocked, '2002:a9fe:a9fe:: deveria ser BLOQUEADO').toBe(true);
    expect(r.reason).toMatch(/6to4/i);
    expect(r.reason).toMatch(/metadata/i);
  });

  it('permite NAT64 que embute IPv4 PÚBLICO 64:ff9b::808:808 (8.8.8.8)', () => {
    // não regride: NAT64 p/ um IPv4 público continua liberado (a denylist é do IPv4).
    assertAllowed('64:ff9b::808:808');
  });
});

// ─── String inválida ────────────────────────────────────────────────────────

describe('classifyIp — entrada inválida', () => {
  it('bloqueia string não-IP (fail-safe)', () => {
    assertBlocked('nao-eh-ip', 'não-reconhecido');
  });
});

// ─── validateResolvedIps (anti-rebinding) ───────────────────────────────────

describe('validateResolvedIps — anti-rebinding', () => {
  it('aprova conjunto só com IPs públicos', () => {
    const result = validateResolvedIps(['8.8.8.8']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // pinnedIp deve ser a forma canônica
      expect(result.pinnedIp).toBe('8.8.8.8');
    }
  });

  it('rejeita conjunto com IP público + interno (ex.: 10.0.0.1)', () => {
    const result = validateResolvedIps(['8.8.8.8', '10.0.0.1']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.offendingIp).toBe('10.0.0.1');
      expect(result.reason).toMatch(/privada|RFC1918|10\.0\.0\.0/i);
    }
  });
});
