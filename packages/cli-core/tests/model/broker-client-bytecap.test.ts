// EST-1010 (BUG-0020) — o ACUMULADOR de stream do core (BrokerModelClient.call)
// aplica um TETO de BYTES: um stream gigante NÃO-repetitivo (a guarda de degeneração
// não pega, porque o conteúdo não se repete) é CORTADO no teto — `content` fica
// bounded e `finish_reason` marca o corte client-side. Stream normal ⇒ intacto.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrokerModelClient } from '../../src/model/broker-client.js';
import type { ModelCallRequest } from '../../src/model/types.js';
import { makeBrokerFetch, sseBody } from './helpers.js';

const BASE = 'https://broker.test';
const token = async (): Promise<string> => 'eyJhbGciOiJ.payload.sig';
const req: ModelCallRequest = { tier: 'aluy-strata', messages: [{ role: 'user', content: 'oi' }] };

/** SSE com `start` + `n` deltas ÚNICOS (não-repetitivos) + `done`. ~64 B por delta. */
function hugeUniqueSse(n: number): string {
  const events: { event: string; data: unknown }[] = [
    { event: 'start', data: { request_id: 'r1', tier: 'aluy-strata', session_id: 's1' } },
  ];
  for (let i = 0; i < n; i++) {
    events.push({ event: 'delta', data: { content: `bloco-${i}-${'y'.repeat(50)}-${i}\n` } });
  }
  events.push({ event: 'done', data: { finish_reason: 'stop' } });
  return sseBody(events);
}

describe('EST-1010 · BrokerModelClient.call — teto de bytes (stream gigante não-repetitivo)', () => {
  const PREV = process.env.ALUY_STREAM_MAX_BYTES;
  beforeEach(() => {
    process.env.ALUY_STREAM_MAX_BYTES = String(4 * 1024); // 4 KiB p/ o teste.
  });
  afterEach(() => {
    if (PREV === undefined) delete process.env.ALUY_STREAM_MAX_BYTES;
    else process.env.ALUY_STREAM_MAX_BYTES = PREV;
  });

  it('deltas únicos que somam > teto ⇒ content BOUNDED + finish_reason de corte', async () => {
    // 1000 deltas × ~64 B ≈ 64 KiB >> 4 KiB de teto. Sem repetição ⇒ a guarda de
    // degeneração NÃO dispara; só o teto de bytes corta.
    const { fetch } = makeBrokerFetch({ status: 200, sse: hugeUniqueSse(1000) });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });

    const res = await client.call({ request: req });

    const bytes = Buffer.byteLength(res.content, 'utf8');
    expect(bytes).toBeGreaterThan(4 * 1024); // cruzou o teto
    expect(bytes).toBeLessThan(4 * 1024 + 1024); // mas é bounded — não os 64 KiB inteiros
    expect(res.finish_reason).toBe('length_client_cap');
  });

  it('stream NORMAL e curto ⇒ agrega normalmente (sem regressão; finish_reason intacto)', async () => {
    const sse = sseBody([
      { event: 'start', data: { request_id: 'r1', tier: 'aluy-strata' } },
      { event: 'delta', data: { content: 'Olá' } },
      { event: 'delta', data: { content: ', mundo!' } },
      { event: 'done', data: { finish_reason: 'stop' } },
    ]);
    const { fetch } = makeBrokerFetch({ status: 200, sse });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const res = await client.call({ request: req });
    expect(res.content).toBe('Olá, mundo!');
    expect(res.finish_reason).toBe('stop');
  });
});
