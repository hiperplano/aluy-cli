// EST-0962 · ADR-0076 — testes do ProvidersClient (CLI→broker `GET /v1/providers`).
//
// Cobre: parse do contrato `{object,data:[{name,adapter}]}`, auth (MESMO Bearer PAT
// headless do chat, mesmo endpoint), GET SEM body (a pegadinha #115/#123), tolerância
// (DADO_NÃO_CONFIÁVEL: name ausente ⇒ ignora; adapter faltando ⇒ ''; dedup; nunca lança
// no parse), HG-2/CLI-SEC-7 (descarta qualquer campo sensível — api_key_ref/base_url/
// markup), e a falha estruturada (não-2xx ⇒ BrokerError; transporte ⇒ BrokerTransportError).

import { describe, it, expect } from 'vitest';
import { ProvidersClient, parseProviders } from '../../src/model/providers-client.js';
import { BrokerError, BrokerTransportError } from '../../src/model/errors.js';
import { makeBrokerFetch } from './helpers.js';

const PROVIDERS = {
  object: 'list',
  data: [
    { name: 'deepseek', adapter: 'deepseek' },
    { name: 'openrouter', adapter: 'openrouter' },
    { name: 'tokenrouter', adapter: 'tokenrouter' },
  ],
};

function clientWith(handler: Parameters<typeof makeBrokerFetch>[0], token = 'pat-123') {
  const { fetch, calls } = makeBrokerFetch(handler);
  const client = new ProvidersClient({
    baseUrl: 'https://broker.test',
    getAccessToken: async () => token,
    fetch,
  });
  return { client, calls };
}

describe('ProvidersClient', () => {
  it('lê a lista e projeta {name,adapter} (o name é o que se envia no par Custom)', async () => {
    const { client } = clientWith({ status: 200, json: PROVIDERS });
    const providers = await client.list();
    expect(providers).toHaveLength(3);
    expect(providers[0]).toEqual({ name: 'deepseek', adapter: 'deepseek' });
    expect(providers.map((p) => p.name)).toContain('tokenrouter');
  });

  it('autentica com o MESMO Bearer PAT headless do chat, no GET /v1/providers', async () => {
    const { client, calls } = clientWith({ status: 200, json: PROVIDERS }, 'pat-xyz');
    await client.list();
    expect(calls[0]!.url).toBe('https://broker.test/v1/providers');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['authorization']).toBe('Bearer pat-xyz');
  });

  it('GET SEM body (#115/#123) — o GET não leva body (Node lançaria antes da rede)', async () => {
    const { client, calls } = clientWith({ status: 200, json: PROVIDERS });
    await expect(client.list()).resolves.toHaveLength(3);
    expect(calls[0]!.body).toBeUndefined();
  });

  it('não-2xx (401 sem scope/login) ⇒ BrokerError (chamador DEGRADA p/ fallback estático)', async () => {
    const { client } = clientWith({ status: 401, json: { detail: 'unauthorized' } });
    await expect(client.list()).rejects.toBeInstanceOf(BrokerError);
  });

  it('falha de transporte ⇒ BrokerTransportError (degradação do chamador)', async () => {
    const client = new ProvidersClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'pat',
      fetch: async () => {
        throw new Error('network down');
      },
    });
    await expect(client.list()).rejects.toBeInstanceOf(BrokerTransportError);
  });
});

describe('parseProviders — tolerância + HG-2', () => {
  it('entrada sem `name` ⇒ ignorada; `adapter` ausente ⇒ ""', () => {
    const out = parseProviders({
      data: [
        { adapter: 'x' }, // sem name ⇒ ignora
        { name: 'deepseek' }, // sem adapter ⇒ ''
      ],
    });
    expect(out).toEqual([{ name: 'deepseek', adapter: '' }]);
  });

  it('dedup por name (broker pode repetir)', () => {
    const out = parseProviders({
      data: [
        { name: 'openrouter', adapter: 'openrouter' },
        { name: 'openrouter', adapter: 'openrouter' },
      ],
    });
    expect(out).toHaveLength(1);
  });

  it('corpo não-list / lixo ⇒ [] (nunca lança)', () => {
    expect(parseProviders(null)).toEqual([]);
    expect(parseProviders({ data: 'nope' })).toEqual([]);
    expect(parseProviders({})).toEqual([]);
  });

  it('HG-2/CLI-SEC-7 — DESCARTA qualquer campo sensível extra (api_key_ref/base_url/markup)', () => {
    const out = parseProviders({
      data: [
        {
          name: 'deepseek',
          adapter: 'deepseek',
          // se um broker comprometido mandasse isto, NADA pode atravessar:
          api_key_ref: 'platform-deepseek',
          base_url: 'https://api.deepseek.com',
          markup: 1.4,
        },
      ],
    });
    expect(out).toEqual([{ name: 'deepseek', adapter: 'deepseek' }]);
    const raw = JSON.stringify(out);
    for (const forbidden of ['api_key_ref', 'platform-deepseek', 'base_url', 'markup']) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
