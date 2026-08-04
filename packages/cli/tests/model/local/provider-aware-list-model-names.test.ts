// F-MODEL-LIVE — `createProviderAwareListModelNamesPort` (context-window-discovery.ts):
// a lista VIVA de nomes segue o PROVIDER ATIVO da sessão (não um valor congelado no
// boot), MESMA disciplina de `createProviderAwareDiscoverContextWindowPort` (ver
// `provider-aware-context-window-discovery.test.ts`, o irmão desta bateria). Um
// `/provider` bem-sucedido no meio da sessão troca o `getActiveProviderId()`; a
// PRÓXIMA abertura do `<LocalModelPicker>` tem que listar os modelos do provider NOVO,
// nunca os do anterior.

import { describe, expect, it } from 'vitest';
import {
  createProviderAwareListModelNamesPort,
  type ProviderDiscoveryDeps,
} from '../../../src/model/local/context-window-discovery.js';
import type { ConnectivityFetch } from '../../../src/model/local/connectivity-check.js';

function fakeFetch(body: unknown): { fetchImpl: ConnectivityFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: ConnectivityFetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

const LIST_A = {
  object: 'list',
  data: [{ id: 'provider-a/modelo-1' }, { id: 'provider-a/modelo-2' }],
};
const LIST_B = { object: 'list', data: [{ id: 'provider-b/modelo-1' }] };

describe('F-MODEL-LIVE — createProviderAwareListModelNamesPort', () => {
  it('lista o provider ATIVO agora, não o do boot — depois de um /provider bem-sucedido troca de fonte', async () => {
    const { fetchImpl: fetchA, calls: callsA } = fakeFetch(LIST_A);
    const { fetchImpl: fetchB, calls: callsB } = fakeFetch(LIST_B);
    let activeProviderId = 'provider-a';
    const depsForProvider = (providerId: string): ProviderDiscoveryDeps =>
      providerId === 'provider-a'
        ? {
            wireFormat: 'openai-compat',
            baseUrl: 'https://a.test/v1',
            fetchImpl: fetchA,
            getKey: async () => 'k-a',
          }
        : {
            wireFormat: 'openai-compat',
            baseUrl: 'https://b.test/v1',
            fetchImpl: fetchB,
            getKey: async () => 'k-b',
          };
    const port = createProviderAwareListModelNamesPort({
      getActiveProviderId: () => activeProviderId,
      depsForProvider,
    });

    const r1 = await port();
    expect(r1).toEqual({ names: ['provider-a/modelo-1', 'provider-a/modelo-2'], ok: true });
    expect(callsA).toHaveLength(1);
    expect(callsA[0]).toBe('https://a.test/v1/models');
    expect(callsB).toHaveLength(0);

    activeProviderId = 'provider-b'; // MESMA mutação que `switchLocalProvider` faz de verdade
    const r2 = await port();
    expect(r2).toEqual({ names: ['provider-b/modelo-1'], ok: true });
    expect(callsB).toHaveLength(1);
    expect(callsB[0]).toBe('https://b.test/v1/models');
    // O provider A não foi consultado de novo — memoizado por-provider.
    expect(callsA).toHaveLength(1);
  });

  it('memoiza por-provider: reverter pro provider A de novo NÃO refaz a chamada de rede', async () => {
    const { fetchImpl: fetchA, calls: callsA } = fakeFetch(LIST_A);
    const { fetchImpl: fetchB } = fakeFetch(LIST_B);
    let activeProviderId = 'provider-a';
    const port = createProviderAwareListModelNamesPort({
      getActiveProviderId: () => activeProviderId,
      depsForProvider: (id) => ({
        wireFormat: 'openai-compat',
        baseUrl: id === 'provider-a' ? 'https://a.test/v1' : 'https://b.test/v1',
        fetchImpl: id === 'provider-a' ? fetchA : fetchB,
        getKey: async () => 'k',
      }),
    });

    await port();
    activeProviderId = 'provider-b';
    await port();
    activeProviderId = 'provider-a';
    await port(); // mesmo provider de novo — sem rede nova

    expect(callsA).toHaveLength(1);
  });

  it('provider ativo sem baseUrl resolvível ⇒ fallback honesto, NUNCA lança nem consulta outro endpoint', async () => {
    const port = createProviderAwareListModelNamesPort({
      getActiveProviderId: () => 'ghost-provider',
      depsForProvider: () => ({
        wireFormat: 'openai-compat',
        baseUrl: '',
        fetchImpl: async () => {
          throw new Error('NUNCA deveria tocar a rede com baseUrl vazio');
        },
        getKey: async () => 'k',
      }),
    });
    await expect(port()).resolves.toEqual({ names: [], ok: false });
  });
});
