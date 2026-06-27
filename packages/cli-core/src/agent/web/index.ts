// EST-0971 · CLI-SEC-13 — barrel das tools de WEB + anti-SSRF.
//
// PORTÁVEL (ADR-0053 §8): toda a lógica anti-SSRF (resolve→valida→pina, denylist
// dura de IP, canonicalização de IP-literal) é dado/string puro, testável no core
// com resolver/fetcher MOCK. A rede CONCRETA (DNS + socket pinado) é a `WebPort`
// injetada pelo @hiperplano/aluy-cli.
export {
  classifyIp,
  isLoopbackIp,
  validateResolvedIps,
  canonicalizeIpv4,
  ipv4MappedFromV6,
  looksLikeIpv6,
  type IpClassification,
} from './ssrf.js';
// EST-1075 · HR-SEC-1/2 (ADR-0102) — destino loopback-only do headroom.
export { classifyHeadroomTarget, type HeadroomTargetResult } from './headroom-target.js';
export {
  safeFetch,
  parseHttpUrl,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_OBSERVATION_CHARS,
  MIN_MAX_OBSERVATION_CHARS,
  MAX_OBSERVATION_CHARS_CEILING,
  resolveMaxObservationChars,
  type HostResolver,
  type PinnedFetcher,
  type PinnedFetchArgs,
  type PinnedResponse,
  type SafeFetchResult,
  type SafeFetcherPorts,
  type SafeFetchRequest,
  type WebFetchPolicy,
} from './fetcher.js';
export {
  buildDdgSearchUrl,
  buildDdgSearchBody,
  parseDdgResults,
  unwrapDdgRedirect,
  DDG_HTML_ENDPOINT,
  DDG_SEARCH_CONTENT_TYPE,
  type SearchResult,
} from './ddg.js';
export type { WebPort, EgressGuard, EgressDecision } from './web-port.js';
export {
  WEB_TOOLS,
  webFetchTool,
  webSearchTool,
  capObservationBody,
  type WebToolPorts,
} from './web-tools.js';
