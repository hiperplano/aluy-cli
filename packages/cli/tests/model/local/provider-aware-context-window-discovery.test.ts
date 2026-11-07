// F-WIN (descoberta) · F-PROV (fecha a lacuna DECLARADA da rc.117) — `discoverContextWindow`
// era construído em `run.tsx` FECHADO SÓ sobre `wireFormat`/`baseUrl`/credencial do
// provider do BOOT. Depois de um `/provider` bem-sucedido no meio da sessão, uma
// descoberta disparada para o slug ativo continuaria perguntando `GET {baseUrl}/models`
// ao provider ANTERIOR — endpoint/credencial errados, o mesmo defeito de fundo que o
// `switchLocalProvider` já corrigiu pro client de verdade.
//
// Esta bateria testa `createProviderAwareDiscoverContextWindowPort`
// (context-window-discovery.ts) — o wrapper que `run.tsx` agora usa pra montar
// `discoverContextWindow` — DIRETO, com `fetchImpl` fake por-provider (mesmo padrão de
// `context-window-discovery.test.ts`), simulando a MESMA disciplina de
// `switchLocalProvider`: o `getActiveProviderId` só muda depois de um "sucesso"
// simulado.

import { describe, expect, it, vi } from 'vitest';
import {
  createProviderAwareDiscoverContextWindowPort,
  type ProviderDiscoveryDeps,
} from '../../../src/model/local/context-window-discovery.js';
import type { ConnectivityFetch } from '../../../src/model/local/connectivity-check.js';

/** `fetchImpl` fake — devolve um corpo `/models` fixo, registrando cada URL pedida. */
function fakeFetch(body: unknown): { fetchImpl: ConnectivityFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: ConnectivityFetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

const LIST_A = { object: 'list', data: [{ id: 'modelo-livre', context_length: 111111 }] };
const LIST_B = { object: 'list', data: [{ id: 'modelo-livre', context_length: 222222 }] };

describe('F-PROV — createProviderAwareDiscoverContextWindowPort (fecha a lacuna de discoverContextWindow)', () => {
  it('(b) descoberta consulta o provider NOVO depois de um /provider bem-sucedido, não o do boot', async () => {
    const { fetchImpl: fetchA, calls: callsA } = fakeFetch(LIST_A);
    const { fetchImpl: fetchB, calls: callsB } = fakeFetch(LIST_B);
    const persistedByProvider: Record<string, [string, number][]> = { 'provider-a': [], 'provider-b': [] };

    let activeProviderId = 'provider-a';
    const depsForProvider = (providerId: string): ProviderDiscoveryDeps => {
      if (providerId === 'provider-a') {
        return {
          wireFormat: 'openai-compat',
          baseUrl: 'https://a.test/v1',
          fetchImpl: fetchA,
          getKey: async () => 'key-a',
          persistContextWindow: (slug, tokens) => {
            persistedByProvider['provider-a']!.push([slug, tokens]);
            return true;
          },
        };
      }
      return {
        wireFormat: 'openai-compat',
        baseUrl: 'https://b.test/v1',
        fetchImpl: fetchB,
        getKey: async () => 'key-b',
        persistContextWindow: (slug, tokens) => {
          persistedByProvider['provider-b']!.push([slug, tokens]);
          return true;
        },
      };
    };
    const port = createProviderAwareDiscoverContextWindowPort({
      getActiveProviderId: () => activeProviderId,
      depsForProvider,
    });

    // ANTES do /provider: descoberta pergunta ao provider do BOOT (provider-a).
    expect(await port('modelo-livre')).toEqual({ window: 111111, persisted: true });
    expect(callsA).toHaveLength(1);
    expect(callsA[0]).toBe('https://a.test/v1/models');
    expect(callsB).toHaveLength(0);
    expect(persistedByProvider['provider-a']).toEqual([['modelo-livre', 111111]]);

    // `/provider` troca com SUCESSO — a mutação de estado que `switchLocalProvider`
    // faz de verdade no `run.tsx`; aqui é o que a porta lê a cada chamada.
    activeProviderId = 'provider-b';

    // DEPOIS do /provider: o MESMO slug agora descobre pelo provider NOVO (b.test) —
    // número DIFERENTE, persistido na entrada CORRETA (provider-b, não provider-a).
    expect(await port('modelo-livre')).toEqual({ window: 222222, persisted: true });
    expect(callsB).toHaveLength(1);
    expect(callsB[0]).toBe('https://b.test/v1/models');
    expect(persistedByProvider['provider-b']).toEqual([['modelo-livre', 222222]]);
    // O provider A NUNCA foi consultado de novo (a porta dele já respondeu e ficou
    // memoizada) — cada provider paga NO MÁXIMO 1 chamada de rede por sessão (COND-S3).
    expect(callsA).toHaveLength(1);
  });

  it('memoiza a porta por-provider: reverter pro provider A de novo NÃO refaz a chamada de rede', async () => {
    const { fetchImpl: fetchA, calls: callsA } = fakeFetch(LIST_A);
    const { fetchImpl: fetchB } = fakeFetch(LIST_B);
    let activeProviderId = 'provider-a';
    const port = createProviderAwareDiscoverContextWindowPort({
      getActiveProviderId: () => activeProviderId,
      depsForProvider: (id) => ({
        wireFormat: 'openai-compat',
        baseUrl: id === 'provider-a' ? 'https://a.test/v1' : 'https://b.test/v1',
        fetchImpl: id === 'provider-a' ? fetchA : fetchB,
        getKey: async () => 'k',
      }),
    });

    await port('modelo-livre');
    activeProviderId = 'provider-b';
    await port('modelo-livre');
    activeProviderId = 'provider-a';
    await port('modelo-livre'); // MESMO provider de novo — porta memoizada, sem rede nova

    expect(callsA).toHaveLength(1);
  });

  it('(c) FAIL-OPEN (não fail-closed aqui de propósito): provider ativo sem baseUrl resolvível ⇒ "não descoberto", NUNCA lança nem consulta outro endpoint', async () => {
    // A descoberta é enfeite de status bar, não um caminho que arrisca credencial/
    // endpoint (ver o comentário de topo do módulo) — a política de falha correta é
    // FAIL-OPEN, ao contrário do `callerForLocalModel` (esse sim fail-CLOSED, ver
    // `provider-aware-local-child-caller-factory.test.ts`). Um provider ativo cujo
    // catálogo não resolve base_url (ex.: `findProvider` não achou a entrada) devolve
    // `baseUrl: ''` — a mesma forma que `run.tsx` produz (`entry?.baseUrl ?? ''`).
    const persist = vi.fn(() => true);
    const activeProviderId = 'ghost-provider';
    const port = createProviderAwareDiscoverContextWindowPort({
      getActiveProviderId: () => activeProviderId,
      depsForProvider: () => ({
        wireFormat: 'openai-compat',
        baseUrl: '',
        fetchImpl: async () => {
          throw new Error('NUNCA deveria tocar a rede com baseUrl vazio');
        },
        getKey: async () => 'k',
        persistContextWindow: persist,
      }),
    });

    await expect(port('modelo-livre')).resolves.toEqual({ window: 0, persisted: false });
    expect(persist).not.toHaveBeenCalled();
  });
});
