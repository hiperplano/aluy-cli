// ADR-0120 / EST-1113 · PROV-SEC-1 (NET-NEW) — ANTI-SSRF do `base_url` configurável.
//
// O backend local pode ter um `base_url` de provider OVERRIDADO pelo usuário/config
// (ex.: um gateway OpenAI-compat próprio). Um `base_url` malicioso/injetado poderia
// apontar p/ um alvo INTERNO (metadata da cloud `169.254.169.254`, localhost, RFC1918,
// link-local) — e o backend local NÃO tem a trava server-side do broker. Por isso
// REUSAMOS o anti-SSRF DURO do CLI-SEC-13 (web_fetch/web_search): resolve o host →
// classifica cada IP contra a denylist → BLOQUEIA se qualquer um cair em faixa interna.
//
// PORTÁVEL (ADR-0053 §8): a denylist (`ssrf.ts`) é pura; o resolver de DNS é a MESMA
// porta `HostResolver` injetada (o locus liga ao `dns.lookup`). Os `base_url` DEFAULT
// (api.anthropic.com / openrouter.ai / api.openai.com) são públicos e fixos — a
// validação protege o OVERRIDE. Só `https`/`http`; só host (não IP-literal interno).

import { validateResolvedIps, classifyIp } from '../../agent/web/ssrf.js';
import type { HostResolver } from '../../agent/web/fetcher.js';

/** Resultado da validação de um `base_url`. */
export type BaseUrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse + esquema. Só `https:`/`http:` (https default). Devolve a URL canônica ou
 * o motivo da recusa. Um host VAZIO ou esquema não-http ⇒ recusa.
 */
function parseHttpUrl(raw: string): { url: URL } | { reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: `base_url inválida: "${raw}"` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { reason: `base_url precisa ser http(s): "${raw}"` };
  }
  if (url.hostname === '') return { reason: `base_url sem host: "${raw}"` };
  return { url };
}

/**
 * VALIDA um `base_url` configurável contra a denylist anti-SSRF (PROV-SEC-1).
 *
 * 1) parseia (só http/https, host não-vazio);
 * 2) se o host JÁ é um IP-literal (inclusive decimal/octal/hex/IPv4-mapped), o
 *    classifica DIRETO (sem resolver) — fecha `http://2130706433/` etc.;
 * 3) senão, RESOLVE o host (porta injetada) e classifica TODOS os IPs; 1 interno
 *    ⇒ recusa. Fail-safe: host que não resolve ⇒ recusa (não conectamos às cegas).
 *
 * NÃO pina o IP aqui (o fetch ao provider é uma chamada simples, não um web_fetch
 * com redirects); a validação é a barreira — o connect usa o host validado.
 */
export async function validateProviderBaseUrl(
  raw: string,
  resolver: HostResolver,
): Promise<BaseUrlCheck> {
  const parsed = parseHttpUrl(raw);
  if ('reason' in parsed) return { ok: false, reason: parsed.reason };
  const host = parsed.url.hostname.replace(/^\[/, '').replace(/\]$/, '');

  // Host que JÁ é IP-literal: classifica direto (decimal/octal/hex/IPv4-mapped).
  const literal = classifyIp(host);
  if (literal.blocked && isProbablyIpLiteral(host)) {
    return { ok: false, reason: `base_url aponta p/ IP interno (${literal.reason})` };
  }

  let ips: readonly string[];
  try {
    ips = await resolver.resolve(host);
  } catch {
    return { ok: false, reason: `base_url: host "${host}" não resolveu (anti-SSRF, fail-safe)` };
  }
  const verdict = validateResolvedIps(ips);
  if (!verdict.ok) {
    return { ok: false, reason: `base_url aponta p/ IP interno (${verdict.reason})` };
  }
  return { ok: true, url: parsed.url.toString() };
}

/** Resultado de resolver+validar+pinar um host (EST-1115). */
export type PinResult =
  | { readonly ok: true; readonly host: string; readonly pinnedIp: string }
  | { readonly ok: false; readonly reason: string };

/**
 * EST-1115 · PROV-SEC-1 (IP-PIN p/ o egress BYO) — resolve UMA URL → valida cada
 * IP contra a denylist DURA → devolve o IP a PINAR (sem 2ª resolução). É a MESMA
 * mecânica do CLI-SEC-13 (web_fetch), mas usada pelo fetch STREAMING do backend
 * local: o locus conecta ao `pinnedIp` (via a opção `lookup` do agent http(s)) em
 * vez de deixar o `globalThis.fetch` re-resolver o host na hora (DNS-rebinding).
 *
 * PORTÁVEL (ADR-0053 §8): só denylist (pura) + a porta `HostResolver` injetada.
 * O fetch pinado/streaming concreto mora no @hiperplano/aluy-cli (perto do `web-port.ts`).
 *
 * Diferença do `validateProviderBaseUrl`: aqui DEVOLVE o IP pinado (o egress vai
 * conectar AO IP validado, não re-resolver) e re-aplica-se a CADA hop de redirect.
 */
export async function resolveAndPinHost(raw: string, resolver: HostResolver): Promise<PinResult> {
  const parsed = parseHttpUrl(raw);
  if ('reason' in parsed) return { ok: false, reason: parsed.reason };
  const host = parsed.url.hostname.replace(/^\[/, '').replace(/\]$/, '');

  // Host que JÁ é IP-literal (decimal/octal/hex/IPv4-mapped): classifica direto.
  if (isProbablyIpLiteral(host)) {
    const literal = classifyIp(host);
    if (literal.blocked) {
      return { ok: false, reason: `aponta p/ IP interno (${literal.reason})` };
    }
    return { ok: true, host, pinnedIp: literal.canonical };
  }

  let ips: readonly string[];
  try {
    ips = await resolver.resolve(host);
  } catch {
    return { ok: false, reason: `host "${host}" não resolveu (anti-SSRF, fail-safe)` };
  }
  const verdict = validateResolvedIps(ips);
  if (!verdict.ok) {
    return { ok: false, reason: `aponta p/ IP interno (${verdict.reason})` };
  }
  return { ok: true, host, pinnedIp: verdict.pinnedIp };
}

/**
 * Heurística leve: o host PARECE um IP-literal (e não um hostname)? Só então
 * tratamos o `classifyIp(host).blocked` como "IP interno literal" (um hostname
 * comum nunca canonicaliza p/ IPv4, então `classifyIp` o bloquearia como
 * "não-reconhecido" — não é o que queremos antes de resolver). Cobre dotted,
 * decimal puro, hex (0x), e qualquer coisa com `:` (IPv6).
 */
function isProbablyIpLiteral(host: string): boolean {
  if (host.includes(':')) return true; // IPv6
  if (/^\d+$/.test(host)) return true; // decimal puro (2130706433)
  if (/^0x[0-9a-fA-F]+$/.test(host)) return true; // hex
  if (/^(\d{1,3}\.){1,3}\d{1,3}$/.test(host)) return true; // dotted / curto
  if (/^0[0-7]+(\.|$)/.test(host)) return true; // octal-ish
  return false;
}
