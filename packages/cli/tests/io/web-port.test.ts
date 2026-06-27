// EST-0971 · CLI-SEC-13 — WebPort concreta: PIN real (conecta ao IP dado, sem
// re-resolver), no-follow-redirect, tetos, resolver e guarda de egress.
//
// Usa um servidor HTTP de loopback REAL: passamos `pinnedIp:127.0.0.1` e provamos
// que o socket alcança ESSE servidor (o pin funciona). E que um redirect 302 NÃO é
// seguido pela porta — ela devolve status+location p/ o core revalidar.

import { describe, expect, it, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  NodePinnedFetcher,
  NodeHostResolver,
  EgressAllowlistGuard,
  createWebPort,
} from '../../src/io/web-port.js';
import { EgressAllowlist } from '../../src/io/egress.js';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

function listen(
  handler: (url: string, res: import('node:http').ServerResponse) => void,
): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => handler(req.url ?? '/', res));
    server.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as AddressInfo).port);
    });
  });
}

/** Como `listen`, mas entrega o `req` completo (p/ inspecionar método/headers/corpo). */
function listen2(
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as AddressInfo).port);
    });
  });
}

describe('NodePinnedFetcher — PIN real ao IP dado', () => {
  it('conecta ao pinnedIp (127.0.0.1) e devolve o corpo', async () => {
    const port = await listen((url, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`hello from ${url}`);
    });
    const fetcher = new NodePinnedFetcher();
    const r = await fetcher.fetchPinned({
      url: `http://anything.example:${port}/path?q=1`,
      host: 'anything.example',
      pinnedIp: '127.0.0.1', // o pin: conecta AQUI, ignora o DNS de "anything.example"
      maxBytes: 1_000_000,
      timeoutMs: 5000,
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('hello from /path?q=1');
  });

  it('EST-0971 fix — POST envia o corpo form-encoded ao servidor (web_search)', async () => {
    let receivedMethod = '';
    let receivedBody = '';
    let receivedCT = '';
    const port = await listen2((req, res) => {
      receivedMethod = req.method ?? '';
      receivedCT = String(req.headers['content-type'] ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<a class="result__a" href="x">ok</a>');
      });
    });
    const fetcher = new NodePinnedFetcher();
    const r = await fetcher.fetchPinned({
      url: `http://ddg.example:${port}/html/`,
      host: 'ddg.example',
      pinnedIp: '127.0.0.1',
      maxBytes: 1_000_000,
      timeoutMs: 5000,
      method: 'POST',
      body: 'q=rust&b=',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(r.status).toBe(200);
    expect(receivedMethod).toBe('POST');
    expect(receivedBody).toBe('q=rust&b=');
    expect(receivedCT).toMatch(/x-www-form-urlencoded/);
  });

  it('NÃO segue redirect — devolve status 302 + location p/ o core revalidar', async () => {
    const port = await listen((_url, res) => {
      res.writeHead(302, { location: 'http://internal.evil/secret' });
      res.end();
    });
    const fetcher = new NodePinnedFetcher();
    const r = await fetcher.fetchPinned({
      url: `http://pub.example:${port}/`,
      host: 'pub.example',
      pinnedIp: '127.0.0.1',
      maxBytes: 1_000_000,
      timeoutMs: 5000,
    });
    expect(r.status).toBe(302);
    expect(r.location).toBe('http://internal.evil/secret');
    expect(r.body).toBe(''); // não leu corpo do redirect
  });

  it('TETO de tamanho: trunca o corpo ao maxBytes', async () => {
    const port = await listen((_url, res) => {
      res.writeHead(200);
      res.end('x'.repeat(10_000));
    });
    const fetcher = new NodePinnedFetcher();
    const r = await fetcher.fetchPinned({
      url: `http://pub.example:${port}/`,
      host: 'pub.example',
      pinnedIp: '127.0.0.1',
      maxBytes: 500,
      timeoutMs: 5000,
    });
    expect(r.body.length).toBeLessThan(1000);
    expect(r.body).toMatch(/truncado/);
  });

  // ── EST-0970 (fix OOM) — o teto de bytes é DE VERDADE: para de ler e não
  // materializa N MB na memória ────────────────────────────────────────────────
  it('EST-0970 — corpo GIGANTE: PARA de ler ao bater o teto (não carrega N MB) e trunca', async () => {
    // O servidor TENTA enviar muito mais que o teto, em VÁRIOS chunks. A porta deve
    // parar de ler (res.destroy) ao bater maxBytes — o corpo recebido fica LIMITADO,
    // e o servidor PERCEBE o socket cair antes de mandar tudo (prova de que paramos).
    const CHUNK = 'y'.repeat(64 * 1024); // 64 KiB por chunk
    const TOTAL_CHUNKS = 200; // tentaria ~12.8 MB se lêssemos tudo
    let chunksSent = 0;
    let allSent = false;
    let serverStopped = false;
    const port = await listen2((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.on('error', () => {
        /* socket cortado pelo cliente — esperado; não derruba o teste */
      });
      // O cliente destrói o socket ao bater o teto ⇒ a resposta do servidor emite
      // 'close' ANTES de termos mandado tudo. Essa é a prova de que paramos de ler.
      res.on('close', () => {
        if (!allSent) serverStopped = true;
      });
      const pump = (): void => {
        if (res.destroyed || res.writableEnded) return; // cliente foi embora
        if (chunksSent >= TOTAL_CHUNKS) {
          allSent = true;
          res.end();
          return;
        }
        chunksSent++;
        const more = res.write(CHUNK);
        if (more) setImmediate(pump);
        else res.once('drain', pump);
      };
      pump();
    });

    const fetcher = new NodePinnedFetcher();
    const maxBytes = 256 * 1024; // 256 KiB
    const r = await fetcher.fetchPinned({
      url: `http://big.example:${port}/`,
      host: 'big.example',
      pinnedIp: '127.0.0.1',
      maxBytes,
      timeoutMs: 8000,
    });

    // O corpo recebido NÃO passa do teto (+ marcador curto). NÃO há 12.8 MB no heap.
    const marker = '\n…[truncado: corpo maior que';
    const payload = r.body.slice(0, r.body.indexOf(marker));
    expect(payload.length).toBeLessThanOrEqual(maxBytes);
    expect(r.body).toMatch(/truncado: corpo maior que 262144 bytes/);

    // PROVA DE QUE PAROU DE LER (= não materializou N MB): o servidor não enviou todos
    // os 200 chunks — o cliente destruiu o socket ao bater o teto. Se lêssemos tudo,
    // teria bombeado os 12.8 MB. Aqui parou logo após encher os 256 KiB do teto.
    // (Limite GENEROSO: bem abaixo da metade dos chunks — não materializou nem perto
    // dos 12.8 MB. O número exato varia com o highWaterMark/coalescência do socket.)
    expect(chunksSent).toBeLessThan(TOTAL_CHUNKS / 2);
    // O `pump` do servidor para ao perceber o socket destruído (poll curto p/ deixar
    // a callback agendada rodar — sem flake de ordenação).
    await vi.waitFor(() => expect(serverStopped).toBe(true), { timeout: 2000 });
  });

  it('EST-0970 — corpo EXATAMENTE no teto não marca truncado; abaixo passa inteiro', async () => {
    const exact = 'z'.repeat(500);
    const port = await listen((_url, res) => {
      res.writeHead(200);
      res.end(exact);
    });
    const fetcher = new NodePinnedFetcher();
    const r = await fetcher.fetchPinned({
      url: `http://pub.example:${port}/`,
      host: 'pub.example',
      pinnedIp: '127.0.0.1',
      maxBytes: 500,
      timeoutMs: 5000,
    });
    expect(r.body).toBe(exact); // sem marcador — coube no teto
    expect(r.body).not.toMatch(/truncado/);
  });

  it('TIMEOUT: servidor que pendura ⇒ rejeita sem travar', async () => {
    const port = await listen(() => {
      /* nunca responde */
    });
    const fetcher = new NodePinnedFetcher();
    await expect(
      fetcher.fetchPinned({
        url: `http://pub.example:${port}/`,
        host: 'pub.example',
        pinnedIp: '127.0.0.1',
        maxBytes: 1000,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timeout/i);
  });
});

describe('NodeHostResolver — resolve real (todos os IPs)', () => {
  it('localhost resolve p/ IP(s) de loopback', async () => {
    const ips = await new NodeHostResolver().resolve('localhost');
    expect(ips.length).toBeGreaterThan(0);
    expect(ips.some((ip) => ip === '127.0.0.1' || ip === '::1')).toBe(true);
  });
});

describe('EgressAllowlistGuard — adapta a allowlist concreta (default-deny)', () => {
  it('host na allowlist ⇒ allowed; fora ⇒ deny', () => {
    const guard = new EgressAllowlistGuard(new EgressAllowlist({ allow: ['example.com'] }));
    expect(guard.checkHost('example.com').allowed).toBe(true);
    expect(guard.checkHost('sub.example.com').allowed).toBe(true);
    expect(guard.checkHost('evil.test').allowed).toBe(false);
  });
});

describe('createWebPort — fia resolver+fetcher+egress', () => {
  it('monta uma WebPort utilizável', () => {
    const web = createWebPort({ egress: new EgressAllowlist({ allow: ['x.com'] }) });
    expect(web.safe.resolver).toBeInstanceOf(NodeHostResolver);
    expect(web.egress.checkHost('x.com').allowed).toBe(true);
  });
});
