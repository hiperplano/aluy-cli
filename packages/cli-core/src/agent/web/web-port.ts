// EST-0971 · CLI-SEC-13 — a PORTA de rede do agente (web_fetch/web_search).
//
// As tools `web_fetch`/`web_search` são CÓDIGO portável (cli-core); a rede CONCRETA
// (DNS real + socket pinado) é injetada por esta porta, ligada no @aluy/cli. Fecha
// a fronteira do §8: a lógica anti-SSRF (resolve→valida→pina) é testável no core
// com mocks; o I/O de rede mora no locus.
//
// A porta agrega: o resolver + o fetcher pinado (que o `safeFetch` usa) + a POLÍTICA
// de tetos (bytes/timeout/redirects, CLI-SEC-8/13) + a EGRESS-ALLOWLIST (CLI-SEC-5:
// o host do destino tem de estar na allowlist; fora ⇒ a tool devolve bloqueio com a
// URL exata — coerente com o `ask`/deny que a catraca já força p/ a categoria rede).

import type { SafeFetcherPorts, WebFetchPolicy } from './fetcher.js';

/**
 * Decisão de egress p/ um host (CLI-SEC-5). O locus liga isto à `EgressAllowlist`
 * concreta (@aluy/cli). DEFAULT-DENY: host fora da allowlist ⇒ `allowed:false`.
 * NUNCA libera faixa interna (a allowlist abre domínios públicos; a denylist de IP
 * do anti-SSRF é independente e inviolável).
 */
export interface EgressDecision {
  readonly allowed: boolean;
  /** Host normalizado avaliado (p/ a mensagem exata). */
  readonly host: string;
}

/** Verifica se um host de destino está na egress-allowlist (CLI-SEC-5). */
export interface EgressGuard {
  /** `true` se o host (de uma URL) pode receber egress. Default-deny. */
  checkHost(host: string): EgressDecision;
}

/**
 * Conjunto de portas que as tools de WEB precisam: o fetch seguro (resolver +
 * fetcher pinado), a guarda de egress e a política de tetos. OPCIONAL em
 * `ToolPorts`: sem `web` injetado, `web_fetch`/`web_search` devolvem erro claro
 * (não há rede) — o resto do agente segue idêntico (não-regressão).
 */
export interface WebPort {
  readonly safe: SafeFetcherPorts;
  readonly egress: EgressGuard;
  readonly policy?: WebFetchPolicy;
}
