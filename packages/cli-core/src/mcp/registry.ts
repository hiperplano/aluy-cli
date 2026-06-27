// EST-0970 (search) · ADR-0058 · CLI-SEC-5/CLI-SEC-12 — BUSCA na BIBLIOTECA de MCP
// servers no REGISTRO OFICIAL ABERTO (`registry.modelcontextprotocol.io`).
//
// `aluy mcp search <query>` navega o registro PÚBLICO do Model Context Protocol e
// lista os servers que casam com a query — nome, descrição e COMO RODAR (o comando
// `npx@.../uvx/docker`). É um COMPLEMENTO de `aluy mcp add`: a busca só MOSTRA o
// comando pronto; INSTALAR é ato separado do usuário (copia/cola `aluy mcp add`).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ SEGURANÇA — o que este módulo NÃO faz (CLI-SEC-5 · CLI-SEC-4 · E-B1):       ║
// ║  • EGRESS FIXO: fala com UM endpoint só — o registro OFICIAL (host fixo,     ║
// ║    abaixo). NÃO é fetch arbitrário; o host entra explícito na egress-allowlist║
// ║    (CLI-SEC-5). O @hiperplano/aluy-cli injeta o fetch seguro (anti-SSRF, EST-0971).     ║
// ║  • SEM KEY: o registro oficial é ABERTO. NUNCA pedimos/embutimos credencial. ║
// ║  • SÓ LÊ E MOSTRA: a resposta do registro é DADO_NÃO_CONFIÁVEL (CLI-SEC-4) —  ║
// ║    NADA é executado/instalado/auto-aprovado a partir dela. O comando exibido  ║
// ║    é texto p/ o usuário copiar; quem instala é `aluy mcp add` (catraca).      ║
// ║  • DEGRADA GRACIOSO: rede fora/timeout/JSON inválido ⇒ erro legível, NUNCA    ║
// ║    lança nem derruba a CLI ("registro indisponível").                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL (ADR-0053 §8): só lógica de string/objeto (URL, parse, filtro, formato).
// O I/O de rede é a porta `RegistryFetch` injetada (ligada ao safeFetch do @hiperplano/aluy-cli).

/** Host FIXO do registro oficial aberto do MCP (CLI-SEC-5: entra na allowlist). */
export const MCP_REGISTRY_HOST = 'registry.modelcontextprotocol.io';

/** Endpoint base de listagem do registro oficial (API v0, aberta/sem key). */
export const MCP_REGISTRY_SERVERS_URL = `https://${MCP_REGISTRY_HOST}/v0/servers`;

/** Teto de páginas a paginar numa busca (anti-runaway; o registro é grande). */
const MAX_PAGES = 5;
/** Tamanho de página pedido ao registro (o `limit` da API v0). */
const PAGE_SIZE = 100;
/** Teto de resultados exibidos (evita despejar centenas na TUI). */
export const MAX_SEARCH_RESULTS = 25;

/** UMA resposta HTTP crua da porta de rede (sucesso = corpo; senão = erro legível). */
export type RegistryFetchResult =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Porta de rede da busca no registro — injetada pelo @hiperplano/aluy-cli (safeFetch pinado +
 * egress-allowlist do host FIXO). O CORE só monta a URL e interpreta o corpo; NUNCA
 * abre socket. `url` é SEMPRE derivada de `MCP_REGISTRY_SERVERS_URL` (host fixo).
 */
export interface RegistryFetch {
  /** GET na URL do registro. NUNCA lança: erro de rede ⇒ `{ ok:false, reason }`. */
  (url: string, signal?: AbortSignal): Promise<RegistryFetchResult>;
}

/** Como RODAR um server (derivado do `packages[]`/`remotes[]` do registro). */
export interface RegistryRunHint {
  /** Comando-base a executar localmente (ex.: "npx", "uvx", "docker"). undefined p/ remoto-only. */
  readonly command?: string;
  /** Argumentos do comando (ex.: ["-y", "@scope/server@1.2.3"]). */
  readonly args: readonly string[];
  /** Transporte declarado pelo registro (ex.: "stdio", "streamable-http"). */
  readonly transport?: string;
  /** Variáveis de ambiente que o server PEDE (nome + se é obrigatória). Apenas INFORMATIVO. */
  readonly env: readonly { readonly name: string; readonly required: boolean }[];
  /** URL(s) remota(s), p/ servers que só expõem HTTP/SSE (não-local, fora do v1 de `add`). */
  readonly remoteUrls: readonly string[];
}

/** UM server do registro, normalizado p/ exibição. Tudo aqui é DADO_NÃO_CONFIÁVEL. */
export interface RegistrySearchResult {
  /** Nome canônico no registro (ex.: "io.github.foo/server"). */
  readonly name: string;
  /** Título amigável, quando o registro fornece. */
  readonly title?: string;
  /** Descrição (uma linha). Pode vir vazia. */
  readonly description: string;
  /** Versão mais recente publicada. */
  readonly version?: string;
  /** Como rodar (comando local e/ou remotos). */
  readonly run: RegistryRunHint;
}

/** Resultado da busca: ou os servers casados, ou um motivo de degradação gracioso. */
export type RegistrySearchOutcome =
  | { readonly ok: true; readonly query: string; readonly results: readonly RegistrySearchResult[] }
  | { readonly ok: false; readonly query: string; readonly reason: string };

/** Monta a URL de uma página do registro (host FIXO + `search`/`limit`/`cursor`). */
export function registryPageUrl(query: string, cursor?: string): string {
  const u = new URL(MCP_REGISTRY_SERVERS_URL);
  // `search` é substring server-side (best-effort); refinamos no cliente de qualquer
  // forma (casa nome/descrição/comando) — a query NUNCA é interpolada crua na URL.
  if (query.trim().length > 0) u.searchParams.set('search', query.trim());
  u.searchParams.set('limit', String(PAGE_SIZE));
  if (cursor !== undefined && cursor.length > 0) u.searchParams.set('cursor', cursor);
  return u.toString();
}

/**
 * BUSCA no registro oficial. Pagina (com teto), normaliza cada server, FILTRA pela
 * query (nome/título/descrição/comando) e devolve até `MAX_SEARCH_RESULTS`.
 *
 * NUNCA lança: qualquer falha de rede/parse vira `{ ok:false, reason }` legível
 * (degradação graciosa — CLI-SEC-12). A `RegistryFetch` injetada já fala SÓ com o
 * host fixo (egress-allowlist, CLI-SEC-5).
 */
export async function searchRegistry(
  query: string,
  fetch: RegistryFetch,
  signal?: AbortSignal,
): Promise<RegistrySearchOutcome> {
  const q = query.trim();
  const collected: RegistrySearchResult[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = registryPageUrl(q, cursor);
    let res: RegistryFetchResult;
    try {
      res = await fetch(url, signal);
    } catch (e) {
      // A porta NÃO deveria lançar (contrato), mas blindamos: rede caiu ⇒ gracioso.
      return { ok: false, query: q, reason: registryUnavailable(errMsg(e)) };
    }
    if (!res.ok) {
      return { ok: false, query: q, reason: registryUnavailable(res.reason) };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, query: q, reason: registryUnavailable(`HTTP ${res.status}`) };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return { ok: false, query: q, reason: registryUnavailable('resposta não é JSON válido') };
    }

    const page0 = parseServersPage(parsed);
    for (const entry of page0.servers) {
      if (matchesQuery(entry, q)) collected.push(entry);
      if (collected.length >= MAX_SEARCH_RESULTS) break;
    }
    if (collected.length >= MAX_SEARCH_RESULTS) break;
    cursor = page0.nextCursor;
    if (cursor === undefined || cursor.length === 0) break;
  }

  return { ok: true, query: q, results: collected };
}

/** Mensagem única de degradação graciosa (o registro não respondeu/respondeu mal). */
function registryUnavailable(detail: string): string {
  return `registro MCP indisponível (${MCP_REGISTRY_HOST}): ${detail}`;
}

/** Casa a query (case-insensitive) contra nome/título/descrição/comando do server. */
export function matchesQuery(entry: RegistrySearchResult, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  const hay = [
    entry.name,
    entry.title ?? '',
    entry.description,
    entry.run.command ?? '',
    entry.run.args.join(' '),
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}

interface ParsedPage {
  readonly servers: readonly RegistrySearchResult[];
  readonly nextCursor?: string;
}

/**
 * Parser TOLERANTE de uma página do registro (`{ servers: [{ server, _meta }],
 * metadata: { nextCursor } }`). DADO_NÃO_CONFIÁVEL: campo ausente/torto é IGNORADO
 * (nunca lança); um item ruim não derruba a página inteira.
 */
export function parseServersPage(raw: unknown): ParsedPage {
  if (!isRecord(raw)) return { servers: [] };
  const rawServers = Array.isArray(raw['servers']) ? raw['servers'] : [];
  const servers: RegistrySearchResult[] = [];
  for (const item of rawServers) {
    const norm = normalizeServer(item);
    if (norm !== undefined) servers.push(norm);
  }
  const meta = isRecord(raw['metadata']) ? raw['metadata'] : undefined;
  const nextCursor =
    meta !== undefined && typeof meta['nextCursor'] === 'string'
      ? (meta['nextCursor'] as string)
      : undefined;
  return { servers, ...(nextCursor !== undefined ? { nextCursor } : {}) };
}

/** Normaliza UM item `{ server, _meta }` (ou um `server` cru) em `RegistrySearchResult`. */
function normalizeServer(item: unknown): RegistrySearchResult | undefined {
  if (!isRecord(item)) return undefined;
  // O item pode ser `{ server: {...}, _meta: {...} }` ou já o objeto `server`.
  const s = isRecord(item['server']) ? (item['server'] as Record<string, unknown>) : item;
  const name = typeof s['name'] === 'string' ? s['name'].trim() : '';
  if (name.length === 0) return undefined; // sem nome ⇒ inútil p/ exibir/instalar.
  const description = typeof s['description'] === 'string' ? s['description'].trim() : '';
  const title =
    typeof s['title'] === 'string' && s['title'].trim().length > 0 ? s['title'].trim() : undefined;
  const version = typeof s['version'] === 'string' ? s['version'].trim() : undefined;
  const run = deriveRunHint(s);
  return {
    name,
    description,
    run,
    ...(title !== undefined ? { title } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

/** Deriva o "como rodar" a partir de `packages[]` (local) e/ou `remotes[]` (remoto). */
function deriveRunHint(server: Record<string, unknown>): RegistryRunHint {
  const remoteUrls: string[] = [];
  const remotes = Array.isArray(server['remotes']) ? server['remotes'] : [];
  for (const r of remotes) {
    if (isRecord(r) && typeof r['url'] === 'string') remoteUrls.push(r['url']);
  }

  const packages = Array.isArray(server['packages']) ? server['packages'] : [];
  // 1º pacote LOCAL utilizável (stdio) é o que vira o comando `aluy mcp add`.
  for (const pkg of packages) {
    if (!isRecord(pkg)) continue;
    const hint = packageToRun(pkg);
    if (hint !== undefined) return { ...hint, remoteUrls };
  }
  // Sem pacote local ⇒ só remoto (não instalável via `add` v1 — stdio-only).
  return { args: [], env: [], remoteUrls };
}

/**
 * Traduz UM `package` do registro num comando local executável:
 *   npm  + npx  ⇒ `npx -y <identifier>@<version> <pkgArgs>`
 *   pypi + uvx  ⇒ `uvx <identifier> <pkgArgs>`
 *   oci         ⇒ `docker run -i --rm <identifier>:<version>`
 * Devolve `undefined` p/ pacotes sem mapeamento conhecido (deixa o remoto/cego).
 */
function packageToRun(
  pkg: Record<string, unknown>,
): Omit<RegistryRunHint, 'remoteUrls'> | undefined {
  const registryType = strOf(pkg['registryType']) ?? strOf(pkg['registry_name']);
  const identifier = strOf(pkg['identifier']) ?? strOf(pkg['name']);
  if (identifier === undefined) return undefined;
  const version = strOf(pkg['version']);
  const runtimeHint = strOf(pkg['runtimeHint']);
  const transport = isRecord(pkg['transport']) ? strOf(pkg['transport']['type']) : undefined;
  const env = parseEnvVars(pkg['environmentVariables']);
  const runtimeArgs = parseArgValues(pkg['runtimeArguments']);
  const pkgArgs = parseArgValues(pkg['packageArguments']);
  const versioned = version !== undefined ? `${identifier}@${version}` : identifier;

  if (registryType === 'npm' || runtimeHint === 'npx') {
    // `-y` (não-interativo) + os runtimeArgs declarados, depois o pacote, depois pkgArgs.
    const args = dedupeLeadingYes(['-y', ...runtimeArgs, versioned, ...pkgArgs]);
    return { command: 'npx', args, env, ...(transport !== undefined ? { transport } : {}) };
  }
  if (registryType === 'pypi' || runtimeHint === 'uvx' || runtimeHint === 'uv') {
    const args = [...runtimeArgs, identifier, ...pkgArgs];
    return { command: 'uvx', args, env, ...(transport !== undefined ? { transport } : {}) };
  }
  if (registryType === 'oci' || runtimeHint === 'docker') {
    const args = ['run', '-i', '--rm', ...runtimeArgs, versioned, ...pkgArgs];
    return { command: 'docker', args, env, ...(transport !== undefined ? { transport } : {}) };
  }
  // Tipo desconhecido: ainda mostramos o identificador, sem inventar runtime.
  return { args: [versioned], env, ...(transport !== undefined ? { transport } : {}) };
}

/** Evita um `-y` duplicado se o registro já declarou `-y` nos runtimeArguments. */
function dedupeLeadingYes(args: readonly string[]): readonly string[] {
  const out: string[] = [];
  let sawYes = false;
  for (const a of args) {
    if (a === '-y' || a === '--yes') {
      if (sawYes) continue;
      sawYes = true;
    }
    out.push(a);
  }
  return out;
}

/** Extrai os `value` de um array de argumentos (`[{ value, type }]`). Ignora o resto. */
function parseArgValues(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const a of raw) {
    if (isRecord(a) && typeof a['value'] === 'string') out.push(a['value']);
  }
  return out;
}

/** Extrai as env vars que o server PEDE (`[{ name, isRequired }]`). Apenas informativo. */
function parseEnvVars(raw: unknown): readonly { name: string; required: boolean }[] {
  if (!Array.isArray(raw)) return [];
  const out: { name: string; required: boolean }[] = [];
  for (const e of raw) {
    if (isRecord(e) && typeof e['name'] === 'string' && e['name'].length > 0) {
      out.push({ name: e['name'], required: e['isRequired'] === true });
    }
  }
  return out;
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
