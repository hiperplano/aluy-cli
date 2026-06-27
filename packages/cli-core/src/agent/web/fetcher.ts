// EST-0971 · CLI-SEC-13 — o ORQUESTRADOR anti-SSRF: resolve → valida → pina →
// conecta, re-aplicando TUDO a cada redirect. PORTÁVEL: a lógica vive aqui; o DNS
// real e o socket pinado são PORTAS injetadas (@aluy/cli). Testável de ponta a
// ponta com um resolver/fetcher mock (incl. o mock de TTL0 da bateria CA-C1).
//
// FLUXO (cada hop, incl. redirects):
//   1. parseia a URL → host + esquema. Só http/https. IP-literal exótico (decimal/
//      octal/hex/IPv4-mapped) é canonicalizado e classificado ANTES de qualquer rede.
//   2. RESOLVE o host → todos os IPs (porta `HostResolver`).
//   3. VALIDA todos os IPs contra a denylist DURA (ssrf.ts). 1 interno ⇒ ABORTA.
//   4. CONECTA ao IP PINADO (porta `PinnedFetcher.fetchPinned`), passando o Host
//      original p/ TLS/SNI/Host-header — mas o SOCKET vai ao IP validado. NÃO
//      re-resolve (fecha DNS-rebinding: o IP validado é o IP conectado).
//   5. se a resposta é REDIRECT (301/302/303/307/308) e há `location`, repete 1→5
//      sobre a nova URL absoluta. TETO de redirects. Loop/limite ⇒ aborta.
//   6. trunca o corpo ao teto de tamanho; o timeout é da porta (mata sem travar).

import {
  classifyIp,
  validateResolvedIps,
  canonicalizeIpv4,
  ipv4MappedFromV6,
  looksLikeIpv6,
} from './ssrf.js';

/** Porta de RESOLUÇÃO de DNS — o locus concreto liga ao `dns.lookup` (all IPs). */
export interface HostResolver {
  /**
   * Resolve `host` p/ TODOS os IPs (A + AAAA). DEVE devolver os literais de IP
   * (strings). Lança/rejeita se o host não resolve. O CORE valida o que vier.
   */
  resolve(host: string): Promise<readonly string[]>;
}

/** Uma resposta HTTP crua de um hop (sem seguir redirect — quem segue é o core). */
export interface PinnedResponse {
  readonly status: number;
  /** `location` do redirect, quando houver (case-insensitive na porta). */
  readonly location?: string;
  /** Corpo como texto (já limitado pela porta ao teto). Vazio em redirect. */
  readonly body: string;
  /** content-type reportado (p/ a observação rotular). */
  readonly contentType?: string;
}

/** Argumentos de UM hop pinado (a porta NÃO re-resolve — usa o IP que mandamos). */
export interface PinnedFetchArgs {
  /** A URL original (p/ path/query/Host/SNI). */
  readonly url: string;
  /** O HOST do URL (p/ Host-header e SNI/cert). */
  readonly host: string;
  /** O IP VALIDADO ao qual o socket DEVE conectar (pin — sem re-resolver). */
  readonly pinnedIp: string;
  /** Teto de bytes do corpo (a porta trunca). */
  readonly maxBytes: number;
  /** Timeout do hop (ms) — a porta mata o socket sem travar a sessão. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /**
   * EST-0971 (fix) — método do hop. Default `GET`. `POST` é usado pelo web_search
   * (o endpoint HTML do DDG só devolve resultados via POST form-encoded; um GET
   * cai numa página-desafio 202 sem resultados). NUNCA muda a malha anti-SSRF: o
   * IP pinado e a validação são idênticos — só o verbo/corpo da requisição mudam.
   */
  readonly method?: 'GET' | 'POST';
  /** Corpo (já serializado) a enviar num POST. Ignorado em GET. */
  readonly body?: string;
  /** Content-Type do corpo do POST (ex.: `application/x-www-form-urlencoded`). */
  readonly contentType?: string;
}

/** Porta de FETCH pinado — conecta ao IP dado, sem re-resolver. NÃO segue redirect. */
export interface PinnedFetcher {
  fetchPinned(args: PinnedFetchArgs): Promise<PinnedResponse>;
}

/** Tetos/políticas do fetch (CLI-SEC-8/13). Defaults seguros; o locus pode apertar. */
export interface WebFetchPolicy {
  /** Teto de bytes do corpo devolvido (trunca). Default 256 KiB. */
  readonly maxBytes?: number;
  /** Timeout por hop (ms). Default 15s. A porta mata o socket. */
  readonly timeoutMs?: number;
  /** Teto de redirects encadeados (anti-loop / anti-rebind-por-redirect). Default 5. */
  readonly maxRedirects?: number;
  /**
   * EST-0991 · ADR-0072 — YOLO (anti-SSRF de faixas internas DERRUBADO). `true` ⇒
   * NÃO bloqueia destinos internos (loopback/RFC1918/link-local/metadata-cloud): o
   * agente PODE alcançar `localhost`/`169.254.169.254`/serviços internos. Por
   * decisão do dono (Alternativa C do ADR-0072 — paridade com Claude Code, onde
   * `bash` livre alcança a rede interna de qualquer jeito). A mecânica do PIN
   * PERMANECE (resolve→pina→conecta ao IP validado, sem re-resolver) — só a
   * DENYLIST de faixa interna é suspensa. Default `false` (anti-SSRF DURO de
   * CLI-SEC-13 intacto em normal/plan). NUNCA persiste — deriva do modo `--yolo`.
   */
  readonly allowInternalHosts?: boolean;
  /**
   * EST-0970 (fix OOM) — TETO DE CARACTERES da OBSERVAÇÃO do `web_fetch` (o blob que
   * entra no CONTEXTO do modelo), distinto e MAIS APERTADO que o `maxBytes` da LEITURA
   * de rede. Defesa em camadas: `maxBytes` impede que a resposta gigante entre inteira
   * na MEMÓRIA (o fetcher para de ler no teto); este teto impede que mesmo o corpo já
   * lido sature a JANELA do modelo (um `web_fetch` do catálogo do OpenRouter saltava
   * de baixo→100% num turno só ⇒ OOM no turno seguinte). A observação é truncada ao
   * teto com marcador claro do tamanho original. Default `DEFAULT_MAX_OBSERVATION_CHARS`.
   */
  readonly maxObservationChars?: number;
}

export const DEFAULT_MAX_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_REDIRECTS = 5;
/**
 * EST-0970 (fix OOM) — teto default de caracteres da OBSERVAÇÃO do `web_fetch` (o que
 * vira contexto do modelo). ~60 KB de texto. Mais apertado que `DEFAULT_MAX_BYTES`
 * (256 KiB lidos da rede) DE PROPÓSITO: a leitura pode trazer mais p/ o fetcher
 * inspecionar, mas o que o MODELO vê é capado aqui — protege a janela de contexto.
 */
export const DEFAULT_MAX_OBSERVATION_CHARS = 60_000;
/** Piso do teto de observação (mínimo útil — pelo menos um cabeçalho + algum corpo). */
export const MIN_MAX_OBSERVATION_CHARS = 256;
/** Teto-teto: nem com config o blob de UM fetch pode ultrapassar isto (anti-OOM duro). */
export const MAX_OBSERVATION_CHARS_CEILING = 500_000;

/**
 * EST-0970 (fix OOM) — resolve o teto EFETIVO de caracteres da observação do
 * `web_fetch` (o blob que entra no contexto), com precedência FLAG/ENV > DEFAULT,
 * VALIDADO e CLAMPADO em `[MIN, CEILING]`. Puro (env como dado): o @aluy/cli lê
 * `ALUY_WEB_FETCH_MAX_CHARS` e passa aqui. Entrada inválida (NaN/≤0/lixo) ⇒ default.
 * O CLAMP é o que preserva o anti-OOM mesmo sob config errada/maliciosa — `0` ou
 * `999999999` NÃO desligam o teto: caem no piso/teto-teto.
 */
export function resolveMaxObservationChars(value?: string | number | undefined): number {
  const parsed = parseObservationCharsSetting(value);
  const chosen = parsed ?? DEFAULT_MAX_OBSERVATION_CHARS;
  return Math.min(MAX_OBSERVATION_CHARS_CEILING, Math.max(MIN_MAX_OBSERVATION_CHARS, chosen));
}

function parseObservationCharsSetting(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/** Resultado do fetch seguro: sucesso (corpo) ou bloqueio (motivo auditável). */
export type SafeFetchResult =
  | {
      readonly ok: true;
      readonly finalUrl: string;
      readonly status: number;
      readonly body: string;
      readonly contentType?: string;
      /** A cadeia de URLs visitadas (p/ auditoria — cada redirect revalidado). */
      readonly chain: readonly string[];
    }
  | {
      readonly ok: false;
      /** Motivo do bloqueio/erro (vira observação p/ o modelo — DADO, CLI-SEC-4). */
      readonly reason: string;
      /** Onde a cadeia parou (p/ a confirmação/auditoria mostrar o destino exato). */
      readonly url: string;
    };

/** As portas que o fetch seguro precisa (injetadas pelo locus concreto). */
export interface SafeFetcherPorts {
  readonly resolver: HostResolver;
  readonly fetcher: PinnedFetcher;
}

/**
 * EST-0971 (fix) — descritor opcional da requisição do 1º hop. Default GET sem
 * corpo (web_fetch). O web_search usa POST form-encoded (o endpoint do DDG exige).
 * Aplica-se SÓ ao 1º hop: um redirect reverte a GET (anti-reenvio de corpo).
 */
export interface SafeFetchRequest {
  readonly method?: 'GET' | 'POST';
  readonly body?: string;
  readonly contentType?: string;
  /**
   * HUNT-IO-NET — o MESMO `AbortSignal` do loop/root-flow (EST-0982). Propagado a
   * CADA hop pinado: ao abortar (Esc/Ctrl-C), o socket é MORTO na hora em vez de
   * pendurar até o timeout do hop. Antes, o `web_fetch`/`web_search`/`mcp search`
   * IGNORAVAM o abort — a sessão "cancelava" mas a conexão seguia viva ~15s.
   */
  readonly signal?: AbortSignal;
}

/**
 * Extrai `{ scheme, host }` de uma URL, REJEITANDO o que não for http/https e
 * canonicalizando o host quando for um IP-literal (decimal/octal/hex/IPv4-mapped).
 * Devolve também o `hostForResolve`: o que será passado ao resolver (um nome) OU,
 * se o host JÁ é um IP-literal, o próprio IP canônico (não resolvemos um IP).
 */
export function parseHttpUrl(
  raw: string,
): { scheme: string; host: string; literalIp?: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: `URL inválida: "${raw}"` };
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return { error: `esquema não permitido: "${scheme}" (só http/https em web_fetch)` };
  }
  // hostname do URL já vem sem colchetes p/ IPv6. Detecta IP-literal e canoniza.
  const rawHost = u.hostname;
  const bracketless = rawHost.replace(/^\[/, '').replace(/\]$/, '');
  // IPv4-literal exótico ou IPv4-mapped-IPv6 ou IPv6 ⇒ é um IP, não um nome.
  const mapped = ipv4MappedFromV6(bracketless);
  if (mapped) return { scheme, host: rawHost, literalIp: mapped };
  if (looksLikeIpv6(bracketless)) return { scheme, host: rawHost, literalIp: bracketless };
  const v4 = canonicalizeIpv4(bracketless);
  // só trata como IP-literal se a string-fonte PARECE numérica (evita tratar um
  // hostname `0x...` improvável; mas `2130706433`/`0177.0.0.1` casam de propósito).
  if (v4 && /^[0-9a-fA-FxX.]+$/.test(bracketless) && /\d/.test(bracketless)) {
    return { scheme, host: rawHost, literalIp: v4 };
  }
  return { scheme, host: rawHost };
}

/**
 * O FETCH SEGURO (CLI-SEC-13). Resolve→valida→pina→conecta, revalidando CADA
 * redirect. Nunca conecta a um IP não-validado; nunca re-resolve o host que já
 * validou (pin). Devolve o corpo (truncado) OU um bloqueio com motivo.
 *
 * O `decision`/catraca NÃO está aqui — quem chama (a tool `web_fetch`) já passou
 * pelo gate (categoria `always-ask:network`, Plan ⇒ deny). Aqui é a defesa de
 * PROFUNDIDADE de rede: mesmo aprovado, o destino interno é barrado no IP.
 */
export async function safeFetch(
  url: string,
  ports: SafeFetcherPorts,
  policy: WebFetchPolicy = {},
  req: SafeFetchRequest = {},
): Promise<SafeFetchResult> {
  const maxBytes = policy.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  // EST-0991 · ADR-0072 — YOLO suspende a DENYLIST de faixa interna (não o PIN).
  const allowInternal = policy.allowInternalHosts === true;

  const chain: string[] = [];
  let current = url;
  // EST-0971 (fix): o método/corpo só valem no 1º hop. Um redirect reverte a GET
  // sem corpo (semântica padrão de 303 / anti-reenvio de corpo p/ outro destino).
  let method: 'GET' | 'POST' = req.method ?? 'GET';
  let body: string | undefined = req.body;
  let contentType: string | undefined = req.contentType;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    chain.push(current);

    // HUNT-IO-NET — abort cooperativo: se o loop já cancelou (Esc/Ctrl-C), NÃO
    // abrimos um novo socket. Entre redirects também: cada hop relê o signal.
    if (req.signal?.aborted) {
      return { ok: false, reason: 'busca cancelada (abort do loop).', url: current };
    }

    // 1) parse + esquema + canonicalização de IP-literal.
    const parsed = parseHttpUrl(current);
    if ('error' in parsed) {
      return { ok: false, reason: parsed.error, url: current };
    }

    // 2+3) RESOLVE (ou usa o IP-literal) e VALIDA contra a denylist DURA.
    let pinnedIp: string;
    if (parsed.literalIp) {
      // host já é um IP-literal: classifica direto (sem DNS). Fecha
      // `http://2130706433`, `http://[::ffff:127.0.0.1]`, etc. Sob YOLO
      // (`allowInternal`) a denylist é SUSPENSA — ainda pinamos no IP canônico.
      const c = classifyIp(parsed.literalIp);
      if (c.blocked && !allowInternal) {
        return {
          ok: false,
          reason: `destino interno bloqueado (anti-SSRF): ${c.reason} [${current}]`,
          url: current,
        };
      }
      pinnedIp = c.canonical;
    } else {
      let ips: readonly string[];
      try {
        ips = await ports.resolver.resolve(stripBrackets(parsed.host));
      } catch (e) {
        return {
          ok: false,
          reason: `falha ao resolver "${parsed.host}": ${errMsg(e)}`,
          url: current,
        };
      }
      const verdict = validateResolvedIps(ips);
      if (!verdict.ok) {
        // Sob YOLO (ADR-0072) a denylist de faixa interna NÃO bloqueia: pina no 1º
        // IP resolvido e segue (o PIN/anti-rebind continua — só a denylist some).
        if (!allowInternal) {
          return {
            ok: false,
            reason: `destino interno bloqueado (anti-SSRF): ${verdict.reason} (IP ${verdict.offendingIp}) [host ${parsed.host}]`,
            url: current,
          };
        }
        const first = ips[0];
        if (first === undefined) {
          return {
            ok: false,
            reason: `host "${parsed.host}" não resolveu para nenhum IP`,
            url: current,
          };
        }
        pinnedIp = classifyIp(first).canonical;
      } else {
        pinnedIp = verdict.pinnedIp;
      }
    }

    // 4) CONECTA ao IP PINADO (sem re-resolver — fecha DNS-rebinding).
    let resp: PinnedResponse;
    try {
      resp = await ports.fetcher.fetchPinned({
        url: current,
        host: stripBrackets(parsed.host),
        pinnedIp,
        maxBytes,
        timeoutMs,
        // HUNT-IO-NET — propaga o abort ao socket (mata na hora, não no timeout).
        ...(req.signal ? { signal: req.signal } : {}),
        ...(method === 'POST'
          ? {
              method,
              ...(body !== undefined ? { body } : {}),
              ...(contentType !== undefined ? { contentType } : {}),
            }
          : {}),
      });
    } catch (e) {
      return { ok: false, reason: `falha ao buscar "${current}": ${errMsg(e)}`, url: current };
    }

    // 5) REDIRECT? re-aplica TUDO sobre a nova URL (host novo ⇒ resolve+valida+pina
    //    de novo). Um redirect 302→IP-interno é barrado no PRÓXIMO hop, no passo 3.
    if (isRedirect(resp.status) && resp.location) {
      const next = resolveLocation(current, resp.location);
      if (!next) {
        return {
          ok: false,
          reason: `redirect com Location inválido: "${resp.location}"`,
          url: current,
        };
      }
      current = next;
      // Após um redirect, reverte a GET sem corpo (não reenvia o POST/corpo a um
      // destino diferente — semântica padrão de 303 e defesa anti-reenvio).
      method = 'GET';
      body = undefined;
      contentType = undefined;
      continue;
    }

    // 6) resposta final.
    return {
      ok: true,
      finalUrl: current,
      status: resp.status,
      body: resp.body,
      ...(resp.contentType !== undefined ? { contentType: resp.contentType } : {}),
      chain,
    };
  }

  return {
    ok: false,
    reason: `excedeu o teto de ${maxRedirects} redirects (possível loop)`,
    url: current,
  };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Resolve um `Location` (absoluto ou relativo) contra a URL corrente. */
function resolveLocation(base: string, location: string): string | undefined {
  try {
    return new URL(location, base).toString();
  } catch {
    return undefined;
  }
}

function stripBrackets(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
