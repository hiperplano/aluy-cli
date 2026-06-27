// EST-0969 (anti-runaway) — o ACUMULADOR de stream do core (BrokerModelClient.call)
// alimenta a guarda anti-repetição a cada delta; um stream degenerado (mesma linha
// repetida em muitos eventos `delta`) ⇒ `call()` LANÇA DegenerateLoopError e PARA
// de drenar o stream (aborta). Stream normal ⇒ agrega como sempre (sem regressão).
import { describe, expect, it } from 'vitest';
import { BrokerModelClient } from '../../src/model/broker-client.js';
import { DegenerateLoopError } from '../../src/agent/degeneration.js';
import type { ModelCallRequest } from '../../src/model/types.js';
import { makeBrokerFetch, sseBody } from './helpers.js';

const BASE = 'https://broker.test';
const token = async (): Promise<string> => 'eyJhbGciOiJ.payload.sig';
const req: ModelCallRequest = { tier: 'aluy-strata', messages: [{ role: 'user', content: 'oi' }] };

/** SSE com `start` + `n` deltas iguais + (talvez) `done`. */
function degenerateSse(line: string, n: number): string {
  const events: { event: string; data: unknown }[] = [
    { event: 'start', data: { request_id: 'r1', tier: 'aluy-strata', session_id: 's1' } },
  ];
  for (let i = 0; i < n; i++) events.push({ event: 'delta', data: { content: `${line}\n` } });
  events.push({ event: 'done', data: { finish_reason: 'stop' } });
  return sseBody(events);
}

describe('EST-0969 · BrokerModelClient.call — guarda anti-repetição no acumulador', () => {
  it('stream com a mesma linha repetida 40× ⇒ call() lança DegenerateLoopError', async () => {
    const { fetch } = makeBrokerFetch({
      status: 200,
      sse: degenerateSse('<<<EDIT_STDIN>/>/>', 40),
    });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    await expect(client.call({ request: req })).rejects.toBeInstanceOf(DegenerateLoopError);
  });

  it('stream NORMAL e curto ⇒ agrega normalmente (sem regressão)', async () => {
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
