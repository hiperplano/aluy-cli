// F-PROV (fecha a lacuna DECLARADA da rc.117, PR #70/#71) — `callerForLocalModel`
// (ADR-0152 D6b) era construído em `run.tsx` FECHADO SÓ sobre o provider do BOOT. A
// rc.117 consertou o `/provider` p/ o client do PAI (`switchLocalProvider`) e o
// catálogo do `/model` (`localModelCatalog`), mas deixou DECLARADO no PR/CHANGELOG que
// a porta de ROTEAMENTO de sub-agente continuava presa ao provider do boot: um
// sub-agente roteado a modelo local, depois de um `/provider` bem-sucedido no meio da
// sessão, saía pelo endpoint/credencial do provider ANTERIOR — silenciosamente.
//
// Esta bateria testa `createProviderAwareLocalChildCallerFactory` (factory.ts) — o
// wrapper que `run.tsx` agora usa pra montar `callerForLocalModel` — DIRETO, com fetch
// fake por-provider (mesmo padrão de `local-child-caller-factory.test.ts`), simulando a
// MESMA disciplina de `switchLocalProvider`: o par `getActiveProviderId`/
// `getActiveCatalog` só muda depois de um "sucesso" simulado, nunca durante uma chamada
// em curso.

import { describe, expect, it } from 'vitest';
import { createProviderAwareLocalChildCallerFactory } from '../../../src/model/local/factory.js';
import type {
  StreamFetch,
  StreamResponse,
  ResolvedCredential,
  LocalProviderCatalog,
} from '@hiperplano/aluy-cli-core';

/** Catálogo de teste com DOIS providers (baseUrl distinto) — nunca o embutido real. */
const CATALOG: LocalProviderCatalog = {
  entries: [
    {
      id: 'provider-a',
      label: 'Provider A',
      wireFormat: 'openai-compat',
      baseUrl: 'https://a.test/v1',
      auth: ['apikey'],
      defaultModel: 'model-a-default',
      models: ['model-a-default'],
    },
    {
      id: 'provider-b',
      label: 'Provider B',
      wireFormat: 'openai-compat',
      baseUrl: 'https://b.test/v1',
      auth: ['apikey'],
      defaultModel: 'model-b-default',
      models: ['model-b-default'],
    },
  ],
};

interface RecordedCall {
  readonly url: string;
  readonly body: unknown;
}

/** `fetch` fake — devolve um SSE mínimo p/ qualquer request, registrando a URL pedida. */
function sseFetch(): { fetch: StreamFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: StreamFetch = async (url, init) => {
    calls.push({ url, body: init.body !== undefined ? JSON.parse(init.body) : undefined });
    const sse =
      'data: ' +
      JSON.stringify({ id: 'c1', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) +
      '\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(sse);
    const response: StreamResponse = {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: (async function* (): AsyncGenerator<Uint8Array> {
        yield bytes;
      })(),
      json: async () => ({}),
      text: async () => sse,
    };
    return response;
  };
  return { fetch, calls };
}

const fakeCredential = async (): Promise<ResolvedCredential> => ({ kind: 'apikey', secret: 'sk-test' });

describe('F-PROV — createProviderAwareLocalChildCallerFactory (fecha a lacuna de callerForLocalModel)', () => {
  it('(a) sub-agente roteado a modelo local usa o provider NOVO depois de um /provider bem-sucedido, não o do boot', async () => {
    const { fetch, calls } = sseFetch();
    // Estado mutável — MESMA disciplina de `activeLocalCatalog`/`activeLocalProviderId`
    // do run.tsx real: só muda depois de um "switch" bem-sucedido, nunca no meio de uma
    // chamada em curso.
    let activeProviderId = 'provider-a';
    const factory = createProviderAwareLocalChildCallerFactory({
      getActiveProviderId: () => activeProviderId,
      getActiveCatalog: () => CATALOG,
      bootProvider: 'provider-a',
      bootAuth: 'apikey',
      env: {},
      fetch,
      getCredential: fakeCredential,
    });

    // ANTES do /provider: o filho fala com o provider do BOOT (provider-a).
    const beforeSwitch = factory('modelo-livre');
    await beforeSwitch.call({ messages: [], idempotencyKey: 'k1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/^https:\/\/a\.test\//);

    // `/provider` troca com SUCESSO (o análogo de `switchLocalProvider` retornando
    // `ok:true` e o controller chamando `tierControl.setClient` — aqui só a MUTAÇÃO do
    // estado ativo que `callerForLocalModel` lê, que é o que este teste prova).
    activeProviderId = 'provider-b';

    // DEPOIS do /provider: o MESMO slug agora roteia pro provider NOVO (b.test), nunca
    // mais o antigo — a prova de que a porta lê o estado VIVO, não o congelado no boot.
    const afterSwitch = factory('modelo-livre');
    expect(afterSwitch).not.toBe(beforeSwitch); // fábricas DIFERENTES por provider
    await afterSwitch.call({ messages: [], idempotencyKey: 'k2' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toMatch(/^https:\/\/b\.test\//);
  });

  it('memoiza a fábrica por-provider: reverter pro provider A de novo reusa a MESMA instância (não revalida/reconstrói)', async () => {
    const { fetch } = sseFetch();
    let activeProviderId = 'provider-a';
    const factory = createProviderAwareLocalChildCallerFactory({
      getActiveProviderId: () => activeProviderId,
      getActiveCatalog: () => CATALOG,
      bootProvider: 'provider-a',
      bootAuth: 'apikey',
      env: {},
      fetch,
      getCredential: fakeCredential,
    });

    const a1 = factory('slug-x');
    activeProviderId = 'provider-b';
    factory('slug-x');
    activeProviderId = 'provider-a';
    const a2 = factory('slug-x');
    expect(a2).toBe(a1); // MESMO caller — a fábrica do provider A foi memoizada, não recriada
  });

  it('(c) FAIL-CLOSED: provider ativo ausente do catálogo ativo ⇒ erro EXPLÍCITO, nunca um roteamento silencioso p/ outro provider', async () => {
    const { fetch } = sseFetch();
    // `ghost-provider` não está em `CATALOG` — simula um estado vivo inconsistente
    // (ex.: `/provider` apontou p/ um id que sumiu do catálogo entre a resolução e a
    // chamada). A garantia de segurança: "falhar explicando" > "funcionar pelo endpoint
    // errado" — a fábrica NUNCA cai de volta no provider do boot por engano.
    const activeProviderId = 'ghost-provider';
    const factory = createProviderAwareLocalChildCallerFactory({
      getActiveProviderId: () => activeProviderId,
      getActiveCatalog: () => CATALOG,
      bootProvider: 'provider-a',
      bootAuth: 'apikey',
      env: {},
      fetch,
      getCredential: fakeCredential,
    });

    const caller = factory('slug-qualquer');
    await expect(caller.call({ messages: [], idempotencyKey: 'k' })).rejects.toThrow(/desconhecido/);
  });
});
