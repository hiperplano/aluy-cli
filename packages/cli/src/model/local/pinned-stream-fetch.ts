// EST-1115 · PROV-SEC-1 (IP-PIN + redirect-revalidation no egress BYO) — I/O CONCRETO.
//
// O backend LOCAL/BYO (ADR-0120) fala com o provider de LLM DIRETO. Sem a trava
// server-side do broker, o egress precisa da MESMA defesa anti-SSRF do CLI-SEC-13
// (web_fetch) — mas STREAMING (SSE token-a-token), não buffer. Por isso NÃO dá p/
// reusar o `safeFetch` (que bufferiza com cap de 256KB); reusamos a CLASSIFICAÇÃO
// de IP (`resolveAndPinHost`, core) + a técnica de PIN do `web-port.ts`, num fetch
// que devolve o corpo como STREAM.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ DUAS travas (fecham os 2 vetores p/ a metadata da cloud 169.254.169.254):  ║
// ║  1. IP-PIN: resolve→valida→conecta AO IP validado via a opção `lookup` do   ║
// ║     agent http(s) (sobrescreve o DNS). O socket vai LITERALMENTE ao IP que  ║
// ║     validamos — NÃO há 2ª resolução ⇒ DNS-rebinding (TTL0) não tem voz.     ║
// ║  2. REDIRECT fail-closed: `redirect:'error'` (default deste fetch) rejeita  ║
// ║     QUALQUER 3xx — um `302 → http://169.254.169.254/` jamais é seguido.     ║
// ║     `'manual'` revalida cada hop pelo MESMO anti-SSRF (pin do novo host).   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// É aqui que mora `node:dns`/`node:http(s)` — NUNCA no core (fronteira §8). O core
// só recebe a porta PORTÁVEL `StreamFetch`; a factory injeta este fetch pinado no
// `LocalModelClient` (em vez de deixar cair no `globalThis.fetch` cru).

import { request as httpsRequest, type RequestOptions } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import {
  resolveAndPinHost,
  type StreamFetch,
  type StreamResponse,
  type HostResolver,
} from '@aluy/cli-core';
import { NodeHostResolver } from '../../io/web-port.js';

export interface PinnedStreamFetchOptions {
  /** Resolver de DNS (default: NodeHostResolver). Injetável p/ teste. */
  readonly resolver?: HostResolver;
  /** request injetável p/ teste (default: node:https/http). */
  readonly httpsRequestFn?: typeof httpsRequest;
  readonly httpRequestFn?: typeof httpRequest;
  /** Teto de hops de redirect a revalidar (anti-loop). Default 0 = fail-closed. */
  readonly maxRedirects?: number;
}

/**
 * Cria um `StreamFetch` (subset WHATWG que o `LocalModelClient` consome) que conecta
 * ao IP VALIDADO/PINADO e trata redirect conforme a política (default fail-closed).
 * O corpo é a `IncomingMessage` (async-iterable de Buffers) — o `parseSse` a consome
 * direto, sem bufferizar (streaming SSE preservado).
 */
export function createPinnedStreamFetch(opts: PinnedStreamFetchOptions = {}): StreamFetch {
  const resolver = opts.resolver ?? new NodeHostResolver();
  const httpsRequestFn = opts.httpsRequestFn ?? httpsRequest;
  const httpRequestFn = opts.httpRequestFn ?? httpRequest;
  const maxRedirects = opts.maxRedirects ?? 0;

  return async function pinnedFetch(input, init) {
    // Política de redirect (back-compat: ausente ⇒ fail-closed p/ o BYO).
    const redirectPolicy = init.redirect ?? 'error';
    let url = input;
    let hops = 0;
    // PROV-SEC-1 (cred-leak) — a ORIGEM (scheme+host+port) que o caller autenticou. A
    // credencial BYO (`Authorization`) só pode ir p/ ESTA origem; ao cruzá-la num
    // redirect, os headers sensíveis são STRIPADOS (`headers` muta p/ os próximos hops).
    const originalOrigin = new URL(input).origin;
    let headers = init.headers;

    for (;;) {
      // (1) IP-PIN: resolve→valida→pina ESTE host (re-aplicado a cada hop).
      const pin = await resolveAndPinHost(url, resolver);
      if (!pin.ok) {
        throw new Error(`backend local: egress recusado — ${pin.reason} (PROV-SEC-1, anti-SSRF)`);
      }

      const res = await connectPinned({
        url,
        host: pin.host,
        pinnedIp: pin.pinnedIp,
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        httpsRequestFn,
        httpRequestFn,
      });

      const status = res.statusCode ?? 0;
      const location = firstHeader(res.headers.location);

      // (2) REDIRECT: revalida (manual) OU falha-fechado (error) OU segue (follow).
      if (isRedirectStatus(status) && location !== undefined) {
        if (redirectPolicy === 'error') {
          res.resume(); // drena p/ liberar o socket
          throw new Error(
            `backend local: redirect (${status} → ${location}) BLOQUEADO ` +
              `(PROV-SEC-1, anti-SSRF: redirect não-revalidado é vetor p/ metadata da cloud)`,
          );
        }
        if (redirectPolicy === 'manual') {
          res.resume();
          return toStreamResponse(res, status); // devolve a resposta de redirect crua
        }
        // 'follow': revalida o novo host pelo MESMO anti-SSRF (re-pina), com teto.
        if (hops >= maxRedirects) {
          res.resume();
          throw new Error(
            `backend local: excesso de redirects (>${maxRedirects}) — abortado (anti-SSRF)`,
          );
        }
        const nextUrl = new URL(location, url).toString();
        // PROV-SEC-1 (cred-leak) — ao CRUZAR a origem autenticada, STRIPPA os headers
        // sensíveis antes do próximo hop: seguir mantendo `Authorization`/`Cookie`
        // vazaria a credencial BYO p/ o host do redirect (3xx de provider comprometido/
        // MITM). O re-pin só barra IP interno/metadata — um host PÚBLICO do atacante
        // passaria. É o padrão web (fetch strippa `Authorization` em redirect cross-
        // origin). Same-origin (mesmo scheme+host+port) mantém os headers.
        if (new URL(nextUrl).origin !== originalOrigin) {
          headers = stripSensitiveHeaders(headers);
        }
        res.resume();
        url = nextUrl;
        hops += 1;
        continue;
      }

      return toStreamResponse(res, status);
    }
  };
}

export interface ConnectArgs {
  readonly url: string;
  readonly host: string;
  readonly pinnedIp: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly httpsRequestFn: typeof httpsRequest;
  readonly httpRequestFn: typeof httpRequest;
}

/**
 * Conecta ao IP PINADO (sem re-resolver) via a opção `lookup` do agent — que
 * intercepta a resolução e devolve SEMPRE o `pinnedIp`. O Host-header/SNI preservam
 * o vhost/TLS do host original. Resolve com a `IncomingMessage` (corpo streamável).
 */
export function connectPinned(args: ConnectArgs): Promise<IncomingMessage> {
  const u = new URL(args.url);
  const isHttps = u.protocol === 'https:';
  const family = args.pinnedIp.includes(':') ? 6 : 4;

  // A TRAVA DO PIN — a resolução do agent SEMPRE devolve o IP que validamos.
  const pinnedLookup = ((
    _hostname: string,
    options: unknown,
    callback: (...cbArgs: unknown[]) => void,
  ): void => {
    const wantsAll =
      typeof options === 'object' &&
      options !== null &&
      (options as { all?: boolean }).all === true;
    if (wantsAll) callback(null, [{ address: args.pinnedIp, family }]);
    else callback(null, args.pinnedIp, family);
  }) as unknown as LookupFunction;

  const requestFn = isHttps ? args.httpsRequestFn : args.httpRequestFn;
  const body = args.body;
  const headers: Record<string, string> = { ...args.headers, Host: hostHeader(u, args.host) };
  if (body !== undefined && headers['Content-Length'] === undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(body));
  }

  const options: RequestOptions = {
    protocol: u.protocol,
    host: args.host, // p/ Host-header padrão / SNI
    servername: args.host, // SNI/cert do host ORIGINAL (não do IP)
    port: u.port ? Number(u.port) : isHttps ? 443 : 80,
    path: u.pathname + u.search,
    method: args.method,
    lookup: pinnedLookup, // o PIN
    headers,
  };

  return new Promise<IncomingMessage>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      if (args.signal && onAbort) args.signal.removeEventListener('abort', onAbort);
    };
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };

    const req = requestFn(options, (res) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    });

    const onAbort = (): void => {
      req.destroy();
      const e = new Error('cancelado');
      e.name = 'AbortError';
      fail(e);
    };

    if (args.signal) {
      if (args.signal.aborted) {
        req.destroy();
        const e = new Error('cancelado');
        e.name = 'AbortError';
        fail(e);
        return;
      }
      args.signal.addEventListener('abort', onAbort);
    }

    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Adapta a `IncomingMessage` ao `StreamResponse` (subset que o `LocalModelClient`
 * consome): `status`/`ok`/`headers.get()`/`body` (a própria IncomingMessage, que é
 * async-iterable de Buffers ⇒ o `parseSse` a consome em STREAMING) + `json()`/`text()`
 * (p/ o caminho de ERRO, que bufferiza só a resposta de erro pequena do provider).
 */
function toStreamResponse(res: IncomingMessage, status: number): StreamResponse {
  let consumed = false;
  const drain = async (): Promise<string> => {
    if (consumed) throw new Error('corpo já consumido');
    consumed = true;
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name: string): string | null {
        return firstHeader(res.headers[name.toLowerCase()]) ?? null;
      },
    },
    // O corpo é a própria `IncomingMessage` (async-iterable de Buffers). Ler a
    // PROPRIEDADE não itera o stream (igual ao `Response.body` do WHATWG); o
    // `LocalModelClient` o passa ao `parseSse`, que o consome UMA vez (caminho 2xx).
    // O caminho de ERRO usa json()/text() (drain) — `consumed` impede as duas vias.
    body: consumed ? null : res,
    async json(): Promise<unknown> {
      const text = await drain();
      return text === '' ? undefined : JSON.parse(text);
    },
    text: drain,
  };
}

function hostHeader(u: URL, host: string): string {
  return u.port ? `${host}:${u.port}` : host;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * PROV-SEC-1 (cred-leak) — remove os headers que carregam credencial, p/ NÃO os enviar
 * a uma origem diferente da autenticada num redirect. Case-insensitive (HTTP headers).
 */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
]);
function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}
