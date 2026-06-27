// EST-0948 · ADR-0069 — `QuotaClient`: `GET /v1/quota` (SEM body) → `Quota` (saldo de
// CRÉDITO + janelas). Mock do broker (SEM rede): contrato REAL
// `{windows:[{period,limit,used,remaining,reset_at}], credit:{balance}}`, estado dev
// vazio, GET-sem-body (#123 — o mock REJEITA body em GET), tolerância a versões.

import { describe, expect, it } from 'vitest';
import { QuotaClient } from '../../src/model/quota-client.js';
import { BrokerError, BrokerTransportError } from '../../src/model/errors.js';
import { makeBrokerFetch, type RecordedCall } from './helpers.js';

const BASE = 'https://broker.test';
const token = async (): Promise<string> => 'eyJ.fake.jwt';

function client(json: unknown, status = 200): { c: QuotaClient; calls: RecordedCall[] } {
  const { fetch, calls } = makeBrokerFetch({ status, json });
  return { c: new QuotaClient({ baseUrl: BASE, getAccessToken: token, fetch }), calls };
}

describe('QuotaClient — GET /v1/quota (EST-0948 · ADR-0069)', () => {
  it('windows POPULADAS + crédito ⇒ parseia 5h/semana (used/limit/reset) + balance', async () => {
    const { c } = client({
      windows: [
        {
          period: '5h',
          limit: '100000',
          used: '42000',
          remaining: '58000',
          reset_at: '2026-06-10T18:00:00+00:00',
        },
        {
          period: 'week',
          limit: '500000',
          used: '18000',
          remaining: '482000',
          reset_at: '2026-06-15T00:00:00+00:00',
        },
      ],
      credit: { balance: '42.118000' },
    });
    const quota = await c.fetchQuota();
    expect(quota?.windows.fiveHour).toMatchObject({ used: 42000, limit: 100000 });
    expect(quota?.windows.week).toMatchObject({ used: 18000, limit: 500000 });
    // reset normalizado p/ epoch ms.
    expect(quota?.windows.fiveHour?.resetAt).toBe(Date.parse('2026-06-10T18:00:00+00:00'));
    expect(quota?.credit?.balance).toBe('42.118000');
  });

  it('ESTADO DEV vazio (`{windows:[], credit:{balance:null}}`) ⇒ quota sem janela nem crédito', async () => {
    const { c } = client({ windows: [], credit: { balance: null } });
    const quota = await c.fetchQuota();
    // Não-undefined (leu OK), mas sem janela e sem crédito ⇒ o footer (formatQuota) oculta.
    expect(quota).toBeDefined();
    expect(quota?.windows.fiveHour).toBeUndefined();
    expect(quota?.windows.week).toBeUndefined();
    expect(quota?.credit).toBeUndefined();
  });

  it('GET NÃO manda body — o mock REJEITA body em GET (#123); só crédito presente', async () => {
    const { c, calls } = client({ windows: [], credit: { balance: '9.5' } });
    const quota = await c.fetchQuota();
    // Chegou aqui ⇒ o mock NÃO lançou "GET cannot have body" ⇒ o cliente OMITE body.
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.url).toBe(`${BASE}/v1/quota`);
    expect(quota?.credit?.balance).toBe('9.5');
  });

  it('janela ILIMITADA (`limit:null`) ⇒ descartada (sem %); crédito ainda parseia', async () => {
    const { c } = client({
      windows: [{ period: 'week', limit: null, used: '1000', remaining: null, reset_at: null }],
      credit: { balance: '3.0' },
    });
    const quota = await c.fetchQuota();
    expect(quota?.windows.week).toBeUndefined();
    expect(quota?.credit?.balance).toBe('3.0');
  });

  it('TOLERANTE a versões: campo EXTRA ignorado; campo a MENOS degrada', async () => {
    const { c } = client({
      windows: [
        // sem `remaining`/`reset_at` (a menos) + `foo` extra (a mais) ⇒ janela parcial OK.
        { period: '5h', limit: '100', used: '40', foo: 'bar' },
      ],
      credit: { balance: '1.0', currency: 'USD' /* extra */ },
      extra_top_level: 123, // a mais no topo ⇒ ignorado.
    });
    const quota = await c.fetchQuota();
    expect(quota?.windows.fiveHour).toMatchObject({ used: 40, limit: 100 });
    expect(quota?.windows.fiveHour?.resetAt).toBeUndefined();
    expect(quota?.credit?.balance).toBe('1.0');
  });

  it('non-2xx (401/403/404/5xx) ⇒ degrada a `undefined` (footer oculto, não derruba)', async () => {
    for (const status of [401, 403, 404, 500, 503]) {
      const { c } = client({ detail: 'nope' }, status);
      expect(await c.fetchQuota()).toBeUndefined();
    }
  });

  it('credencial indisponível (deslogado) ⇒ `undefined` sem nem chamar o broker', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, json: { windows: [] } });
    const failing = new QuotaClient({
      baseUrl: BASE,
      getAccessToken: async () => {
        throw new Error('SessionExpired');
      },
      fetch,
    });
    expect(await failing.fetchQuota()).toBeUndefined();
    expect(calls).toHaveLength(0); // não tentou a rede sem credencial.
  });

  it('corpo não-objeto / não-JSON ⇒ `undefined` (degrada)', async () => {
    const { c } = client('not-an-object');
    expect(await c.fetchQuota()).toBeUndefined();
  });
});

// ── fetchQuotaOrThrow (EST-1015) ──────────────────────────────────────────────

describe('QuotaClient.fetchQuotaOrThrow — 4 caminhos determinísticos (EST-1015)', () => {
  const VALID_QUOTA_BODY = {
    windows: [
      {
        period: '5h',
        limit: '100000',
        used: '42000',
        remaining: '58000',
        reset_at: '2026-06-10T18:00:00+00:00',
      },
      {
        period: 'week',
        limit: '500000',
        used: '18000',
        remaining: '482000',
        reset_at: '2026-06-15T00:00:00+00:00',
      },
    ],
    credit: { balance: '42.118000' },
  };

  it('(1) SUCESSO: fetch ok + JSON válido ⇒ resolve com a Quota parseada', async () => {
    const { c } = client(VALID_QUOTA_BODY, 200);
    const quota = await c.fetchQuotaOrThrow();
    expect(quota).toBeDefined();
    expect(quota?.windows.fiveHour).toMatchObject({ used: 42000, limit: 100000 });
    expect(quota?.windows.week).toMatchObject({ used: 18000, limit: 500000 });
    expect(quota?.credit?.balance).toBe('42.118000');
  });

  it('(2) TRANSPORTE: fetch lança ⇒ rejeita com BrokerTransportError', async () => {
    // fetch fake que SEMPRE lança
    const failingFetch = async (): Promise<never> => {
      throw new Error('socket hang up');
    };
    const c = new QuotaClient({
      baseUrl: BASE,
      getAccessToken: token,
      fetch: failingFetch,
    });
    await expect(c.fetchQuotaOrThrow()).rejects.toThrow(BrokerTransportError);
    // Verifica que a mensagem contém "transporte"
    await expect(c.fetchQuotaOrThrow()).rejects.toThrow(/transporte/i);
  });

  it('(3) !res.ok ⇒ rejeita com BrokerError (problem-details do status+corpo)', async () => {
    const problemBody = { code: 'INSUFFICIENT_CREDIT', detail: 'saldo insuficiente' };
    const { c } = client(problemBody, 402);
    let err: unknown;
    try {
      await c.fetchQuotaOrThrow();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).status).toBe(402);
    expect((err as BrokerError).code).toBe('INSUFFICIENT_CREDIT');
  });

  it('(4) CORPO INVÁLIDO: res.ok=true mas res.json() lança ⇒ rejeita com BrokerTransportError', async () => {
    // Fetch fake que devolve ok=true mas json() LANÇA
    const invalidJsonFetch: typeof fetch = async () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('bad json');
        },
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response);
    const c = new QuotaClient({
      baseUrl: BASE,
      getAccessToken: token,
      fetch: invalidJsonFetch as unknown as import('../../src/model/broker-client.js').StreamFetch,
    });
    await expect(c.fetchQuotaOrThrow()).rejects.toThrow(BrokerTransportError);
    await expect(c.fetchQuotaOrThrow()).rejects.toThrow(/inválido/i);
  });
});
