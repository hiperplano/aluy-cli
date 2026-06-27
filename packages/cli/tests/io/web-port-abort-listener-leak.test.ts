// HUNT-IO-NET (vazamento de listener) — o `NodePinnedFetcher` recebe o `signal` do
// LOOP (longevo: vive o turno/sessão), e o `safeFetch` do core o REUSA a cada hop de
// redirect (até maxRedirects+1 `fetchPinned` por web_fetch). Cada `fetchPinned`
// registrava um listener 'abort' nesse signal e NUNCA o removia no settle ⇒ os
// listeners ACUMULAVAM (1 por hop, por web_fetch/web_search da sessão) ⇒
// MaxListenersExceededWarning + closures retidas (req/chunks). O fix remove o
// listener no `cleanup` (chamado por `done`/`fail`).
//
// PROVA: com UM mesmo `AbortSignal` longevo, N fetchPinned que assentam normalmente
// devem deixar a contagem de listeners 'abort' de VOLTA ao baseline (0). Sem o fix,
// a contagem cresce monotonicamente (== N). E provamos que o abort AINDA funciona
// (o listener dispara e mata o socket) — o fix não pode quebrar o cancelamento.

import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { getEventListeners } from 'node:events';
import { AddressInfo } from 'node:net';
import { NodePinnedFetcher } from '../../src/io/web-port.js';

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
    server.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as AddressInfo).port);
    });
  });
}

/** Conta os listeners de 'abort' registrados no signal (API de EventTarget do Node). */
function abortListenerCount(signal: AbortSignal): number {
  return getEventListeners(signal, 'abort').length;
}

describe('NodePinnedFetcher — não vaza listener de abort no signal longevo', () => {
  it('REMOVE o listener de abort após cada fetch que assenta (sucesso)', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const fetcher = new NodePinnedFetcher();

    // UM signal longevo, reusado por N fetches (espelha o `ctx.signal` do loop, reusado
    // a cada hop pelo safeFetch). Sem o fix, cada fetch deixa 1 listener pendurado aqui.
    const controller = new AbortController();
    expect(abortListenerCount(controller.signal)).toBe(0);

    const N = 12;
    for (let i = 0; i < N; i++) {
      const r = await fetcher.fetchPinned({
        url: `http://anything.example:${port}/p${i}`,
        host: 'anything.example',
        pinnedIp: '127.0.0.1',
        maxBytes: 64 * 1024,
        timeoutMs: 2000,
        signal: controller.signal,
      });
      expect(r.status).toBe(200);
    }

    // O coração do teste: a contagem volta ao BASELINE (0). Sem o fix, seria == N
    // (cada fetchPinned empilhava um listener nunca-removido no MESMO signal).
    expect(abortListenerCount(controller.signal)).toBe(0);
  });

  it('REMOVE o listener mesmo quando o fetch FALHA (timeout do hop)', async () => {
    // Servidor que ACEITA mas NUNCA responde ⇒ o timeout do hop dispara `fail`.
    const port = await listen(() => {
      /* pendura de propósito: sem res.end() */
    });
    const fetcher = new NodePinnedFetcher();
    const controller = new AbortController();

    await expect(
      fetcher.fetchPinned({
        url: `http://anything.example:${port}/slow`,
        host: 'anything.example',
        pinnedIp: '127.0.0.1',
        maxBytes: 64 * 1024,
        timeoutMs: 60, // estoura rápido — o caminho de `fail` precisa limpar o listener
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    expect(abortListenerCount(controller.signal)).toBe(0);
  });

  it('o abort AINDA funciona — o listener dispara e mata o socket pendente', async () => {
    const port = await listen(() => {
      /* nunca responde: só o abort encerra */
    });
    const fetcher = new NodePinnedFetcher();
    const controller = new AbortController();

    const p = fetcher.fetchPinned({
      url: `http://anything.example:${port}/hang`,
      host: 'anything.example',
      pinnedIp: '127.0.0.1',
      maxBytes: 64 * 1024,
      timeoutMs: 10_000, // longo: NÃO é o timeout que encerra, é o abort
      signal: controller.signal,
    });

    // O listener foi registrado (há um socket pendente a cancelar).
    expect(abortListenerCount(controller.signal)).toBe(1);

    controller.abort();
    await expect(p).rejects.toThrow(/cancelado/);

    // Após o settle por abort, o listener também é removido (cleanup).
    expect(abortListenerCount(controller.signal)).toBe(0);
  });
});
