// HUNT-IO-NET — edge de protocolo: o header `Retry-After` (RFC 7231 §7.1.3) pode ser
// `delta-seconds` OU um `HTTP-date`. O código antigo só fazia `Number(header)` ⇒ a
// forma DATA virava NaN e o hint de backoff do servidor era SILENCIOSAMENTE PERDIDO
// (o retry caía no exponencial puro). CDNs/proxies na frente do broker usam a forma
// data com frequência em 429/503. Agora as duas formas são tratadas.
//
// Verde não pegava: o único teste de Retry-After usava `'7'` (numérico) — a forma
// data nunca era exercida.
import { describe, expect, it } from 'vitest';
import { BrokerModelClient, parseRetryAfter } from '../../src/model/broker-client.js';
import { BrokerError } from '../../src/model/errors.js';
import { makeBrokerFetch } from './helpers.js';
import type { ModelStreamEvent, ModelCallRequest } from '../../src/model/types.js';

const BASE = 'https://broker.test';
const token = async (): Promise<string> => 'eyJ.fake.jwt';
const req = (): ModelCallRequest => ({
  tier: 'aluy-strata',
  messages: [{ role: 'user', content: 'Oi' }],
});

async function drain(gen: AsyncGenerator<ModelStreamEvent>): Promise<void> {
  for await (const _ of gen) void _;
}

describe('HUNT-IO-NET · parseRetryAfter (RFC 7231 — seconds OU HTTP-date)', () => {
  const NOW = Date.parse('2026-06-11T12:00:00Z');

  it('delta-seconds numérico ⇒ os segundos diretos', () => {
    expect(parseRetryAfter('7', NOW)).toBe(7);
    expect(parseRetryAfter('  120  ', NOW)).toBe(120);
  });

  it('HTTP-date no FUTURO ⇒ delta em segundos (antes virava NaN ⇒ perdido)', () => {
    // +90s no futuro.
    const future = new Date(NOW + 90_000).toUTCString();
    expect(parseRetryAfter(future, NOW)).toBe(90);
  });

  it('HTTP-date no PASSADO ⇒ 0 (retry já liberado), não negativo', () => {
    const past = new Date(NOW - 60_000).toUTCString();
    expect(parseRetryAfter(past, NOW)).toBe(0);
  });

  it('ausente / vazio / lixo ⇒ undefined (cai no exponencial)', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter('', NOW)).toBeUndefined();
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
  });

  it('429 com Retry-After em HTTP-date ⇒ BrokerError.retryAfter preenchido (não NaN)', async () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const { fetch } = makeBrokerFetch({
      status: 429,
      json: { status: 429, code: 'RATE_LIMITED' },
      headers: { 'retry-after': future },
    });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const err = (await drain(client.stream({ request: req() })).catch((e) => e)) as BrokerError;
    expect(err).toBeInstanceOf(BrokerError);
    // ~45s (folga p/ o relógio do teste avançar 1-2s).
    expect(err.retryAfter).toBeGreaterThanOrEqual(40);
    expect(err.retryAfter).toBeLessThanOrEqual(46);
  });
});
