// EST-0970 (--deep) — o teste do tier ao vivo: 1 chamada mínima ao modelo prova que o
// tier RESPONDE. NUNCA chama broker real — o `fetch` é mockado (stream SSE fake). Frugal.

import { describe, expect, it } from 'vitest';
import { testTierLive } from '../../src/doctor/tier-test.js';
import type { LoginService, StreamFetch } from '@hiperplano/aluy-cli-core';

const login = { getAccessToken: async () => 'tok' } as unknown as LoginService;
const env = { ALUY_BROKER_URL: 'https://broker.test' };

/** Stream de bytes a partir de uma string (mesmo shape de `Response.body` async-iterable). */
async function* bytes(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

/** `fetch` que devolve um SSE mínimo (start→delta→done) — o tier "respondeu". */
function sseOk(): StreamFetch {
  const sse =
    'event: start\ndata: {"request_id":"r1"}\n\n' +
    'event: delta\ndata: {"content":"ok"}\n\n' +
    'event: done\ndata: {"finish_reason":"stop"}\n\n';
  return (async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: bytes(sse),
    json: async () => ({}),
    text: async () => sse,
  })) as unknown as StreamFetch;
}

/** `fetch` que LANÇA (broker fora / transporte) ⇒ o tier "não respondeu". */
function transportDown(): StreamFetch {
  return (async () => {
    throw new Error('ECONNREFUSED broker');
  }) as unknown as StreamFetch;
}

describe('doctor/tier-test — teste do tier ao vivo (--deep)', () => {
  it('o tier RESPONDE ⇒ responded:true', async () => {
    const fact = await testTierLive({ tier: 'aluy-granito', login, env, fetch: sseOk() });
    expect(fact.tier).toBe('aluy-granito');
    expect(fact.responded).toBe(true);
  });

  it('broker fora ⇒ responded:false com a causa (NÃO lança)', async () => {
    const fact = await testTierLive({ tier: 'aluy-flux', login, env, fetch: transportDown() });
    expect(fact.responded).toBe(false);
    expect(fact.error).toBeTruthy();
  });
});
