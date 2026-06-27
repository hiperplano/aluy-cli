import { describe, it, expect } from 'vitest';
import { TelegramConnector } from '../../src/connector/telegram-connector.js';
import { TelegramClient } from '../../src/connector/telegram-client.js';
import { classifyConnectorIngress, TELEGRAM_META } from '@hiperplano/aluy-cli-core';

const TOKEN = '123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345';

function clientWith(responses: unknown[], sendSink?: { url: string; body: unknown }[]) {
  let i = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/sendMessage')) {
      sendSink?.push({ url, body: JSON.parse(String(init?.body)) });
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: true, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return new TelegramClient({ token: TOKEN, fetchFn: fn });
}

describe('TelegramConnector — impl da porta Connector (ADR-0135 §1)', () => {
  it('meta é o do Telegram (authIsForgeable=false)', () => {
    const c = new TelegramConnector(clientWith([{ ok: true, result: [] }]));
    expect(c.meta).toEqual(TELEGRAM_META);
    expect(c.meta.authIsForgeable).toBe(false);
  });

  it('incoming() mapeia updates → IncomingMessage que a malha classifica', async () => {
    const client = clientWith([
      { ok: true, result: [{ update_id: 1, message: { chat: { id: 100, type: 'private' }, from: { id: 100 }, text: 'rode' } }] },
      { ok: true, result: [] },
    ]);
    const ac = new AbortController();
    const conn = new TelegramConnector(client, { signal: ac.signal });
    let first;
    for await (const msg of conn.incoming()) {
      first = msg;
      ac.abort();
      break;
    }
    expect(first).toMatchObject({ content: 'rode', sender: '100', conversation: '100' });
    // a malha autoriza esse chat-id ⇒ instrução
    const dec = classifyConnectorIngress(first!, new Set(['100']), TELEGRAM_META);
    expect(dec.kind).toBe('instruction');
  });

  it('send() usa o conversation-ref (chat-id) como alvo travado', async () => {
    const sends: { url: string; body: unknown }[] = [];
    const client = clientWith([{ ok: true, result: [] }], sends);
    const conn = new TelegramConnector(client);
    await conn.send({ content: 'oi de volta', conversation: '100' });
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).toEqual({ chat_id: 100, text: 'oi de volta' });
  });

  it('send() com ref inválido ⇒ no-op (não chama a rede)', async () => {
    const sends: { url: string; body: unknown }[] = [];
    const client = clientWith([{ ok: true, result: [] }], sends);
    const conn = new TelegramConnector(client);
    await conn.send({ content: 'x', conversation: 'não-numérico' });
    expect(sends).toHaveLength(0);
  });
});
