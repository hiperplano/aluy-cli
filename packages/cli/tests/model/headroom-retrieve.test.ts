// EST-1015 (POC headroom) — testa o tool `headroom_retrieve` com `fetch` INJETADO
// (sem proxy real). Cobre: sucesso, query BM25 no body, 404-expirado, HTTP-erro,
// hash faltante (sem rede), throw de rede. NÃO há fail-open aqui (≠ compress): erro
// vira observação `ok:false` clara, nunca lança o turno.

import { describe, expect, it, vi } from 'vitest';
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from '@hiperplano/aluy-cli-core';
import { makeHeadroomRetrieveTool } from '../../src/model/headroom-retrieve.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('headroom_retrieve tool', () => {
  it('declara name/effect/parameters corretos (egress de rede)', () => {
    const tool = makeHeadroomRetrieveTool({ baseUrl: 'http://127.0.0.1:8787' });
    expect(tool.name).toBe('headroom_retrieve');
    expect(tool.effect).toBe('network');
    expect((tool.parameters as { required?: string[] }).required).toEqual(['hash']);
  });

  it('recupera o conteúdo original e o devolve como observação ok', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        original_content: 'linha 1\nlinha 2\nlinha 3',
        original_tokens: 42,
        tool_name: 'run_command',
      }),
    ) as unknown as typeof fetch;
    const tool = makeHeadroomRetrieveTool({ baseUrl: 'http://127.0.0.1:8787/', fetchFn });

    const res = await tool.run({ hash: 'abc123' }, {} as never);

    expect(res.ok).toBe(true);
    expect(res.observation).toContain('linha 2');
    expect(res.observation).toContain('hash=abc123');
    expect(res.observation).toContain('run_command');
    expect(res.observation).toContain('42 tokens');
    // HR-SEC-3 (paridade c/ compress/recall): o `content` vindo do PROXY (não-confiável)
    // é ENVELOPADO como DADO; o header (metadados do aluy) fica FORA do envelope.
    expect(res.observation).toContain(UNTRUSTED_OPEN);
    expect(res.observation).toContain(UNTRUSTED_CLOSE);
    const openIdx = res.observation!.indexOf(UNTRUSTED_OPEN);
    expect(res.observation!.indexOf('hash=abc123')).toBeLessThan(openIdx); // header antes do envelope
    expect(res.observation!.indexOf('linha 2')).toBeGreaterThan(openIdx); // conteúdo DENTRO
    // HR-SEC-4 / CLI-SEC-9 — a confirmação (display) mostra o DESTINO EXATO do egress.
    expect(res.display).toContain('http://127.0.0.1:8787/v1/retrieve');
    expect(res.display).toContain('hash=abc123');
    // POST no endpoint certo, body com o hash, SEM trailing slash duplicada.
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8787/v1/retrieve');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ hash: 'abc123' });
  });

  it('F85 — proxy PENDURADO ⇒ teto INTERNO aborta ⇒ ok:false com observação de timeout (nunca estala o loop)', async () => {
    // fetch que NUNCA responde sozinho — só rejeita quando o `signal` abortar (proxy pendurado).
    // Sem o teto F85, a tool-call estalaria o loop (não há timeout universal de tool).
    const fetchFn = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal;
          const fail = (): void => reject(new Error('aborted'));
          if (sig?.aborted) return fail();
          sig?.addEventListener('abort', fail, { once: true });
        }),
    ) as unknown as typeof fetch;
    const tool = makeHeadroomRetrieveTool({
      baseUrl: 'http://127.0.0.1:8787/', // IP loopback literal ⇒ classify passa sem resolver
      fetchFn,
      timeoutMs: 20, // teto curtíssimo p/ o teste não pendurar de verdade
    });

    const res = await tool.run({ hash: 'h1' }, {} as never);

    // Recuperável (≠ compress, que é fail-open silencioso): erro CLARO, nunca lança o turno.
    expect(res.ok).toBe(false);
    expect(res.observation).toContain('timeout');
    expect(res.observation).toContain('20ms');
    expect(fetchFn).toHaveBeenCalled(); // chegou ao fetch ⇒ foi o TETO que cortou (não o classify)
  });

  it('passa a query BM25 no body quando dada', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ original_content: 'trecho relevante' }),
    ) as unknown as typeof fetch;
    const tool = makeHeadroomRetrieveTool({ baseUrl: 'http://127.0.0.1:8787', fetchFn });

    const res = await tool.run({ hash: 'h1', query: 'erro de timeout' }, {} as never);

    expect(res.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ hash: 'h1', query: 'erro de timeout' });
  });

  it('404 ⇒ ok:false com instrução de RErodar (conteúdo expirou)', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    const tool = makeHeadroomRetrieveTool({ baseUrl: 'http://127.0.0.1:8787', fetchFn });

    const res = await tool.run({ hash: 'gone' }, {} as never);

    expect(res.ok).toBe(false);
    expect(res.observation).toContain('EXPIROU');
    expect(res.observation).toContain('RErode');
  });

  it('HTTP não-ok (≠404) ⇒ ok:false reportando o status', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const tool = makeHeadroomRetrieveTool({ baseUrl: 'http://127.0.0.1:8787', fetchFn });

    const res = await tool.run({ hash: 'x' }, {} as never);

    expect(res.ok).toBe(false);
    expect(res.observation).toContain('503');
  });

  it('hash faltante ⇒ ok:false SEM tocar a rede', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const tool = makeHeadroomRetrieveTool({ baseUrl: 'http://127.0.0.1:8787', fetchFn });

    const res = await tool.run({}, {} as never);

    expect(res.ok).toBe(false);
    expect(res.observation).toContain('obrigatório');
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('throw de rede ⇒ ok:false (NÃO lança o turno)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const tool = makeHeadroomRetrieveTool({ baseUrl: 'http://127.0.0.1:8787', fetchFn });

    const res = await tool.run({ hash: 'x' }, {} as never);

    expect(res.ok).toBe(false);
    expect(res.observation).toContain('ECONNREFUSED');
  });

  it('resposta sem original_content utilizável ⇒ ok:false', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ original_tokens: 1 }),
    ) as unknown as typeof fetch;
    const tool = makeHeadroomRetrieveTool({ baseUrl: 'http://127.0.0.1:8787', fetchFn });

    const res = await tool.run({ hash: 'x' }, {} as never);

    expect(res.ok).toBe(false);
    expect(res.observation).toContain('original_content');
  });
});
