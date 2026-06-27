import { describe, it, expect } from 'vitest';
import { TelegramClient } from '../../src/connector/telegram-client.js';

const TOKEN = '123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345';

/** fetch fake que devolve respostas pré-programadas por rodada + registra as URLs. */
function fakeFetch(responses: unknown[]) {
  const urls: string[] = [];
  let i = 0;
  const fn = (async (url: string) => {
    urls.push(url);
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: true,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, urls };
}

describe('TelegramClient — long-poll concreto (ADR-0134 §4)', () => {
  it('poll: parseia e AVANÇA o offset (offset vai na próxima URL)', async () => {
    const { fn, urls } = fakeFetch([
      { ok: true, result: [{ update_id: 5, message: { chat: { id: 1 }, text: 'a' } }] },
      { ok: true, result: [] },
    ]);
    const c = new TelegramClient({ token: TOKEN, fetchFn: fn });
    const first = await c.poll();
    expect(first).toEqual([{ chatId: 1, fromId: 1, text: 'a' }]);
    await c.poll();
    expect(urls[0]).toContain('offset=0');
    expect(urls[1]).toContain('offset=6'); // avançou p/ update_id+1
  });

  it('a URL embute o token; o redactedToken NÃO vaza o auth', () => {
    const { fn } = fakeFetch([{ ok: true, result: [] }]);
    const c = new TelegramClient({ token: TOKEN, fetchFn: fn });
    expect(c.redactedToken).toContain('123456789:');
    expect(c.redactedToken).not.toContain('AAHk');
  });

  it('HTTP não-2xx ⇒ [] e NÃO avança offset (tenta de novo)', async () => {
    const fn = (async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const c = new TelegramClient({ token: TOKEN, fetchFn: fn });
    expect(await c.poll()).toEqual([]);
  });

  it('fetch lança (rede caiu) ⇒ [] fail-safe (não derruba)', async () => {
    const fn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const c = new TelegramClient({ token: TOKEN, fetchFn: fn });
    await expect(c.poll()).resolves.toEqual([]);
  });

  it('stream: produz updates e PARA quando o signal aborta', async () => {
    const { fn } = fakeFetch([
      { ok: true, result: [{ update_id: 1, message: { chat: { id: 1 }, text: 'um' } }] },
      { ok: true, result: [{ update_id: 2, message: { chat: { id: 1 }, text: 'dois' } }] },
    ]);
    const ac = new AbortController();
    const c = new TelegramClient({ token: TOKEN, fetchFn: fn });
    const got: string[] = [];
    for await (const u of c.stream(ac.signal)) {
      got.push(u.text);
      if (got.length >= 2) ac.abort(); // para após 2
    }
    expect(got).toEqual(['um', 'dois']);
  });

  it('send: POST sendMessage com chat_id+text; ok:true ⇒ true', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }) as unknown as typeof fetch;
    const c = new TelegramClient({ token: TOKEN, fetchFn: fn });
    const ok = await c.send(777, 'resposta');
    expect(ok).toBe(true);
    expect(calls[0]?.url).toContain('/sendMessage');
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({ chat_id: 777, text: 'resposta' });
  });

  it('send: HTTP não-2xx ou ok:false ⇒ false (fail-safe)', async () => {
    const c1 = new TelegramClient({
      token: TOKEN,
      fetchFn: (async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch,
    });
    expect(await c1.send(1, 'x')).toBe(false);
    const c2 = new TelegramClient({
      token: TOKEN,
      fetchFn: (async () => ({ ok: true, json: async () => ({ ok: false }) }) as Response) as unknown as typeof fetch,
    });
    expect(await c2.send(1, 'x')).toBe(false);
  });

  it('send: rede caiu ⇒ false (não lança)', async () => {
    const c = new TelegramClient({
      token: TOKEN,
      fetchFn: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    await expect(c.send(1, 'x')).resolves.toBe(false);
  });
});
