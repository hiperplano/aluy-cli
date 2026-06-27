// EST-0948 · ADR-0069 — o BROKER-CLIENT deriva a quota de JANELA dos campos ACHATADOS
// do evento `usage` (`quota_5h_*`/`quota_week_*`, broker#59 — path A) e a emite como
// evento `quota` / no `ModelCallResult.quota`. Mock do broker (SEM rede). O CRÉDITO NÃO
// vem por aqui (vem do `GET /v1/quota` — `QuotaClient`, testado à parte).

import { describe, expect, it } from 'vitest';
import { BrokerModelClient } from '../../src/model/broker-client.js';
import type { ModelCallRequest, ModelStreamEvent } from '../../src/model/types.js';
import { sseBody, makeBrokerFetch } from './helpers.js';

const BASE = 'https://broker.test';
const token = async (): Promise<string> => 'eyJ.fake.jwt';

function req(): ModelCallRequest {
  return { tier: 'aluy-strata', messages: [{ role: 'user', content: 'Oi' }] };
}

async function drain(gen: AsyncGenerator<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** SSE com o `usage` carregando os campos de quota ACHATADOS (como o broker REAL manda). */
function sseWithUsageQuota(usageExtra: Record<string, unknown>): string {
  return sseBody([
    { event: 'start', data: { request_id: 'r1', tier: 'aluy-strata', session_id: 's1' } },
    { event: 'delta', data: { content: 'Olá' } },
    {
      event: 'usage',
      data: { request_id: 'r1', tier: 'aluy-strata', tokens_in: 5, tokens_out: 3, ...usageExtra },
    },
    { event: 'done', data: { finish_reason: 'stop' } },
  ]);
}

const FULL_USAGE_QUOTA: Record<string, string> = {
  quota_5h_used: '42000',
  quota_5h_limit: '100000',
  quota_5h_remaining: '58000',
  quota_5h_reset_at: '2026-06-10T18:00:00+00:00',
  quota_week_used: '18000',
  quota_week_limit: '500000',
  quota_week_remaining: '482000',
  quota_week_reset_at: '2026-06-15T00:00:00+00:00',
};

describe('BrokerModelClient — quota de janela do evento `usage` (EST-0948 · ADR-0069)', () => {
  it('usage COM `quota_5h_*`/`quota_week_*` ⇒ emite evento `quota` (5h + semana) ANTES do `done`', async () => {
    const { fetch } = makeBrokerFetch({ status: 200, sse: sseWithUsageQuota(FULL_USAGE_QUOTA) });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const events = await drain(client.stream({ request: req() }));

    const quotaEvents = events.filter((e) => e.type === 'quota');
    expect(quotaEvents).toHaveLength(1);
    const q = (quotaEvents[0] as { type: 'quota'; quota: { windows: Record<string, unknown> } })
      .quota;
    expect(q.windows.fiveHour).toMatchObject({ used: 42000, limit: 100000 });
    expect(q.windows.week).toMatchObject({ used: 18000, limit: 500000 });

    // `quota` vem APÓS o `usage` mas ANTES de `done` (a TUI atualiza o footer no fechamento).
    const types = events.map((e) => e.type);
    expect(types.indexOf('usage')).toBeLessThan(types.indexOf('quota'));
    expect(types.indexOf('quota')).toBeLessThan(types.indexOf('done'));
  });

  it('call() agrega a quota em ModelCallResult.quota', async () => {
    const { fetch } = makeBrokerFetch({ status: 200, sse: sseWithUsageQuota(FULL_USAGE_QUOTA) });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const res = await client.call({ request: req() });
    expect(res.quota?.windows.fiveHour?.used).toBe(42000);
    expect(res.quota?.windows.week?.used).toBe(18000);
  });

  it('usage SEM campos de quota ⇒ NENHUM evento `quota` e result.quota undefined (degrada)', async () => {
    const { fetch } = makeBrokerFetch({ status: 200, sse: sseWithUsageQuota({}) });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const events = await drain(client.stream({ request: req() }));
    expect(events.some((e) => e.type === 'quota')).toBe(false);
    const res = await new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch }).call({
      request: req(),
    });
    expect(res.quota).toBeUndefined();
  });

  it('só a janela 5h (semana ilimitada, campos omitidos pelo broker) ⇒ quota só com 5h', async () => {
    const { fetch } = makeBrokerFetch({
      status: 200,
      sse: sseWithUsageQuota({
        quota_5h_used: '70000',
        quota_5h_limit: '100000',
        quota_5h_reset_at: '2026-06-10T14:00:00+00:00',
      }),
    });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const res = await client.call({ request: req() });
    expect(res.quota?.windows.fiveHour?.used).toBe(70000);
    expect(res.quota?.windows.week).toBeUndefined();
  });

  it('janela ILIMITADA (limit `null`/omitido) ⇒ janela descartada (sem % a mostrar)', async () => {
    const { fetch } = makeBrokerFetch({
      status: 200,
      sse: sseWithUsageQuota({
        // semana sem teto: o broker manda `used` mas `limit:null` ⇒ descarta (sem %).
        quota_week_used: '18000',
        quota_week_limit: null,
        quota_week_reset_at: null,
      }),
    });
    const client = new BrokerModelClient({ baseUrl: BASE, getAccessToken: token, fetch });
    const res = await client.call({ request: req() });
    // nenhuma janela com teto ⇒ result.quota undefined (nada a emitir).
    expect(res.quota).toBeUndefined();
  });
});
