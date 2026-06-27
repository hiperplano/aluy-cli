// EST-1075 · HR-SEC-1 + HR-SEC-2 (ADR-0102) — o PORTÃO de rede do headroom: valida o
// destino (loopback-only via `classifyHeadroomTarget`) e faz o fetch PINADO ao IP
// loopback validado (anti-DNS-rebinding) — REUSANDO a malha anti-SSRF do CLI-SEC-13.
//
// É o ÚNICO ponto por onde compress (`headroom.ts`) E retrieve (`headroom-retrieve.ts`)
// falam com o proxy. Nenhum dos dois usa `globalThis.fetch` direto contra `baseUrl`:
// ambos passam por aqui, então a recusa de destino não-loopback é uniforme — crítico
// porque o COMPRESS roda automático SEM `ask` (um destino remoto exfiltraria o prompt).
//
// O pin: depois que `classifyHeadroomTarget` prova que TODOS os IPs resolvidos são
// loopback, conectamos ao IP loopback VALIDADO (não re-resolvemos o nome) — fecha o
// rebinding (resolve→loopback no check, →público no connect). Pra loopback http isso
// é direto; o `Host` header é irrelevante p/ um proxy local.

import { classifyHeadroomTarget, type HostResolver } from '@hiperplano/aluy-cli-core';
import { NodeHostResolver } from '../io/web-port.js';

export interface HeadroomFetchDeps {
  /** Resolver de host (DNS). Default: `NodeHostResolver` (concreto). Injetável p/ teste. */
  readonly resolver?: HostResolver;
  /** `fetch` injetável (teste). Default `globalThis.fetch`. */
  readonly fetchFn?: typeof fetch;
}

export type HeadroomFetchOutcome =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly reason: string };

/**
 * Valida `baseUrl` (loopback-only) e faz `fetch` PINADO a `path` no IP loopback. Recusa
 * (`ok:false`, SEM enviar byte) qualquer destino não-loopback/inválido. `path` é o
 * endpoint absoluto a partir da raiz (ex.: `/v1/compress`). Não captura exceções de rede
 * do fetch — o caller decide (compress=fail-open; retrieve=erro visível).
 */
export async function headroomFetch(
  baseUrl: string,
  path: string,
  init: RequestInit,
  deps: HeadroomFetchDeps = {},
): Promise<HeadroomFetchOutcome> {
  const resolver = deps.resolver ?? new NodeHostResolver();
  const fetchFn = deps.fetchFn ?? (globalThis.fetch as typeof fetch | undefined);
  if (typeof fetchFn !== 'function') {
    return { ok: false, reason: 'fetch indisponível neste runtime.' };
  }

  const target = await classifyHeadroomTarget(baseUrl, resolver);
  if (!target.ok) return { ok: false, reason: target.reason };

  // Preserva a porta do `baseUrl`; pina o HOST ao IP loopback validado (anti-rebinding).
  let port = '';
  try {
    port = new URL(baseUrl).port;
  } catch {
    /* baseUrl já passou por parseHttpUrl dentro do classify — não deve cair aqui. */
  }
  const host = target.pinnedIp.includes(':') ? `[${target.pinnedIp}]` : target.pinnedIp;
  const url = `${target.scheme}://${host}${port !== '' ? `:${port}` : ''}${path}`;
  const response = await fetchFn(url, init);
  return { ok: true, response };
}
