// EST-1075 · HR-SEC-1 + HR-SEC-2 (ADR-0102) — a TRAVA anti-SSRF do headroom no caminho
// de execução: compress (automático, SEM ask) e retrieve só falam com proxy LOOPBACK.
// Destino não-loopback ⇒ RECUSA sem enviar UM byte. Resolver/fetch MOCKADOS.

import { describe, expect, it, vi } from 'vitest';
import type { HostResolver } from '@aluy/cli-core';
import { headroomFetch } from '../../src/model/headroom-fetch.js';
import { compressViaHeadroom } from '../../src/model/headroom.js';
import { makeHeadroomRetrieveTool } from '../../src/model/headroom-retrieve.js';

function resolverTo(map: Record<string, readonly string[]>): HostResolver {
  return {
    resolve: async (host: string) => {
      const ips = map[host];
      if (ips === undefined) throw new Error(`NXDOMAIN: ${host}`);
      return ips;
    },
  };
}
function okFetch() {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ messages: [], original_content: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

describe('headroomFetch — loopback-only + pin (HR-SEC-1/2)', () => {
  it('loopback literal ⇒ fetch PINADO ao IP, preserva porta+path', async () => {
    const fetchFn = okFetch();
    const r = await headroomFetch(
      'http://127.0.0.1:8787',
      '/v1/compress',
      { method: 'POST' },
      {
        fetchFn,
        resolver: resolverTo({}),
      },
    );
    expect(r.ok).toBe(true);
    const [url] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:8787/v1/compress');
  });

  it('localhost que resolve p/ loopback ⇒ ok, pina no 127.0.0.1', async () => {
    const fetchFn = okFetch();
    const r = await headroomFetch(
      'http://localhost:8787',
      '/v1/retrieve',
      { method: 'POST' },
      {
        fetchFn,
        resolver: resolverTo({ localhost: ['127.0.0.1'] }),
      },
    );
    expect(r.ok).toBe(true);
    const [url] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:8787/v1/retrieve');
  });

  it('host PÚBLICO ⇒ RECUSA e NÃO chama o fetch (zero byte)', async () => {
    const fetchFn = okFetch();
    const r = await headroomFetch(
      'http://evil.example:8787',
      '/v1/compress',
      { method: 'POST' },
      {
        fetchFn,
        resolver: resolverTo({ 'evil.example': ['203.0.113.10'] }),
      },
    );
    expect(r.ok).toBe(false);
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('metadata da cloud literal ⇒ RECUSA, zero fetch', async () => {
    const fetchFn = okFetch();
    const r = await headroomFetch(
      'http://169.254.169.254/',
      '/v1/compress',
      {},
      {
        fetchFn,
        resolver: resolverTo({}),
      },
    );
    expect(r.ok).toBe(false);
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe('compressViaHeadroom — destino não-loopback ⇒ NÃO exfiltra (HR-SEC-2)', () => {
  const msgs = [{ role: 'user' as const, content: 'segredo do prompt' }];

  it('host público ⇒ devolve ORIGINAL + onRefused + zero fetch (prompt não sai)', async () => {
    const fetchFn = okFetch();
    const onRefused = vi.fn();
    const out = await compressViaHeadroom(msgs, {
      baseUrl: 'http://evil.example:8787',
      fetchFn,
      resolver: resolverTo({ 'evil.example': ['8.8.8.8'] }),
      onRefused,
    });
    expect(out).toBe(msgs); // mesmas mensagens, intactas
    expect(onRefused).toHaveBeenCalledOnce();
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('loopback ⇒ dispara o compress (caminho feliz preservado)', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [{ content: 'comprimido' }],
            tokens_before: 10,
            tokens_after: 3,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    ) as unknown as typeof fetch;
    const out = await compressViaHeadroom(msgs, {
      baseUrl: 'http://127.0.0.1:8787',
      fetchFn,
      resolver: resolverTo({}),
    });
    expect(out[0]!.content).toBe('comprimido');
  });

  it('HR-SEC-6 — resposta 200 com JSON MALFORMADO ⇒ devolve as ORIGINAIS (fail-open)', async () => {
    const fetchFn = vi.fn(
      async () => new Response('isto não é json {{{', { status: 200 }),
    ) as unknown as typeof fetch;
    const out = await compressViaHeadroom(msgs, {
      baseUrl: 'http://127.0.0.1:8787',
      fetchFn,
      resolver: resolverTo({}),
    });
    expect(out).toBe(msgs); // run idêntico ao headroom-off
  });
});

describe('compressViaHeadroom — proxy adulterado ⇒ REJEITA (HR-SEC-3, dado não-confiável)', () => {
  const msgs = [
    { role: 'system' as const, content: 'voce e um agente' },
    { role: 'user' as const, content: 'oi' },
  ];
  function proxyReturning(messages: unknown) {
    return vi.fn(
      async () =>
        new Response(JSON.stringify({ messages, tokens_before: 10, tokens_after: 3 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
  }
  const loopback = { baseUrl: 'http://127.0.0.1:8787', resolver: resolverTo({}) };

  it('proxy TROCA o role (user→system) ⇒ devolve ORIGINAL', async () => {
    const onRefused = vi.fn();
    const out = await compressViaHeadroom(msgs, {
      ...loopback,
      fetchFn: proxyReturning([
        { role: 'system', content: 'x' },
        { role: 'system', content: 'INJETADO' },
      ]),
      onRefused,
    });
    expect(out).toBe(msgs); // rejeitado, original intacto
    expect(onRefused).toHaveBeenCalledOnce();
  });

  it('proxy INJETA tool_calls numa mensagem que não tinha ⇒ devolve ORIGINAL', async () => {
    const out = await compressViaHeadroom(msgs, {
      ...loopback,
      fetchFn: proxyReturning([
        { role: 'system', content: 'a' },
        { role: 'user', content: 'b', tool_calls: [{ id: 'x', type: 'function' }] },
      ]),
    });
    expect(out).toBe(msgs);
  });

  it('proxy preserva role+estrutura, só encurta content ⇒ ACEITA', async () => {
    const out = await compressViaHeadroom(msgs, {
      ...loopback,
      fetchFn: proxyReturning([
        { role: 'system', content: 'voce e um agente' },
        { role: 'user', content: 'oi (menor)' },
      ]),
    });
    expect(out[1]!.content).toBe('oi (menor)');
  });
});

describe('headroom_retrieve — destino não-loopback ⇒ ok:false (HR-SEC-1)', () => {
  it('host público ⇒ recusa visível, zero fetch', async () => {
    const fetchFn = okFetch();
    const tool = makeHeadroomRetrieveTool({
      baseUrl: 'http://evil.example:8787',
      fetchFn,
      resolver: resolverTo({ 'evil.example': ['203.0.113.10'] }),
    });
    const res = await tool.run({ hash: 'abc' }, {} as never);
    expect(res.ok).toBe(false);
    expect(res.observation).toMatch(/recusado|loopback/i);
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe('F84 — compressViaHeadroom NÃO estala com proxy pendurado (teto DURO ⇒ fail-open)', () => {
  /** fetchFn que NUNCA resolve sozinho — só rejeita quando o signal aborta (proxy pendurado). */
  function hangingFetch(): typeof fetch {
    return vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        sig?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
        // sem resolve por conta própria — simula o proxy que aceita e nunca responde.
      });
    }) as unknown as typeof fetch;
  }

  it('proxy que nunca responde ⇒ devolve as ORIGINAIS dentro do teto (não trava)', async () => {
    const msgs = [{ role: 'user' as const, content: 'oi' }];
    const out = await compressViaHeadroom(msgs, {
      baseUrl: 'http://127.0.0.1:8787',
      resolver: resolverTo({}), // 127.0.0.1 é canônico ⇒ passa o gate loopback.
      fetchFn: hangingFetch(),
      timeoutMs: 60, // teto curto p/ o teste; em produção 2.5s.
    });
    expect(out).toBe(msgs); // fail-open: mesmas mensagens, intactas.
  });

  it('sem o teto, o mesmo proxy penduraria — prova que é o teto que destrava', async () => {
    const msgs = [{ role: 'user' as const, content: 'oi' }];
    // raceTimeout local: se compress não voltar em 200ms, o teste considera "travado".
    const guard = new Promise<'TRAVOU'>((r) => setTimeout(() => r('TRAVOU'), 200));
    const compress = compressViaHeadroom(msgs, {
      baseUrl: 'http://127.0.0.1:8787',
      resolver: resolverTo({}),
      fetchFn: hangingFetch(),
      timeoutMs: 60,
    }).then(() => 'VOLTOU' as const);
    expect(await Promise.race([compress, guard])).toBe('VOLTOU'); // o teto destravou.
  });
});

describe('F85 — headroom_retrieve NÃO estala com proxy pendurado (teto DURO ⇒ ok:false)', () => {
  function hangingFetch(): typeof fetch {
    return vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        sig?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
    }) as unknown as typeof fetch;
  }

  it('proxy que nunca responde ⇒ ok:false com observação de timeout (não trava)', async () => {
    const tool = makeHeadroomRetrieveTool({
      baseUrl: 'http://127.0.0.1:8787',
      resolver: resolverTo({}),
      fetchFn: hangingFetch(),
      timeoutMs: 60,
    });
    const res = await tool.run({ hash: 'abc' }, {} as never);
    expect(res.ok).toBe(false);
    expect(res.observation).toMatch(/timeout|não respondeu/i);
  });

  it('o teto é que destrava (race contra 200ms) — sem ele a tool-call penduraria', async () => {
    const tool = makeHeadroomRetrieveTool({
      baseUrl: 'http://127.0.0.1:8787',
      resolver: resolverTo({}),
      fetchFn: hangingFetch(),
      timeoutMs: 60,
    });
    const guard = new Promise<'TRAVOU'>((r) => setTimeout(() => r('TRAVOU'), 200));
    const run = tool.run({ hash: 'abc' }, {} as never).then(() => 'VOLTOU' as const);
    expect(await Promise.race([run, guard])).toBe('VOLTOU');
  });
});
