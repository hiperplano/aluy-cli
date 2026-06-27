// ADR-0120 / EST-1113 — fábrica do backend local (adapter + anti-SSRF do base_url).
import { describe, expect, it } from 'vitest';
import { buildLocalModelClient } from '../../../src/model/local/factory.js';
import { buildLocalCatalog } from '@hiperplano/aluy-cli-core';
import type { StreamFetch } from '@hiperplano/aluy-cli-core';
import type { ResolvedCredential } from '@hiperplano/aluy-cli-core';

const cred = async (): Promise<ResolvedCredential> => ({ kind: 'apikey', secret: 'sk' });
const noFetch: StreamFetch = async () => {
  throw new Error('não deveria chamar a rede neste teste');
};

describe('buildLocalModelClient', () => {
  it('monta um client p/ anthropic com base_url default (sem override ⇒ sem anti-SSRF)', async () => {
    const client = await buildLocalModelClient({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      getCredential: cred,
      fetch: noFetch,
    });
    expect(client).toBeDefined();
  });

  it('monta openrouter e openai (adapters distintos)', async () => {
    for (const provider of ['openrouter', 'openai'] as const) {
      const client = await buildLocalModelClient({
        provider,
        model: 'm',
        getCredential: cred,
        fetch: noFetch,
      });
      expect(client).toBeDefined();
    }
  });

  // ADR-0118 — provider do catálogo embutido (deepseek/openai-compat) monta sem código novo.
  it('monta um provider do catálogo embutido (deepseek) — base_url do catálogo', async () => {
    const client = await buildLocalModelClient({
      provider: 'deepseek',
      model: 'deepseek-chat',
      getCredential: cred,
      fetch: noFetch,
    });
    expect(client).toBeDefined();
  });

  // ADR-0118 — provider INJETADO pelo catálogo do usuário (não está no embutido).
  it('monta um provider do catálogo INJETADO (usuário) por wireFormat', async () => {
    const catalog = buildLocalCatalog([
      {
        id: 'myvendor',
        wireFormat: 'openai-compat',
        baseUrl: 'https://my.vendor/v1',
        auth: 'apikey',
        defaultModel: 'm',
      },
    ]);
    const resolver = { resolve: async () => ['8.8.8.8'] };
    const client = await buildLocalModelClient({
      provider: 'myvendor',
      model: 'm',
      getCredential: cred,
      fetch: noFetch,
      resolver,
      catalog,
    });
    expect(client).toBeDefined();
  });

  it('provider DESCONHECIDO sem base_url ⇒ erro claro (não está no catálogo)', async () => {
    await expect(
      buildLocalModelClient({
        provider: 'nao-existe',
        model: 'm',
        getCredential: cred,
        fetch: noFetch,
      }),
    ).rejects.toThrow(/desconhecido|catálogo/i);
  });

  it('REJEITA um base_url override que resolve p/ alvo interno (PROV-SEC-1)', async () => {
    const resolver = { resolve: async () => ['127.0.0.1'] };
    await expect(
      buildLocalModelClient({
        provider: 'openai',
        model: 'm',
        baseUrl: 'https://evil.test/v1',
        getCredential: cred,
        fetch: noFetch,
        resolver,
      }),
    ).rejects.toThrow(/PROV-SEC-1|anti-SSRF|interno/i);
  });

  it('ACEITA um base_url override que resolve p/ IP público', async () => {
    const resolver = { resolve: async () => ['8.8.8.8'] };
    const client = await buildLocalModelClient({
      provider: 'openai',
      model: 'm',
      baseUrl: 'https://gateway.test/v1',
      getCredential: cred,
      fetch: noFetch,
      resolver,
    });
    expect(client).toBeDefined();
  });
});
