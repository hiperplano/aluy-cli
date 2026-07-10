// ADR-0152 (D6b) · T4 — `createLocalChildCallerFactory`: a porta que o `run.tsx`
// constrói p/ `callerForLocalModel(slug)`. Fecha SÓ sobre {catalog, provider, auth,
// baseUrl, env, oauthAccessToken} já resolvidos no BOOT do pai — o `model` do
// `LocalModelClient` do FILHO é o `slug` pedido (nunca outra coisa). NÃO recebe
// `fetch`/`getCredential` explícitos deste teste em produção (herda os defaults do
// `buildLocalModelClient`: fetch PINADO + `createLocalCredentialProvider`); aqui
// injetamos fakes SÓ p/ observar o request sem tocar rede real (mesmo padrão de
// `packages/cli/tests/model/local/factory.test.ts`).

import { describe, expect, it } from 'vitest';
import { createLocalChildCallerFactory } from '../../../src/model/local/factory.js';
import type { StreamFetch, StreamResponse, ResolvedCredential } from '@hiperplano/aluy-cli-core';

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function sseFetch(): { fetch: StreamFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: StreamFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body !== undefined ? JSON.parse(init.body) : undefined,
    });
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

describe('ADR-0152 (D6b) · T4 — createLocalChildCallerFactory', () => {
  it('produz um client com o MESMO provider/auth/baseUrl do BASE + config.model === slug; credential provider = o do boot', async () => {
    const { fetch, calls } = sseFetch();
    let credentialCalls = 0;
    const getCredential = async (): Promise<ResolvedCredential> => {
      credentialCalls += 1;
      return { kind: 'apikey', secret: 'sk-boot' };
    };

    const factory = createLocalChildCallerFactory({
      provider: 'openai', // provider do CATÁLOGO — mesmo que o pai (nunca de DADO/spawn)
      auth: 'apikey',
      env: {},
      fetch,
      getCredential,
    });

    const caller = factory('deepseek-v4-flash');
    const result = await caller.call({ messages: [], idempotencyKey: 'k' });

    expect(result.content).toBe('ok');
    expect(calls).toHaveLength(1);
    // MESMO base_url do provider do BASE (catálogo openai) — nunca outro endpoint.
    expect(calls[0]!.url).toMatch(/api\.openai\.com/);
    // SÓ o `model` muda p/ o slug pedido — nada mais no corpo aponta p/ outro provider.
    expect((calls[0]!.body as { model?: string }).model).toBe('deepseek-v4-flash');
    // credential provider = o MESMO injetado no `base` (o do boot) — chamado 1x.
    expect(credentialCalls).toBe(1);
  });

  it('slugs DIFERENTES ⇒ callers DIFERENTES, cada um com o SEU model — nunca cruzam', async () => {
    const { fetch, calls } = sseFetch();
    const getCredential = async (): Promise<ResolvedCredential> => ({
      kind: 'apikey',
      secret: 'sk-boot',
    });
    const factory = createLocalChildCallerFactory({
      provider: 'openai',
      auth: 'apikey',
      env: {},
      fetch,
      getCredential,
    });

    const flash = factory('deepseek-v4-flash');
    const pro = factory('deepseek-v4-pro');
    expect(flash).not.toBe(pro);

    await flash.call({ messages: [], idempotencyKey: 'k1' });
    await pro.call({ messages: [], idempotencyKey: 'k2' });

    expect(calls.map((c) => (c.body as { model?: string }).model)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ]);
  });

  it('MESMO slug pedido 2x ⇒ MEMOIZA o caller (mesma instância) — não reconstrói o client a cada spawn', async () => {
    const { fetch } = sseFetch();
    const getCredential = async (): Promise<ResolvedCredential> => ({
      kind: 'apikey',
      secret: 'sk-boot',
    });
    const factory = createLocalChildCallerFactory({
      provider: 'openai',
      auth: 'apikey',
      env: {},
      fetch,
      getCredential,
    });
    const a = factory('deepseek-v4-flash');
    const b = factory('deepseek-v4-flash');
    expect(a).toBe(b);
  });

  it('NUNCA aceita provider/base_url/api_key de fora do `base` (só o slug varia por chamada)', () => {
    // A ASSINATURA em si é a garantia estrutural (condição de segurança 1): a
    // fábrica devolvida por `createLocalChildCallerFactory` só aceita `(slug:
    // string)` — não há como um chamador (controller/spawner) passar provider/
    // base_url/credencial por essa via. Prova de tipo/contrato, não de runtime.
    const factory = createLocalChildCallerFactory({
      provider: 'openai',
      auth: 'apikey',
      env: {},
      fetch: sseFetch().fetch,
      getCredential: async (): Promise<ResolvedCredential> => ({ kind: 'apikey', secret: 'x' }),
    });
    expect(factory.length).toBe(1); // aridade 1 — só `slug`.
  });
});
