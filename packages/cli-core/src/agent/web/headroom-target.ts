// EST-1075 · HR-SEC-1 + HR-SEC-2 (ADR-0102 / APR-0099) — a defesa DURA do destino
// headroom: resolve `ALUY_HEADROOM_URL` → exige que TODOS os IPs sejam LOOPBACK →
// devolve o IP pinado p/ conectar (anti-DNS-rebinding). REUSA a malha do CLI-SEC-13
// (`parseHttpUrl` + `HostResolver` + `isLoopbackIp`/`classifyIp`) — NÃO reimplementa
// a taxonomia de IP (que trata `2130706433`, `0177.0.0.1`, `::ffff:127.0.0.1`, etc.).
//
// POR QUÊ um caminho DEDICADO (em vez de `safeFetch`): o `safeFetch` do `web_fetch`
// BLOQUEIA loopback por construção (egress externo). O headroom é o oposto —
// LOOPBACK-ONLY. E NÃO se resolve com `allowInternalHosts:true` (isso suspende a
// denylist INTEIRA — RFC1918, metadata, link-local junto). Aqui invertemos: loopback
// é o ÚNICO destino aceito; qualquer outro IP (público OU interno) recusa.
//
// É a MESMA defesa p/ HR-SEC-1 e HR-SEC-2: o compress (automático, SEM `ask`) e o
// `headroom_retrieve` (com `ask`) passam AMBOS por aqui antes de qualquer byte sair.

import { parseHttpUrl, type HostResolver } from './fetcher.js';
import { isLoopbackIp } from './ssrf.js';

/** Veredito do destino headroom. `ok` ⇒ pode falar com o proxy (IP loopback pinado). */
export type HeadroomTargetResult =
  | {
      readonly ok: true;
      /** O IP LOOPBACK validado ao qual conectar (pin — NÃO re-resolver). */
      readonly pinnedIp: string;
      readonly scheme: string;
      readonly host: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Classifica `baseUrl` (`ALUY_HEADROOM_URL`) p/ o caminho LOOPBACK-ONLY do headroom.
 * RECUSA (sem vazar byte): esquema ≠ http/https, host que não resolve, host que
 * resolve p/ ZERO IP, ou QUALQUER IP resolvido NÃO-loopback (anti-rebinding: um
 * conjunto misto `[loopback, público]` recusa — o atacante não escolhe o IP). IP
 * literal na URL é classificado direto (sem resolver). PURO quanto à política; o
 * `resolver` é injetado (CLI-SEC-13: a resolução de DNS é porta do locus concreto).
 */
export async function classifyHeadroomTarget(
  baseUrl: string,
  resolver: HostResolver,
): Promise<HeadroomTargetResult> {
  const parsed = parseHttpUrl(baseUrl);
  if ('error' in parsed) return { ok: false, reason: parsed.error };

  // IP-literal na URL ⇒ classifica direto; nome ⇒ resolve (todos os IPs).
  let ips: readonly string[];
  if (parsed.literalIp !== undefined) {
    ips = [parsed.literalIp];
  } else {
    try {
      ips = await resolver.resolve(parsed.host);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: `falha ao resolver "${parsed.host}": ${msg}` };
    }
  }
  if (ips.length === 0) {
    return { ok: false, reason: `host "${parsed.host}" não resolveu nenhum IP` };
  }

  // TODOS têm de ser loopback. Anti-rebinding: um único IP não-loopback no conjunto
  // já recusa (o atacante poderia devolver `[127.0.0.1, 1.2.3.4]` e escolher o público
  // na conexão). Loopback é o ÚNICO destino aceito — público OU interno recusam.
  for (const ip of ips) {
    if (!isLoopbackIp(ip)) {
      return {
        ok: false,
        reason: `destino NÃO-loopback (${ip}) — headroom só fala com proxy local (HR-SEC-2)`,
      };
    }
  }

  return { ok: true, pinnedIp: ips[0]!, scheme: parsed.scheme, host: parsed.host };
}
