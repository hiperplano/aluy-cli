// EST-0962 — testes do TierCatalogClient (CLI→broker `GET /v1/tiers/catalog`).
//
// Cobre: parse do contrato (ADR-0030 §3), auth (Bearer headless igual ao chat),
// HG-2 (descarta qualquer campo sensível que o broker não devesse mandar), e a
// falha estruturada (não-2xx ⇒ BrokerError; transporte ⇒ BrokerTransportError).

import { describe, it, expect } from 'vitest';
import { TierCatalogClient, parseCatalog } from '../../src/model/catalog-client.js';
import { BrokerError, BrokerTransportError } from '../../src/model/errors.js';
import { makeBrokerFetch } from './helpers.js';

const CATALOG = {
  object: 'list',
  data: [
    {
      key: 'aluy-strata',
      display_name: 'Strata',
      cost_signal: 'standard',
      composition: [
        { name: 'Claude 3.5 Sonnet', family: 'Anthropic', role: 'principal', context: '200k' },
        { name: 'GPT-4o', family: 'OpenAI', role: 'reserva', context: '128k' },
      ],
    },
    {
      key: 'aluy-flux',
      display_name: 'Flux',
      cost_signal: 'economical',
      composition: [{ name: 'GPT-4o mini', family: 'OpenAI', role: 'principal', context: '128k' }],
    },
  ],
};

function clientWith(handler: Parameters<typeof makeBrokerFetch>[0], token = 'tok-123') {
  const { fetch, calls } = makeBrokerFetch(handler);
  const client = new TierCatalogClient({
    baseUrl: 'https://broker.test',
    getAccessToken: async () => token,
    fetch,
  });
  return { client, calls };
}

describe('TierCatalogClient', () => {
  it('lê o catálogo e projeta as entradas tipadas (ADR-0030 §3)', async () => {
    const { client } = clientWith({ status: 200, json: CATALOG });
    const tiers = await client.list();
    expect(tiers).toHaveLength(2);
    expect(tiers[0]).toMatchObject({
      key: 'aluy-strata',
      displayName: 'Strata',
      costSignal: 'standard',
    });
    expect(tiers[0]!.composition[0]).toEqual({
      name: 'Claude 3.5 Sonnet',
      family: 'Anthropic',
      role: 'principal',
      context: '200k',
    });
  });

  it('autentica com o MESMO Bearer headless do chat, no GET /v1/tiers/catalog', async () => {
    const { client, calls } = clientWith({ status: 200, json: CATALOG }, 'bearer-xyz');
    await client.list();
    expect(calls[0]!.url).toBe('https://broker.test/v1/tiers/catalog');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['authorization']).toBe('Bearer bearer-xyz');
  });

  it('GET SEM body (EST-0962) — o fetch real do Node lança se GET tem body, mesmo ""', async () => {
    // O fake (helpers) agora ESPELHA o Node: GET com body LANÇA. Se o cliente
    // voltasse a mandar `body: ''`, este `.list()` rejeitaria — a regressão é
    // pega aqui, não em produção (o catálogo silenciosamente degradava antes).
    const { client, calls } = clientWith({ status: 200, json: CATALOG });
    await expect(client.list()).resolves.toBeDefined();
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.body).toBeUndefined();
  });

  it('não-2xx ⇒ BrokerError estruturado (403 sem scope, 401 sem login)', async () => {
    const { client } = clientWith({ status: 403, json: { detail: 'forbidden' } });
    await expect(client.list()).rejects.toBeInstanceOf(BrokerError);
  });

  it('falha de transporte ⇒ BrokerTransportError (cai no fallback do chamador)', async () => {
    const client = new TierCatalogClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'tok',
      fetch: async () => {
        throw new Error('network down');
      },
    });
    await expect(client.list()).rejects.toBeInstanceOf(BrokerTransportError);
  });

  // ── EST-1015: 4 caminhos de erro do list() ──────────────────────────────

  it('(A) !res.ok (500) ⇒ BrokerError com status e code do problem-details', async () => {
    const problemBody = { code: 'PROVIDER_ERROR', detail: 'provedor externo falhou' };
    const { client } = clientWith({ status: 500, json: problemBody });
    let err: unknown;
    try {
      await client.list();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).status).toBe(500);
    expect((err as BrokerError).code).toBe('PROVIDER_ERROR');
  });

  it('(B) TRANSPORTE: fetch lança (socket) ⇒ BrokerTransportError', async () => {
    const client = new TierCatalogClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'tok',
      fetch: async () => {
        throw new Error('socket hang up');
      },
    });
    await expect(client.list()).rejects.toThrow(BrokerTransportError);
  });

  it('(C) CORPO INVÁLIDO: res.ok=true mas res.json() lança ⇒ BrokerTransportError', async () => {
    const invalidJsonFetch: import('../../src/model/broker-client.js').StreamFetch = async () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('bad json');
        },
        text: async () => '',
        headers: { get: () => null },
        body: null,
      } as unknown as import('../../src/model/broker-client.js').StreamResponse);
    const client = new TierCatalogClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'tok',
      fetch: invalidJsonFetch,
    });
    await expect(client.list()).rejects.toThrow(BrokerTransportError);
  });

  it('(D) SUCESSO: fetch ok + JSON válido ⇒ resolve com a lista parseada', async () => {
    const { client } = clientWith({ status: 200, json: CATALOG });
    const tiers = await client.list();
    expect(tiers).toHaveLength(2);
    expect(tiers[0]!.key).toBe('aluy-strata');
    expect(tiers[1]!.key).toBe('aluy-flux');
    expect(tiers[0]!.composition[0]!.name).toBe('Claude 3.5 Sonnet');
  });
});

describe('parseCatalog — guarda HG-2 estrutural no lado cliente', () => {
  it('DESCARTA qualquer campo sensível que o broker não devesse mandar', () => {
    const tampered = {
      object: 'list',
      data: [
        {
          key: 'aluy-deep',
          display_name: 'Deep',
          cost_signal: 'premium',
          // campos que o broker NUNCA serializa — se vazassem, não podem atravessar:
          api_key_ref: 'vault:openai-prod',
          base_url: 'https://api.openai.com',
          kind: 'openai',
          ownership: 'platform',
          composition: [
            {
              name: 'Claude Opus',
              family: 'Anthropic',
              role: 'principal',
              context: '200k',
              api_key_ref: 'vault:anthropic',
              base_url: 'https://api.anthropic.com',
            },
          ],
        },
      ],
    };
    const tiers = parseCatalog(tampered);
    const flat = JSON.stringify(tiers);
    expect(flat).not.toContain('api_key_ref');
    expect(flat).not.toContain('base_url');
    expect(flat).not.toContain('vault');
    expect(flat).not.toContain('api.openai.com');
    expect(flat).not.toContain('ownership');
    // só os campos públicos sobrevivem
    expect(tiers[0]).toMatchObject({
      key: 'aluy-deep',
      displayName: 'Deep',
      costSignal: 'premium',
    });
    expect(tiers[0]!.composition[0]).toEqual({
      name: 'Claude Opus',
      family: 'Anthropic',
      role: 'principal',
      context: '200k',
    });
  });

  it('corpo malformado (sem data) ⇒ lista vazia honesta', () => {
    expect(parseCatalog({})).toEqual([]);
    expect(parseCatalog(null)).toEqual([]);
    expect(parseCatalog({ data: 'nope' })).toEqual([]);
  });

  it('ignora entradas sem key e modelos sem name', () => {
    const tiers = parseCatalog({
      data: [
        { display_name: 'sem chave' },
        {
          key: 'aluy-x',
          composition: [{ family: 'OpenAI' }, { name: 'GPT-4o', family: 'OpenAI' }],
        },
      ],
    });
    expect(tiers).toHaveLength(1);
    expect(tiers[0]!.key).toBe('aluy-x');
    expect(tiers[0]!.composition).toHaveLength(1);
    expect(tiers[0]!.composition[0]!.name).toBe('GPT-4o');
  });
});
