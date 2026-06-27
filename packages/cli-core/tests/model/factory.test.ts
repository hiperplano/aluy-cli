import { describe, expect, it } from 'vitest';
import {
  createBrokerModelClient,
  createTierCatalogClient,
  createCustomModelClient,
  createQuotaClient,
} from '../../src/model/factory.js';
import { BrokerModelClient, type StreamFetch } from '../../src/model/broker-client.js';
import { TierCatalogClient } from '../../src/model/catalog-client.js';
import { CustomModelClient } from '../../src/model/custom-models-client.js';
import { QuotaClient } from '../../src/model/quota-client.js';
import type { LoginService } from '../../src/auth/login-service.js';
import { makeBrokerFetch, sseBody } from './helpers.js';

const SSE = sseBody([
  { event: 'start', data: { request_id: 'r1' } },
  { event: 'delta', data: { content: 'ok' } },
  { event: 'done', data: { finish_reason: 'stop' } },
]);

/** LoginService mínimo: só o que a factory usa (getAccessToken). */
function fakeLogin(token: string): LoginService {
  return { getAccessToken: async () => token } as unknown as LoginService;
}

describe('createBrokerModelClient', () => {
  it('compõe um BrokerModelClient que usa LoginService.getAccessToken como credencial', async () => {
    const { fetch, calls } = makeBrokerFetch({ status: 200, sse: SSE });
    const client = createBrokerModelClient({
      brokerBaseUrl: 'https://broker.test',
      login: fakeLogin('pat_deadbeefdeadbeefdeadbeefdeadbeef_s3cr3t'),
      fetch,
    });
    expect(client).toBeInstanceOf(BrokerModelClient);

    const res = await client.call({ request: { tier: 'aluy-strata', messages: [] } });
    expect(res.content).toBe('ok');
    // A credencial headless (aqui um PAT) foi apresentada ao broker.
    expect(calls[0]?.headers['authorization']).toBe(
      'Bearer pat_deadbeefdeadbeefdeadbeefdeadbeef_s3cr3t',
    );
  });
});

describe('createCustomModelClient (EST-0962)', () => {
  it('compõe um CustomModelClient que usa LoginService.getAccessToken (MESMO PAT do chat)', async () => {
    const { fetch, calls } = makeBrokerFetch({
      status: 200,
      json: { object: 'list', data: [{ id: 'meta-llama/llama-3.1-8b-instruct' }] },
    });
    const client = createCustomModelClient({
      brokerBaseUrl: 'https://broker.test',
      login: fakeLogin('pat_deadbeefdeadbeefdeadbeefdeadbeef_s3cr3t'),
      fetch,
    });
    expect(client).toBeInstanceOf(CustomModelClient);

    const models = await client.list();
    expect(models[0]?.id).toBe('meta-llama/llama-3.1-8b-instruct');
    // Endpoint DEDICADO + a MESMA credencial headless (PAT) do chat.
    expect(calls[0]?.url).toBe('https://broker.test/v1/models/custom');
    expect(calls[0]?.headers['authorization']).toBe(
      'Bearer pat_deadbeefdeadbeefdeadbeefdeadbeef_s3cr3t',
    );
  });
});

describe('createTierCatalogClient (EST-1015)', () => {
  const OPTS = {
    brokerBaseUrl: 'http://localhost:8121',
    login: { getAccessToken: async () => 'token-fake' } as LoginService,
  };

  it('devolve uma instância de TierCatalogClient com opts mínimo', () => {
    const client = createTierCatalogClient(OPTS);
    expect(client).toBeInstanceOf(TierCatalogClient);
  });

  it('aceita fetch injetado e ainda devolve TierCatalogClient', () => {
    const client = createTierCatalogClient({
      ...OPTS,
      fetch: (async () => ({})) as unknown as StreamFetch,
    });
    expect(client).toBeInstanceOf(TierCatalogClient);
  });
});

describe('createQuotaClient (EST-1015)', () => {
  const OPTS = {
    brokerBaseUrl: 'http://localhost:8121',
    login: { getAccessToken: async () => 'token-fake' } as LoginService,
  };

  it('devolve uma instância de QuotaClient com opts mínimo', () => {
    const client = createQuotaClient(OPTS);
    expect(client).toBeInstanceOf(QuotaClient);
  });

  it('aceita fetch injetado e ainda devolve QuotaClient', () => {
    const client = createQuotaClient({
      ...OPTS,
      fetch: (async () => ({})) as unknown as StreamFetch,
    });
    expect(client).toBeInstanceOf(QuotaClient);
  });
});
