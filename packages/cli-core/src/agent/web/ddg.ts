// EST-0971 · CLI-SEC-13 — DuckDuckGo (endpoint GRATUITO, SEM chave) + parser.
//
// `web_search` busca na web SEM chave de API: usa o endpoint HTML do DuckDuckGo
// `html.duckduckgo.com/html/?q=…` (scraping leve dos resultados). Não há provider
// embutido nem credencial (CLI-SEC-7: binário público limpo) — é HTTP puro a um
// host público, que PASSA pela mesma malha anti-SSRF do `web_fetch` (o host do DDG
// resolve e é validado como público; se um dia resolvesse interno, seria barrado).
//
// PORTÁVEL: só montagem de URL + parsing de string (sem rede aqui). A rede é o
// MESMO `safeFetch` (fetcher.ts) — a busca é um fetch ao DDG + parse dos links.
//
// CLI-SEC-6 (E-C3): a QUERY é redigida (redactCommandSecrets) ANTES de virar URL
// — isso é feito na TOOL (web-tools.ts), não aqui; aqui a query já chega limpa.
// CLI-SEC-4 (E-C2): os snippets dos resultados são DADO não-confiável; a tool os
// devolve como observação envelopada e NÃO auto-busca as URLs encontradas.

/** O endpoint HTML gratuito do DuckDuckGo (sem chave). */
export const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';

/** Um resultado de busca: título + URL + snippet. Tudo é DADO não-confiável. */
export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * Monta a URL de busca do DDG a partir de uma query JÁ REDIGIDA (CLI-SEC-6 aplicado
 * pelo caller). Encoda a query. Não embute chave nenhuma.
 *
 * EST-0971 (fix): a query também vai no CORPO POST (buildDdgSearchBody) — o endpoint
 * `/html/` do DDG só devolve resultados via POST form-encoded (um GET cai numa
 * página-desafio 202 sem resultados). A URL mantém o `?q=` p/ a checagem de egress
 * (host) e como fallback; o corpo é o que rende os resultados.
 */
export function buildDdgSearchUrl(redactedQuery: string): string {
  const u = new URL(DDG_HTML_ENDPOINT);
  u.searchParams.set('q', redactedQuery);
  return u.toString();
}

/** Content-Type do POST de busca do DDG (form-encoded). */
export const DDG_SEARCH_CONTENT_TYPE = 'application/x-www-form-urlencoded';

/**
 * Monta o CORPO POST form-encoded da busca do DDG a partir da query JÁ REDIGIDA.
 * `b=` vazio desliga o anúncio/bang; sem chave nenhuma (CLI-SEC-7).
 */
export function buildDdgSearchBody(redactedQuery: string): string {
  const p = new URLSearchParams();
  p.set('q', redactedQuery);
  p.set('b', ''); // sem !bang/anúncio
  return p.toString();
}

/**
 * Parseia os resultados do HTML do DDG (`html.duckduckgo.com/html/`). O HTML lista
 * cada resultado num `<a class="result__a" href="…">título</a>` e um
 * `<a class="result__snippet">…</a>`. O href do DDG vem como redirect
 * `//duckduckgo.com/l/?uddg=<URL-encodada>` — DESEMBRULHAMOS p/ a URL real (e ela
 * RE-PASSA o egress + anti-SSRF se o usuário pedir p/ buscá-la; NÃO auto-buscamos).
 *
 * Robusto a HTML imperfeito: regex tolerante (não é um parser DOM — portável, sem
 * dep). Limita ao `max` (default 10) resultados. Fail-soft: o que não parsear é
 * ignorado, não lança.
 */
export function parseDdgResults(html: string, max = 10): SearchResult[] {
  const results: SearchResult[] = [];
  // Cada bloco de resultado começa num `result__a`. Capturamos href + texto.
  const anchorRe =
    /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  // snippets na ordem (alinhamos por índice — best-effort).
  const snippetRe = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(decodeEntities(sm[1] ?? '')).trim());
  }

  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = anchorRe.exec(html)) !== null && results.length < max) {
    const href = unwrapDdgRedirect(decodeEntities(m[1] ?? ''));
    const title = stripTags(decodeEntities(m[2] ?? '')).trim();
    if (!href || !title) {
      i++;
      continue;
    }
    results.push({
      title,
      url: href,
      snippet: snippets[i] ?? '',
    });
    i++;
  }
  return results;
}

/**
 * Desembrulha o redirect do DDG (`/l/?uddg=<encoded>` ou
 * `//duckduckgo.com/l/?uddg=…`) p/ a URL de destino real. Se não é um redirect do
 * DDG, devolve o href como veio (normalizando `//host` ⇒ `https://host`).
 */
export function unwrapDdgRedirect(href: string): string {
  let h = href.trim();
  if (h.startsWith('//')) h = 'https:' + h;
  try {
    const u = new URL(h, 'https://duckduckgo.com');
    if (u.pathname === '/l/' && u.searchParams.has('uddg')) {
      return u.searchParams.get('uddg') ?? '';
    }
    // links absolutos diretos (sem redirect) — devolve normalizado.
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    return '';
  } catch {
    return '';
  }
}

/** Remove tags HTML (deixa o texto). Best-effort p/ título/snippet. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

/** Decodifica as entidades HTML mais comuns (sem dep — portável). */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ');
}
