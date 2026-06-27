// ADR-0120 / EST-1113 · PROV-SEC-1 — anti-SSRF do base_url configurável.
import { describe, expect, it } from 'vitest';
import { validateProviderBaseUrl, resolveAndPinHost } from '../../../src/model/local/base-url.js';
import type { HostResolver } from '../../../src/agent/web/fetcher.js';

/** Resolver fake: mapa host→IPs. Host ausente ⇒ rejeita (não resolve). */
function fakeResolver(map: Record<string, string[]>): HostResolver {
  return {
    resolve: async (host) => {
      const ips = map[host];
      if (ips === undefined) throw new Error(`no DNS for ${host}`);
      return ips;
    },
  };
}

describe('validateProviderBaseUrl — bloqueia alvos internos (PROV-SEC-1)', () => {
  it('aceita um host público (resolve p/ IP público)', async () => {
    const r = fakeResolver({ 'api.anthropic.com': ['160.79.104.10'] });
    const v = await validateProviderBaseUrl('https://api.anthropic.com', r);
    expect(v.ok).toBe(true);
  });

  it('bloqueia host que resolve p/ loopback', async () => {
    const r = fakeResolver({ 'evil.test': ['127.0.0.1'] });
    const v = await validateProviderBaseUrl('https://evil.test', r);
    expect(v.ok).toBe(false);
  });

  it('bloqueia host que resolve p/ metadata da cloud (169.254.169.254)', async () => {
    const r = fakeResolver({ 'rebind.test': ['169.254.169.254'] });
    const v = await validateProviderBaseUrl('https://rebind.test/v1', r);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/interno|metadata/i);
  });

  it('bloqueia host que resolve p/ RFC1918 (10.x)', async () => {
    const r = fakeResolver({ 'intra.test': ['10.0.0.5'] });
    expect((await validateProviderBaseUrl('https://intra.test', r)).ok).toBe(false);
  });

  it('bloqueia IP-literal loopback direto (sem resolver)', async () => {
    const r = fakeResolver({});
    expect((await validateProviderBaseUrl('http://127.0.0.1:8080', r)).ok).toBe(false);
  });

  it('bloqueia loopback em DECIMAL (2130706433 = 127.0.0.1)', async () => {
    const r = fakeResolver({});
    expect((await validateProviderBaseUrl('http://2130706433/', r)).ok).toBe(false);
  });

  it('bloqueia IPv6 loopback [::1]', async () => {
    const r = fakeResolver({});
    expect((await validateProviderBaseUrl('http://[::1]:9000', r)).ok).toBe(false);
  });

  it('recusa esquema não-http', async () => {
    const r = fakeResolver({});
    expect((await validateProviderBaseUrl('ftp://host.test', r)).ok).toBe(false);
  });

  it('fail-safe: host que NÃO resolve ⇒ recusa (não conecta às cegas)', async () => {
    const r = fakeResolver({});
    expect((await validateProviderBaseUrl('https://nope.test', r)).ok).toBe(false);
  });

  it('bloqueia mesmo se UM dos IPs é interno (atacante escolheria o interno)', async () => {
    const r = fakeResolver({ 'mixed.test': ['8.8.8.8', '127.0.0.1'] });
    expect((await validateProviderBaseUrl('https://mixed.test', r)).ok).toBe(false);
  });
});

describe('resolveAndPinHost — devolve o IP a PINAR (EST-1115 · PROV-SEC-1)', () => {
  it('host público ⇒ ok + pinnedIp validado', async () => {
    const r = fakeResolver({ 'gateway.test': ['8.8.8.8'] });
    const v = await resolveAndPinHost('https://gateway.test/v1/messages', r);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.host).toBe('gateway.test');
      expect(v.pinnedIp).toBe('8.8.8.8');
    }
  });

  it('host que resolve p/ metadata da cloud ⇒ recusa (não pina)', async () => {
    const r = fakeResolver({ 'rebind.test': ['169.254.169.254'] });
    const v = await resolveAndPinHost('https://rebind.test/v1', r);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/interno|metadata/i);
  });

  it('IP-literal interno direto ⇒ recusa sem resolver', async () => {
    const r = fakeResolver({});
    expect((await resolveAndPinHost('http://169.254.169.254/latest/meta-data', r)).ok).toBe(false);
  });

  it('fail-safe: host que NÃO resolve ⇒ recusa', async () => {
    const r = fakeResolver({});
    expect((await resolveAndPinHost('https://nope.test', r)).ok).toBe(false);
  });
});
