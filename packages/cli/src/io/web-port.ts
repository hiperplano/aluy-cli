// EST-0971 · CLI-SEC-13 — I/O CONCRETO da WebPort (cravada do `seguranca`).
//
// Liga as portas PORTÁVEIS do core (HostResolver/PinnedFetcher/EgressGuard) ao DNS
// e ao socket reais, sob as travas anti-SSRF:
//   - RESOLVER: `dns.lookup(host, { all:true })` ⇒ TODOS os IPs (A+AAAA). O CORE
//     valida cada um contra a denylist dura (ssrf.ts) ANTES de conectar.
//   - FETCHER PINADO: conecta ao IP JÁ VALIDADO via a opção `lookup` do agent
//     `http(s)` — que SOBRESCREVE a resolução de DNS e devolve SEMPRE o IP pinado.
//     Assim o socket vai LITERALMENTE ao IP que validamos: NÃO há 2ª resolução, e
//     o DNS-rebinding (2º lookup com TTL0 devolvendo um IP interno) não tem voz.
//     O Host-header e o SNI (`servername`) preservam o vhost/TLS do host original.
//   - NÃO segue redirect (manualRedirect): devolve `status`+`location` p/ o CORE
//     re-aplicar resolve→valida→pina sobre a nova URL (cada hop revalidado).
//   - TETOS: timeout (mata o socket sem travar a sessão) + maxBytes (EST-0970 fix OOM:
//     PARA de ler ao bater o teto — `res.destroy()` — e recorta o chunk que estoura;
//     a memória de pico fica LIMITADA a ~maxBytes, a resposta de N MB nem entra inteira
//     no heap. 2ª camada do anti-OOM; a 1ª é o cap da observação no core).
//
// É aqui que mora o `node:dns`/`node:http(s)` — NUNCA no core (fronteira §8).

import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { LookupFunction } from 'node:net';
import type {
  HostResolver,
  PinnedFetcher,
  PinnedFetchArgs,
  PinnedResponse,
  EgressGuard,
  EgressDecision,
  WebPort,
  WebFetchPolicy,
  SafeFetcherPorts,
} from '@hiperplano/aluy-cli-core';
import type { EgressAllowlist } from './egress.js';

/** Resolver concreto: `dns.lookup` com `all:true` ⇒ todos os IPs (A + AAAA). */
export class NodeHostResolver implements HostResolver {
  async resolve(host: string): Promise<readonly string[]> {
    return await new Promise<string[]>((resolvePromise, reject) => {
      dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
        if (err) {
          reject(err);
          return;
        }
        const ips = (addresses ?? []).map((a) => a.address).filter((a) => a.length > 0);
        resolvePromise(ips);
      });
    });
  }
}

export interface NodePinnedFetcherOptions {
  /** request injetável p/ teste (default: node:https/http). */
  readonly httpsRequestFn?: typeof httpsRequest;
  readonly httpRequestFn?: typeof httpRequest;
  /** User-Agent enviado (default: aluy-vau). */
  readonly userAgent?: string;
}

/**
 * Fetcher PINADO: conecta ao IP validado (sem re-resolver) usando a opção `lookup`
 * do agent, que intercepta a resolução e devolve SEMPRE o `pinnedIp`. NÃO segue
 * redirect — devolve status+location p/ o core revalidar a nova URL.
 */
export class NodePinnedFetcher implements PinnedFetcher {
  private readonly httpsRequestFn: typeof httpsRequest;
  private readonly httpRequestFn: typeof httpRequest;
  private readonly userAgent: string;

  constructor(opts: NodePinnedFetcherOptions = {}) {
    this.httpsRequestFn = opts.httpsRequestFn ?? httpsRequest;
    this.httpRequestFn = opts.httpRequestFn ?? httpRequest;
    // EST-0971 (fix): UA browser-like. O endpoint HTML do DDG (e muitos sites)
    // devolvem página-desafio/202 sem resultados a UAs obviamente-bot. Mantém o
    // sufixo `aluy-vau` p/ honestidade (não nos passamos por outra coisa).
    this.userAgent =
      opts.userAgent ??
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0 Safari/537.36 aluy-vau/web';
  }

  async fetchPinned(args: PinnedFetchArgs): Promise<PinnedResponse> {
    const u = new URL(args.url);
    const isHttps = u.protocol === 'https:';

    // A TRAVA DO PIN: `lookup` sobrescreve a resolução de DNS do agent e devolve
    // SEMPRE o IP que o core já validou. O socket conecta a ESTE IP — nunca a um
    // 2º lookup. É o que fecha o DNS-rebinding (o IP validado = o IP conectado).
    // O agent pode chamar com `options.all` (espera um array `[{address,family}]`)
    // ou na forma simples (espera `(err, address, family)`) — atendemos ambos.
    const family = args.pinnedIp.includes(':') ? 6 : 4;
    const pinnedLookup = ((
      _hostname: string,
      options: unknown,
      callback: (...cbArgs: unknown[]) => void,
    ): void => {
      const wantsAll =
        typeof options === 'object' &&
        options !== null &&
        (options as { all?: boolean }).all === true;
      if (wantsAll) {
        callback(null, [{ address: args.pinnedIp, family }]);
      } else {
        callback(null, args.pinnedIp, family);
      }
    }) as unknown as LookupFunction;

    const requestFn = isHttps ? this.httpsRequestFn : this.httpRequestFn;

    return await new Promise<PinnedResponse>((resolvePromise, reject) => {
      let settled = false;
      // HUNT-IO-NET — o `args.signal` é o signal do LOOP (longevo: vive o turno/sessão),
      // e o `safeFetch` do core o REUSA a cada hop de redirect (até `maxRedirects`+1
      // fetchPinned por web_fetch). Sem remover o listener de 'abort' no settle, cada hop
      // (e cada web_fetch/web_search da sessão) ACUMULA um listener nunca-removido nesse
      // mesmo signal ⇒ MaxListenersExceededWarning + closures retidas (req/chunks). O
      // cleanup abaixo (espelha `done`/`fail`/onAbort do shell-port, EST-0982) o remove.
      const cleanup = (): void => {
        clearTimeout(timer);
        if (args.signal && onAbort) args.signal.removeEventListener('abort', onAbort);
      };
      const done = (r: PinnedResponse): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(r);
      };
      const fail = (e: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      };

      // EST-0971 (fix): método/corpo do hop (default GET). O web_search manda POST
      // form-encoded — o endpoint HTML do DDG só devolve resultados via POST (um GET
      // cai numa página-desafio 202). O PIN/anti-SSRF é idêntico: o socket vai ao IP
      // já validado; só o verbo/corpo mudam.
      const method = args.method ?? 'GET';
      const body = method === 'POST' ? (args.body ?? '') : undefined;
      const bodyHeaders =
        body !== undefined
          ? {
              'Content-Type': args.contentType ?? 'application/x-www-form-urlencoded',
              'Content-Length': String(Buffer.byteLength(body)),
            }
          : {};

      const req = requestFn(
        {
          protocol: u.protocol,
          // host original p/ o Host-header e o SNI/cert (vhost preservado).
          host: args.host,
          servername: args.host,
          port: u.port ? Number(u.port) : isHttps ? 443 : 80,
          path: u.pathname + u.search,
          method,
          // O PIN: a resolução SEMPRE devolve o IP validado.
          lookup: pinnedLookup,
          headers: {
            Host: u.port ? `${args.host}:${u.port}` : args.host,
            'User-Agent': this.userAgent,
            Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            ...bodyHeaders,
          },
          // NÃO seguir redirect aqui — o core revalida cada hop.
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = firstHeader(res.headers['location']);
          const contentType = firstHeader(res.headers['content-type']);

          // Redirect: não lê o corpo (o core vai re-fazer o hop). Drena e devolve.
          if (isRedirectStatus(status) && location) {
            res.resume();
            done({ status, location, body: '', ...(contentType ? { contentType } : {}) });
            return;
          }

          // EST-0970 (fix OOM) — TETO DE BYTES DE VERDADE. O código antigo (a)
          // empurrava o chunk INTEIRO mesmo que estourasse (received começa em 0 ⇒ o
          // 1º chunk ia sempre, podendo ser MBs) e (b) NÃO destruía o socket ⇒ seguia
          // recebendo a resposta gigante da rede inteira (só descartando). Agora:
          // recortamos o chunk que cruza a fronteira p/ guardar SÓ até maxBytes, e
          // DESTRUÍMOS o request ao bater o teto — paramos de ler. Assim a memória de
          // pico fica LIMITADA a ~maxBytes: a resposta de N MB NÃO entra inteira no
          // heap (é a 2ª camada do anti-OOM, antes do cap da observação no core).
          let received = 0;
          let truncated = false;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            if (truncated) return; // já saturou; ignora o resto que ainda chegar
            const remaining = args.maxBytes - received;
            if (remaining <= 0) {
              truncated = true;
              res.destroy(); // PARA de ler — não drena N MB pela rede
              return;
            }
            if (chunk.length > remaining) {
              chunks.push(chunk.subarray(0, remaining));
              received += remaining;
              truncated = true;
              res.destroy(); // recortou o chunk que estourou; para aqui
              return;
            }
            chunks.push(chunk);
            received += chunk.length;
          });
          res.on('end', () => {
            let body = Buffer.concat(chunks).toString('utf8');
            if (truncated) {
              body += `\n…[truncado: corpo maior que ${args.maxBytes} bytes]`;
            }
            done({ status, body, ...(contentType ? { contentType } : {}) });
          });
          // `res.destroy()` emite 'close'/'aborted'; garantimos a entrega do que já
          // lemos (não falhamos um fetch só porque truncou). Se ainda não resolvemos
          // e não há erro real, fecha com o corpo parcial.
          res.on('close', () => {
            if (settled) return;
            const body =
              Buffer.concat(chunks).toString('utf8') +
              (truncated ? `\n…[truncado: corpo maior que ${args.maxBytes} bytes]` : '');
            done({ status, body, ...(contentType ? { contentType } : {}) });
          });
          res.on('error', (e: Error) => {
            // Um `destroy()` proposital (truncamento) pode emitir ERR_STREAM_PREMATURE_CLOSE
            // / ECONNRESET — NÃO é falha: já temos o corpo parcial. Só falha erro real.
            if (truncated) {
              if (settled) return;
              const body =
                Buffer.concat(chunks).toString('utf8') +
                `\n…[truncado: corpo maior que ${args.maxBytes} bytes]`;
              done({ status, body, ...(contentType ? { contentType } : {}) });
              return;
            }
            fail(e);
          });
        },
      );

      // Handler de abort NOMEADO (não anônimo) p/ que o `cleanup` consiga REMOVÊ-LO no
      // settle — senão o listener vaza no `args.signal` longevo do loop (ver nota acima).
      const onAbort = (): void => {
        req.destroy();
        fail(new Error('cancelado'));
      };

      // ANTI-HANG: timeout mata o socket sem travar a sessão (CLI-SEC-8/13).
      const timer = setTimeout(() => {
        req.destroy();
        fail(new Error(`timeout de ${args.timeoutMs}ms ao buscar a URL`));
      }, args.timeoutMs);
      timer.unref?.();

      if (args.signal) {
        if (args.signal.aborted) {
          req.destroy();
          fail(new Error('cancelado'));
          return;
        }
        args.signal.addEventListener('abort', onAbort);
      }

      req.on('error', fail);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}

/** Adapta a `EgressAllowlist` concreta (CLI-SEC-5) à porta `EgressGuard` do core. */
export class EgressAllowlistGuard implements EgressGuard {
  constructor(private readonly allowlist: EgressAllowlist) {}
  checkHost(host: string): EgressDecision {
    const normalized = host.trim().toLowerCase();
    return { allowed: this.allowlist.isAllowed(normalized), host: normalized };
  }
}

/** Monta a `WebPort` concreta (resolver + fetcher pinado + egress + tetos). */
export function createWebPort(opts: {
  readonly egress: EgressAllowlist;
  readonly policy?: WebFetchPolicy;
  readonly resolver?: HostResolver;
  readonly fetcher?: PinnedFetcher;
}): WebPort {
  const safe: SafeFetcherPorts = {
    resolver: opts.resolver ?? new NodeHostResolver(),
    fetcher: opts.fetcher ?? new NodePinnedFetcher(),
  };
  return {
    safe,
    egress: new EgressAllowlistGuard(opts.egress),
    ...(opts.policy ? { policy: opts.policy } : {}),
  };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}
