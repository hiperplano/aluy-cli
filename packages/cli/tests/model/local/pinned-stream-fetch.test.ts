// EST-1115 · PROV-SEC-1 — IP-PIN + redirect-revalidation no egress BYO (STREAMING).
//
// Prova com servidor HTTP loopback REAL + um `request` mockado que captura a opção
// `lookup` (o PIN):
//  (a) REBINDING/TOCTOU: o resolver devolve um IP PÚBLICO (validação passa); a
//      conexão é PINADA a ESSE IP via a opção `lookup` — não há 2ª resolução. E se o
//      resolver devolvesse um IP interno, o egress é RECUSADO (nem conecta).
//  (b) REDIRECT → 169.254.169.254 BLOQUEADO (redirect:'error' fail-closed).
//  (c) STREAMING SSE normal CONTINUA: o corpo (IncomingMessage) é consumido como
//      stream pelo `parseSse`, evento-a-evento.

import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { request as realHttpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  createPinnedStreamFetch,
  connectPinned,
} from '../../../src/model/local/pinned-stream-fetch.js';
import { parseSse } from '@aluy/cli-core';
import type { HostResolver } from '@aluy/cli-core';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

function listen(
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port));
  });
}

function fakeResolver(map: Record<string, string[]>): HostResolver {
  return {
    resolve: async (host) => {
      const ips = map[host];
      if (ips === undefined) throw new Error(`no DNS for ${host}`);
      return ips;
    },
  };
}

describe('(c) STREAMING SSE — connectPinned entrega o corpo como stream', () => {
  it('o corpo (IncomingMessage) é iterado evento-a-evento pelo parseSse', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: delta\ndata: {"text":"oi"}\n\n');
      res.write('event: delta\ndata: {"text":" mundo"}\n\n');
      res.end('event: done\ndata: {}\n\n');
    });
    // O pin: pinnedIp=127.0.0.1 (o servidor de teste). connectPinned NÃO classifica
    // (a classificação é o orquestrador); aqui provamos o STREAMING real.
    const res = await connectPinned({
      url: `http://provider.test:${port}/v1/messages`,
      host: 'provider.test',
      pinnedIp: '127.0.0.1',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"hi":1}',
      httpsRequestFn: realHttpRequest as never,
      httpRequestFn: realHttpRequest,
    });
    expect(res.statusCode).toBe(200);

    const events: Array<{ event: string; data: string }> = [];
    // `res` é AsyncIterable<Buffer> ⇒ parseSse o consome em STREAMING.
    for await (const ev of parseSse(res)) events.push({ event: ev.event, data: ev.data });

    expect(events.map((e) => e.event)).toEqual(['delta', 'delta', 'done']);
    expect(events[0]!.data).toContain('oi');
    expect(events[1]!.data).toContain('mundo');
  });
});

describe('(a) REBINDING/TOCTOU — pina o IP validado, sem re-resolver (EST-1115)', () => {
  it('socket conecta ao pinnedIp via a opção lookup (resolver→IP público)', async () => {
    let capturedLookup: unknown;
    let capturedHost: string | undefined;
    let capturedServername: unknown;
    // request mock: captura a opção `lookup` e responde 200 vazio (não toca a rede).
    const mockRequest = ((options: Record<string, unknown>, cb: (res: unknown) => void) => {
      capturedLookup = options.lookup;
      capturedHost = options.host as string;
      capturedServername = options.servername;
      const res = makeFakeRes(200, '');
      queueMicrotask(() => cb(res));
      return makeFakeReq();
    }) as never;

    const fetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'gateway.test': ['8.8.8.8'] }),
      httpsRequestFn: mockRequest,
      httpRequestFn: mockRequest,
    });
    const r = await fetch('https://gateway.test/v1/messages', {
      method: 'POST',
      headers: {},
      body: '{}',
      redirect: 'error',
    });
    expect(r.status).toBe(200);
    // O host original é preservado p/ Host-header/SNI…
    expect(capturedHost).toBe('gateway.test');
    expect(capturedServername).toBe('gateway.test');
    // …mas o `lookup` PINA o IP validado (8.8.8.8) — sem 2ª resolução.
    const lookup = capturedLookup as (
      h: string,
      o: unknown,
      cb: (e: unknown, addr: unknown, fam?: number) => void,
    ) => void;
    let pinned: unknown;
    lookup('gateway.test', { all: false }, (_e, addr) => {
      pinned = addr;
    });
    expect(pinned).toBe('8.8.8.8'); // o socket vai AO IP validado, não re-resolve
  });

  it('se o host (re)resolve p/ IP INTERNO, o egress é RECUSADO (não conecta)', async () => {
    const neverConnect = (() => {
      throw new Error('NÃO deveria conectar a um alvo interno');
    }) as never;
    const fetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'rebind.test': ['169.254.169.254'] }),
      httpsRequestFn: neverConnect,
      httpRequestFn: neverConnect,
    });
    await expect(
      fetch('https://rebind.test/v1', { method: 'POST', headers: {}, redirect: 'error' }),
    ).rejects.toThrow(/anti-SSRF|interno|metadata|PROV-SEC-1/i);
  });
});

describe('(b) REDIRECT → metadata da cloud BLOQUEADO (EST-1115)', () => {
  it('302 → http://169.254.169.254/ é recusado (redirect:error fail-closed)', async () => {
    const mockRequest = ((_options: Record<string, unknown>, cb: (res: unknown) => void) => {
      const res = makeFakeRes(302, '', { location: 'http://169.254.169.254/latest/meta-data' });
      queueMicrotask(() => cb(res));
      return makeFakeReq();
    }) as never;
    const fetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'gateway.test': ['8.8.8.8'] }),
      httpsRequestFn: mockRequest,
      httpRequestFn: mockRequest,
    });
    await expect(
      fetch('https://gateway.test/v1', { method: 'POST', headers: {}, redirect: 'error' }),
    ).rejects.toThrow(/redirect.*BLOQUEADO|anti-SSRF|PROV-SEC-1/i);
  });

  it('com redirect:follow, o novo host é RE-VALIDADO (metadata ⇒ recusa no hop)', async () => {
    const mockRequest = ((_options: Record<string, unknown>, cb: (res: unknown) => void) => {
      const res = makeFakeRes(302, '', { location: 'http://169.254.169.254/' });
      queueMicrotask(() => cb(res));
      return makeFakeReq();
    }) as never;
    const fetch = createPinnedStreamFetch({
      resolver: fakeResolver({
        'gateway.test': ['8.8.8.8'],
        '169.254.169.254': ['169.254.169.254'],
      }),
      httpsRequestFn: mockRequest,
      httpRequestFn: mockRequest,
      maxRedirects: 3,
    });
    await expect(
      fetch('https://gateway.test/v1', { method: 'POST', headers: {}, redirect: 'follow' }),
    ).rejects.toThrow(/anti-SSRF|interno|metadata|PROV-SEC-1/i);
  });
});

describe('createPinnedStreamFetch — StreamResponse (corpo/erro/redirect manual)', () => {
  it('2xx: StreamResponse.body é o stream e parseSse o consome (end-to-end)', async () => {
    const sse =
      'event: delta\ndata: {"t":"a"}\n\n' +
      'event: delta\ndata: {"t":"b"}\n\n' +
      'event: done\ndata: {}\n\n';
    const mockRequest = ((_o: Record<string, unknown>, cb: (r: unknown) => void) => {
      queueMicrotask(() => cb(makeFakeRes(200, sse, { 'content-type': 'text/event-stream' })));
      return makeFakeReq();
    }) as never;
    const fetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'gateway.test': ['8.8.8.8'] }),
      httpsRequestFn: mockRequest,
      httpRequestFn: mockRequest,
    });
    const r = await fetch('https://gateway.test/v1', {
      method: 'POST',
      headers: {},
      body: '{}',
      redirect: 'error',
    });
    expect(r.ok).toBe(true);
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    expect(r.body).not.toBeNull();
    const events: string[] = [];
    for await (const ev of parseSse(r.body!)) events.push(ev.event);
    expect(events).toEqual(['delta', 'delta', 'done']);
  });

  it('resposta de erro: ok=false e json() bufferiza o corpo de erro', async () => {
    const mockRequest = ((_o: Record<string, unknown>, cb: (r: unknown) => void) => {
      queueMicrotask(() =>
        cb(
          makeFakeRes(401, '{"error":{"message":"bad key"}}', {
            'content-type': 'application/json',
          }),
        ),
      );
      return makeFakeReq();
    }) as never;
    const fetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'gateway.test': ['8.8.8.8'] }),
      httpsRequestFn: mockRequest,
      httpRequestFn: mockRequest,
    });
    const r = await fetch('https://gateway.test/v1', {
      method: 'POST',
      headers: {},
      redirect: 'error',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: { message: 'bad key' } });
  });

  it('redirect:manual devolve a resposta de redirect crua (status+location)', async () => {
    const mockRequest = ((_o: Record<string, unknown>, cb: (r: unknown) => void) => {
      queueMicrotask(() => cb(makeFakeRes(302, '', { location: 'https://elsewhere.test/v2' })));
      return makeFakeReq();
    }) as never;
    const fetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'gateway.test': ['8.8.8.8'] }),
      httpsRequestFn: mockRequest,
      httpRequestFn: mockRequest,
    });
    const r = await fetch('https://gateway.test/v1', {
      method: 'POST',
      headers: {},
      redirect: 'manual',
    });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://elsewhere.test/v2');
  });

  it('redirect:follow segue p/ host PÚBLICO re-validado (hop ok)', async () => {
    let call = 0;
    const mockRequest = ((_o: Record<string, unknown>, cb: (r: unknown) => void) => {
      call += 1;
      if (call === 1) {
        queueMicrotask(() => cb(makeFakeRes(302, '', { location: 'https://hop2.test/final' })));
      } else {
        queueMicrotask(() => cb(makeFakeRes(200, 'ok', { 'content-type': 'text/plain' })));
      }
      return makeFakeReq();
    }) as never;
    const fetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'gateway.test': ['8.8.8.8'], 'hop2.test': ['1.1.1.1'] }),
      httpsRequestFn: mockRequest,
      httpRequestFn: mockRequest,
      maxRedirects: 3,
    });
    const r = await fetch('https://gateway.test/v1', {
      method: 'POST',
      headers: {},
      redirect: 'follow',
    });
    expect(r.status).toBe(200);
    expect(call).toBe(2);
  });

  it('F101 — redirect:follow CROSS-ORIGIN STRIPPA a credencial BYO (Authorization) no hop', async () => {
    const seen: Array<Record<string, string>> = [];
    let call = 0;
    const mockRequest = ((o: Record<string, unknown>, cb: (r: unknown) => void) => {
      seen.push({ ...((o.headers as Record<string, string>) ?? {}) });
      call += 1;
      if (call === 1) {
        // provider legítimo → host PÚBLICO de OUTRA origem (302).
        queueMicrotask(() => cb(makeFakeRes(302, '', { location: 'https://evil-public.test/x' })));
      } else {
        queueMicrotask(() => cb(makeFakeRes(200, 'ok', {})));
      }
      return makeFakeReq();
    }) as never;
    const fetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'api.provider.test': ['8.8.8.8'], 'evil-public.test': ['9.9.9.9'] }),
      httpsRequestFn: mockRequest,
      httpRequestFn: mockRequest,
      maxRedirects: 3,
    });
    await fetch('https://api.provider.test/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-USER-SECRET', 'content-type': 'application/json' },
      redirect: 'follow',
    });
    // hop 1 (origem autenticada): leva a credencial.
    expect(seen[0]!.Authorization).toBe('Bearer sk-USER-SECRET');
    // hop 2 (CROSS-ORIGIN): credencial STRIPADA — nunca chega ao host do redirect.
    expect(seen[1]!.Authorization).toBeUndefined();
    // headers não-sensíveis seguem.
    expect(seen[1]!['content-type']).toBe('application/json');
  });

  it('F101 — redirect:follow SAME-ORIGIN MANTÉM a credencial (só muda o path)', async () => {
    const seen: Array<Record<string, string>> = [];
    let call = 0;
    const mockRequest = ((o: Record<string, unknown>, cb: (r: unknown) => void) => {
      seen.push({ ...((o.headers as Record<string, string>) ?? {}) });
      call += 1;
      if (call === 1) {
        // mesma origem (mesmo scheme+host+port), só outro path.
        queueMicrotask(() =>
          cb(makeFakeRes(307, '', { location: 'https://api.provider.test/v2' })),
        );
      } else {
        queueMicrotask(() => cb(makeFakeRes(200, 'ok', {})));
      }
      return makeFakeReq();
    }) as never;
    const fetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'api.provider.test': ['8.8.8.8'] }),
      httpsRequestFn: mockRequest,
      httpRequestFn: mockRequest,
      maxRedirects: 3,
    });
    await fetch('https://api.provider.test/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-USER-SECRET' },
      redirect: 'follow',
    });
    // same-origin ⇒ a credencial PERSISTE no hop (não estraga o caso legítimo).
    expect(seen[1]!.Authorization).toBe('Bearer sk-USER-SECRET');
  });

  it('redirect:follow estoura o teto de hops ⇒ aborta', async () => {
    const mockRequest = ((_o: Record<string, unknown>, cb: (r: unknown) => void) => {
      queueMicrotask(() => cb(makeFakeRes(302, '', { location: 'https://loop.test/again' })));
      return makeFakeReq();
    }) as never;
    const fetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'gateway.test': ['8.8.8.8'], 'loop.test': ['1.1.1.1'] }),
      httpsRequestFn: mockRequest,
      httpRequestFn: mockRequest,
      maxRedirects: 1,
    });
    await expect(
      fetch('https://gateway.test/v1', { method: 'POST', headers: {}, redirect: 'follow' }),
    ).rejects.toThrow(/excesso de redirects|anti-SSRF/i);
  });

  it('default (sem redirect no init) é fail-closed: 3xx ⇒ BLOQUEADO', async () => {
    const mockRequest = ((_o: Record<string, unknown>, cb: (r: unknown) => void) => {
      queueMicrotask(() => cb(makeFakeRes(301, '', { location: 'http://169.254.169.254/' })));
      return makeFakeReq();
    }) as never;
    const fetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'gateway.test': ['8.8.8.8'] }),
      httpsRequestFn: mockRequest,
      httpRequestFn: mockRequest,
    });
    await expect(fetch('https://gateway.test/v1', { method: 'POST', headers: {} })).rejects.toThrow(
      /BLOQUEADO|anti-SSRF/i,
    );
  });
});

describe('connectPinned — abort e erro de transporte', () => {
  it('signal já abortado ⇒ rejeita com AbortError sem conectar', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      connectPinned({
        url: 'https://x.test/p',
        host: 'x.test',
        pinnedIp: '8.8.8.8',
        method: 'GET',
        headers: {},
        signal: ctrl.signal,
        httpsRequestFn: (() => makeFakeReq()) as never,
        httpRequestFn: (() => makeFakeReq()) as never,
      }),
    ).rejects.toThrow(/cancelado/i);
  });
});

// --- fakes mínimos de http.IncomingMessage / ClientRequest ---

function makeFakeRes(
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): import('node:http').IncomingMessage {
  // AsyncIterable que emite o corpo uma vez (p/ json()/text()/stream).
  const chunks = body === '' ? [] : [Buffer.from(body)];
  const res = {
    statusCode,
    headers,
    resume() {
      /* drena (no-op no fake) */
    },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
  return res as unknown as import('node:http').IncomingMessage;
}

function makeFakeReq(): import('node:http').ClientRequest {
  return {
    on() {
      return this;
    },
    write() {
      return true;
    },
    end() {
      /* no-op */
    },
    destroy() {
      /* no-op */
    },
  } as unknown as import('node:http').ClientRequest;
}
