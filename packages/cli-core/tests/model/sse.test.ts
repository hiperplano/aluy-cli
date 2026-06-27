import { describe, expect, it } from 'vitest';
import { parseSse, type ByteSource } from '../../src/model/sse.js';

/** Adapta um array de strings/bytes num async-iterable (stream fake). */
async function* feed(chunks: readonly (string | Uint8Array)[]): ByteSource {
  for (const c of chunks) yield c;
}

async function collect(source: ByteSource): Promise<{ event: string; data: string }[]> {
  const out: { event: string; data: string }[] = [];
  for await (const ev of parseSse(source)) out.push({ event: ev.event, data: ev.data });
  return out;
}

describe('parseSse', () => {
  it('parseia eventos nomeados na ordem (start/delta/usage/done)', async () => {
    const stream =
      'event: start\ndata: {"request_id":"r1","session_id":"s1"}\n\n' +
      'event: delta\ndata: {"content":"Olá"}\n\n' +
      'event: delta\ndata: {"content":" mundo"}\n\n' +
      'event: usage\ndata: {"tokens_in":10,"tokens_out":3}\n\n' +
      'event: done\ndata: {"finish_reason":"stop"}\n\n';
    const events = await collect(feed([stream]));
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'delta', 'usage', 'done']);
    expect(events[1]?.data).toBe('{"content":"Olá"}');
  });

  it('remonta um evento partido entre dois chunks TCP', async () => {
    const events = await collect(
      feed(['event: del', 'ta\ndata: {"con', 'tent":"x"}\n', '\nevent: done\ndata: {}\n\n']),
    );
    expect(events).toEqual([
      { event: 'delta', data: '{"content":"x"}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('aceita CRLF e ignora comentário/heartbeat (linha que começa com :)', async () => {
    const events = await collect(
      feed([': keep-alive\r\n\r\nevent: delta\r\ndata: {"content":"a"}\r\n\r\n']),
    );
    expect(events).toEqual([{ event: 'delta', data: '{"content":"a"}' }]);
  });

  it('concatena múltiplas linhas data: com \\n (spec SSE)', async () => {
    const events = await collect(feed(['data: linha1\ndata: linha2\n\n']));
    expect(events).toEqual([{ event: 'message', data: 'linha1\nlinha2' }]);
  });

  it('decodifica bytes UTF-8 multibyte partidos entre chunks', async () => {
    // "café" — o 'é' (0xC3 0xA9) é partido entre dois chunks de bytes.
    const enc = new TextEncoder();
    const full = enc.encode('event: delta\ndata: {"content":"café"}\n\n');
    const mid = 30; // corta no meio do 'é'
    const events = await collect(feed([full.slice(0, mid), full.slice(mid)]));
    expect(events[0]?.data).toBe('{"content":"café"}');
  });

  it('faz flush de um evento final sem a linha em branco terminadora (corte abrupto)', async () => {
    const events = await collect(feed(['event: delta\ndata: {"content":"fim"}']));
    expect(events).toEqual([{ event: 'delta', data: '{"content":"fim"}' }]);
  });
});
