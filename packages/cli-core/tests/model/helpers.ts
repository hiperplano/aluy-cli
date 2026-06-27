// Mock de broker para os testes do cliente de modelo (EST-0943) — SEM rede.
//
// Espelha o CONTRATO Q3 (`POST /v1/chat`, `broker.md` §1.2): SSE de
// start/delta/usage/done, erro problem+json, e o gate de auth (exige
// `Authorization: Bearer`). Streaming via async-iterable de bytes — o mesmo
// formato que `Response.body` expõe.

import type { StreamFetch, StreamResponse } from '../../src/model/broker-client.js';

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Monta um corpo SSE a partir de eventos {event,data} já serializados. */
export function sseBody(events: readonly { event: string; data: unknown }[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

/** Stream de bytes a partir de uma string, opcionalmente fatiado em N chunks. */
export async function* bytes(
  text: string,
  chunks = 1,
  onChunk?: (i: number) => void,
): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder().encode(text);
  const size = Math.ceil(enc.length / chunks);
  for (let i = 0; i < chunks; i++) {
    onChunk?.(i);
    yield enc.slice(i * size, (i + 1) * size);
  }
}

export interface MockHandler {
  readonly status: number;
  /** Corpo SSE (text/event-stream) — para 2xx streaming. */
  readonly sse?: string | AsyncIterable<Uint8Array | string>;
  /** Corpo JSON (para erro problem+json não-stream). */
  readonly json?: unknown;
  readonly headers?: Record<string, string>;
}

/**
 * `fetch` fake do broker. Devolve `{ fetch, calls }`. O handler decide o corpo:
 * `sse` ⇒ stream 2xx; `json` ⇒ corpo de erro. Sem `Authorization: Bearer` ⇒
 * 401 automático (espelha o gate de borda do broker).
 */
export function makeBrokerFetch(handler: MockHandler | ((call: RecordedCall) => MockHandler)): {
  fetch: StreamFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: StreamFetch = async (url, init) => {
    // EST-0962 — ESPELHA O NODE REAL: GET/HEAD com `body` definido (mesmo `''`)
    // LANÇA "Request with GET/HEAD method cannot have body." ANTES da rede. O fake
    // ANTIGO aceitava `body: ''` em GET e MASCARAVA o bug (mesma classe do #115:
    // mock != realidade). Agora um GET com body NÃO passa nem no teste.
    if (
      (init.method === 'GET' || init.method === 'HEAD') &&
      init.body !== undefined &&
      init.body !== null
    ) {
      throw new TypeError('Request with GET/HEAD method cannot have body.');
    }
    const headers = init.headers ?? {};
    const call: RecordedCall = {
      url,
      method: init.method,
      headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);

    // Abort: se o sinal já está abortado, simula o AbortError do fetch real.
    if (init.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    const resolved = typeof handler === 'function' ? handler(call) : handler;
    const ok = resolved.status >= 200 && resolved.status < 300;
    const bodyText = typeof resolved.sse === 'string' ? resolved.sse : undefined;
    const bodyIter =
      typeof resolved.sse === 'string' ? bytes(resolved.sse) : (resolved.sse ?? null);

    return makeResponse({
      status: resolved.status,
      ok,
      headers: resolved.headers ?? {},
      body: ok ? bodyIter : null,
      jsonBody: resolved.json,
      textBody: bodyText,
    });
  };
  return { fetch, calls };
}

function makeResponse(opts: {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array | string> | null;
  jsonBody?: unknown;
  textBody?: string;
}): StreamResponse {
  return {
    status: opts.status,
    ok: opts.ok,
    headers: {
      get: (name: string) => opts.headers[name.toLowerCase()] ?? null,
    },
    body: opts.body,
    json: async () => opts.jsonBody,
    text: async () => opts.textBody ?? '',
  };
}
