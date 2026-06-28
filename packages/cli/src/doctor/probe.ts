// EST-0970 — PROBE do `/doctor`: a camada de I/O que COLETA os fatos (keychain,
// broker, filesystem, env) p/ a camada PURA `checks.ts` mapear em ✓/⚠/✗. É o único
// ponto que toca o mundo — e cada gatherer é INDEPENDENTE e BLINDADO (try/catch):
// um falhar vira um fato "indisponível", NUNCA derruba os outros nem lança.
//
// READ-ONLY (DoD): NÃO conserta nada, só diagnostica. NÃO gasta modelo. O ÚNICO
// egress é o ping leve do broker em `/healthz` (endpoint EXEMPT de auth no broker —
// sem credencial, sem corpo de modelo) + os probes `/v1/tiers/catalog` e
// `/v1/models/custom` (GET autenticado, sem inferência). Nada disso chama o modelo.
//
// TESTABILIDADE (DoD frugal, sem modelo): cada gatherer é uma função INJETÁVEL em
// `DoctorProbeDeps`. Os testes substituem os gatherers por fakes puros (auth presente/
// ausente, broker 200/401/timeout, mcp válido/`--`, perfil .md válido/rejeitado, config
// ok/corrompido) e exercem o mapeamento — sem keychain/rede/fs reais.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import {
  LoginService,
  resolveMaxTokens,
  resolveMaxIterations,
  buildMcpListing,
  invalidCommandWarning,
  mergeMcpConfigs,
  discoverMcpTools,
  EMPTY_MCP_CONFIG,
  parseMcpConfig,
  McpConfigError,
  resolveSidecarToggles,
  resolveBackend,
  type RedactedCredential,
  type McpConfig,
  type McpServerConfig,
  type McpSource,
  type McpTransport,
  type McpDiscoveryResult,
  type StreamFetch,
} from '@hiperplano/aluy-cli-core';
import { themeByName } from '../ui/theme/themes.js';
import {
  resolveMem0Url,
  resolveOllamaUrl,
  resolveHeadroomProbeUrl,
} from '../maestro/sidecar-urls.js';
import { resolveTierKey } from '../model/catalog.js';
import { loadAuthConfig } from '../auth/config.js';
import { KeychainCredentialStore, NoKeychainError } from '../auth/keychain-store.js';
import { loadBrokerConfig } from '../model/config.js';
import { McpConfigStore } from '../mcp/mcp-config-store.js';
import { CodexMcpConfigStore } from '../mcp/codex-mcp-config.js';
import { PROJECT_MCP_CONFIG_FILENAME } from '../mcp/project-mcp-config.js';
import { UserAgentsLoader } from '../io/user-agents.js';
import { CONFIG_FILENAME, UserConfigStore, type UserServicesConfig } from '../io/user-config.js';
import { CLI_VERSION } from '../version.js';
import type {
  AuthFact,
  BrokerFact,
  CatalogFact,
  ConfigFact,
  DoctorFacts,
  AgentsFact,
  MaestroFact,
  McpFact,
  McpServerFact,
  MemoryFact,
  ProbeFact,
  SidecarsFact,
  TierFact,
  VersionFact,
} from './checks.js';
import { resolveMaestro } from '../maestro/wiring.js';

/** Caminho do healthz do broker (EXEMPT de auth no broker — ping sem credencial). */
const HEALTHZ_PATH = '/healthz';
const TIERS_PATH = '/v1/tiers/catalog';
const CUSTOM_PATH = '/v1/models/custom';
/** EST-0970 (validação ATIVA) — toque LEVE que EXIGE auth mas NÃO gasta modelo (#123, GET). */
const QUOTA_PATH = '/v1/quota';

/** Timeout curto do ping (ms): o doctor não pode travar esperando um broker fora. */
const PROBE_TIMEOUT_MS = 4000;

/** Timeout curto por server MCP no handshake — degrada (não trava o doctor). */
const MCP_CONNECT_TIMEOUT_MS = 6000;

/** Timeout GLOBAL da coleta MCP inteira (spawn + connect + list tools). Se o
 *  `discoverMcpTools` não resolver em 15s, o probe MCP DEGRADA (vira `servers:[]`)
 *  em vez de travar o `/doctor` pra sempre no "testando…". O teto é generoso
 *  (um server lento + cleanup) mas impede o pior caso: processo zumbi que nunca
 *  fecha. Corrige o bug real reportado no dogfooding (playwright com browser
 *  aberto pendurando a checklist). */
const MCP_GLOBAL_TIMEOUT_MS = 15_000;

/**
 * Timeout do `close()` no cleanup do probe MCP. Um server que não fecha limpo (ex.:
 * playwright com browser aberto) NÃO pode pendurar o /doctor pra sempre — estourou,
 * segue (processo vira órfão, melhor que travar o diagnóstico em "testando…").
 */
const MCP_CLOSE_TIMEOUT_MS = 2000;

/** Teto defensivo de tamanho do `.mcp.json` de projeto (espelha `aluy mcp list`). */
const MAX_MCP_BYTES = 256 * 1024;

/**
 * Provedor de contagem de memória — só o NÚMERO de fatos (DoD: "só conta, não
 * despeja"). Injetado pelo wiring (`AgentMemory.list().length`) p/ a sessão; o shell
 * passa o leitor de store direto. `null` ⇒ store ilegível (vira ✗).
 */
export interface MemoryCounter {
  count(): Promise<number | null>;
}

/** Dependências do probe — cada gatherer é injetável p/ teste (sem I/O real). */
export interface DoctorProbeDeps {
  readonly env?: NodeJS.ProcessEnv;
  /** Raiz do `~/.aluy/` (default `<home>/.aluy`) — injetável p/ tmpdir em teste. */
  readonly aluyHome?: string;
  /** Raiz do workspace (cwd) — p/ ler o `.mcp.json` de projeto. */
  readonly workspaceRoot?: string;
  /** `fetch` injetável p/ os probes HTTP (default: global, com timeout). */
  readonly fetch?: StreamFetch;
  /** Token de acesso p/ os probes autenticados (catálogo/custom). Ausente ⇒ pulamos auth. */
  readonly getAccessToken?: () => Promise<string>;
  /** Contagem de memória (sessão injeta a `AgentMemory`; shell injeta o store). */
  readonly memory?: MemoryCounter;
  /** Flags efetivas adicionais a exibir (sessão passa `--yolo`/modo; shell deriva do env). */
  readonly extraFlags?: readonly string[];

  /**
   * EST-0970 (validação ATIVA do MCP) — fábrica de transport p/ CONECTAR de verdade cada
   * server (handshake real, conta as tools). Presente ⇒ o `gatherMcp` faz o handshake
   * (timeout curto por server, degrada). Ausente ⇒ só LÊ a config (sem regressão #120):
   * o `/doctor`/`aluy doctor` injeta o `StdioMcpTransport`; o teste injeta um mock.
   */
  readonly makeMcpTransport?: (server: McpServerConfig) => McpTransport;

  /**
   * EST-0970 (--deep / opt-in que GASTA modelo) — testador do tier ao vivo: manda 1 token
   * mínimo ao modelo e devolve se RESPONDEU. SÓ chamado quando presente (o caller só o
   * injeta sob `--deep`/`--test`). Ausente ⇒ `facts.tier` undefined (o default NÃO chama
   * o modelo). O teste injeta um fake (sem broker real).
   */
  readonly tierTester?: () => Promise<TierFact>;

  /**
   * EST-0970 (ticks AO VIVO) — callback chamado com CADA fato assim que ele resolve (a
   * checklist "acende" um a um). Recebe o `id` do check + os fatos parciais até então.
   * Opcional: o relatório final é idêntico com ou sem ele (puro além do efeito de UI).
   */
  readonly onCheck?: (id: string, facts: Partial<DoctorFacts>) => void;

  // Overrides COMPLETOS de gatherer (testes substituem o fato inteiro):
  readonly gatherAuth?: () => Promise<AuthFact>;
  readonly gatherBroker?: () => Promise<BrokerFact>;
  readonly gatherCatalog?: () => Promise<CatalogFact>;
  readonly gatherMcp?: () => Promise<McpFact>;
  readonly gatherAgents?: () => Promise<AgentsFact>;
  readonly gatherConfig?: () => Promise<ConfigFact>;
  readonly gatherMemory?: () => Promise<MemoryFact>;
  readonly gatherSidecars?: () => Promise<SidecarsFact>;
  readonly gatherMaestro?: () => Promise<MaestroFact>;
}

function aluyHomeOf(deps: DoctorProbeDeps): string {
  return deps.aluyHome ?? join(homedir(), '.aluy');
}

// ── #1 credencial/auth (reusa o whoami do #82) + validação ATIVA via GET ──────
async function gatherAuth(deps: DoctorProbeDeps): Promise<AuthFact> {
  const env = deps.env ?? process.env;
  try {
    const cfg = loadAuthConfig(env);
    const store = new KeychainCredentialStore();
    const service = new LoginService({ ...cfg, baseUrl: cfg.identityBaseUrl, store });
    const cred: RedactedCredential | null = await service.whoami();
    if (!cred) return { present: false, keychainAvailable: true };
    const base: AuthFact = {
      present: true,
      keychainAvailable: true,
      ...(cred.user !== undefined ? { user: cred.user } : {}),
      org: cred.organization_id,
      kind: cred.kind,
    };
    // EST-0970 (validação ATIVA) — toque LEVE no broker que EXIGE auth mas NÃO gasta
    // modelo: `GET /v1/quota` com o PAT da sessão (200 ⇒ credencial BOA; 401/403 ⇒
    // RECUSADA). GET SEM body (#123). Degrada: broker fora / sem token ⇒ authValidated
    // fica `undefined` (NÃO inventa ✗ por não ter alcançado o broker).
    const validation = await validateAuth(deps);
    return { ...base, ...validation };
  } catch (err) {
    if (err instanceof NoKeychainError) {
      return { present: false, keychainAvailable: false };
    }
    // Qualquer outro erro de leitura ⇒ tratamos como "sem credencial" (fail-safe);
    // o keychain respondeu (não é NoKeychainError), só não havia credencial legível.
    return { present: false, keychainAvailable: true };
  }
}

/**
 * Toque LEVE de validação da credencial: `GET /v1/quota` autenticado (o endpoint exige
 * auth e NÃO gasta modelo). 200 ⇒ `authValidated:true`; 401/403 ⇒ `authValidated:false`
 * (broker recusou o PAT). Sem token / broker fora / outro status ⇒ `{}` (não-validado,
 * degrada: a credencial está presente mas não dá p/ provar agora — nunca ✗ por isso).
 */
export async function validateAuth(
  deps: DoctorProbeDeps,
): Promise<{ authValidated?: boolean; authStatus?: number }> {
  if (!deps.getAccessToken) return {};
  const env = deps.env ?? process.env;
  const { brokerBaseUrl } = loadBrokerConfig(env);
  let token: string;
  try {
    token = await deps.getAccessToken();
  } catch {
    return {}; // sem token resolvível ⇒ não-validado (degrada).
  }
  const probe = await httpProbe(`${brokerBaseUrl}${QUOTA_PATH}`, resolveFetch(deps), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!probe.reached || probe.status === undefined) return {}; // broker fora ⇒ não-validado.
  if (probe.status >= 200 && probe.status < 300) {
    return { authValidated: true, authStatus: probe.status };
  }
  if (probe.status === 401 || probe.status === 403) {
    return { authValidated: false, authStatus: probe.status };
  }
  return { authStatus: probe.status }; // outro status (5xx) ⇒ não-validado (não ✗).
}

/**
 * Monta o `init` de um GET p/ o `doFetch` injetado. ⚠ NUNCA enviamos `body` num GET:
 * o `fetch` REAL do Node LANÇA `"Request with GET/HEAD method cannot have body"` se o
 * campo `body` existir (mesmo `''`). O tipo `StreamFetch` (do cliente de STREAMING do
 * broker) exige `body: string`, então construímos o objeto SEM `body` e casamos via
 * `unknown` — o probe é GET puro, sem corpo. O fake de teste ignora `init` extra.
 */
function getInit(
  signal: AbortSignal,
  headers?: Record<string, string>,
): Parameters<StreamFetch>[1] {
  return {
    method: 'GET',
    headers: { accept: 'application/json', ...(headers ?? {}) },
    signal,
  } as unknown as Parameters<StreamFetch>[1];
}

// ── ping HTTP leve (com timeout) ─────────────────────────────────────────────
async function httpProbe(
  url: string,
  doFetch: StreamFetch,
  init?: { headers?: Record<string, string> },
): Promise<ProbeFact> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await doFetch(url, getInit(controller.signal, init?.headers));
    return { reached: true, status: res.status };
  } catch {
    // timeout/abort/transporte/DNS ⇒ servidor inalcançável.
    return { reached: false };
  } finally {
    clearTimeout(timer);
  }
}

function resolveFetch(deps: DoctorProbeDeps): StreamFetch {
  return deps.fetch ?? (globalThis.fetch as unknown as StreamFetch);
}

// ADR-0120 (BYO) — backend local: o modelo NÃO passa pelo broker ⇒ os probes de
// broker/catálogo são pulados e o check vira N/A (não ✗ falso). EST-1133-bis.
//
// FIX: resolve o backend EFETIVO pela precedência real (env `ALUY_BACKEND` > config
// `~/.aluy/config.json` `backend` > default). Antes só olhava a env — então o usuário
// público (backend=local por CONFIG/default, sem env) tinha o broker probado e marcado ✗
// "inalcançável" (falso-negativo). Agora o config/default também contam.
function isLocalBackend(deps: DoctorProbeDeps): boolean {
  const env = deps.env ?? process.env;
  let configBackend: string | undefined;
  try {
    configBackend = new UserConfigStore({ baseDir: aluyHomeOf(deps) }).load().backend;
  } catch {
    /* config ausente/corrompido ⇒ ignora (cai no default do resolveBackend). */
  }
  return resolveBackend({ env: env.ALUY_BACKEND, config: configBackend }) === 'local';
}

// ── #2 broker — ping leve em /healthz (sem auth, sem gasto de modelo) ─────────
async function gatherBroker(deps: DoctorProbeDeps): Promise<BrokerFact> {
  const env = deps.env ?? process.env;
  const { brokerBaseUrl } = loadBrokerConfig(env);
  // Backend local ⇒ não pinga o broker (não é usado); marca N/A.
  if (isLocalBackend(deps)) {
    return { url: brokerBaseUrl, probe: { reached: false }, localSkip: true };
  }
  const probe = await httpProbe(`${brokerBaseUrl}${HEALTHZ_PATH}`, resolveFetch(deps));
  return { url: brokerBaseUrl, probe };
}

// ── #3 catálogo de tiers + modelos custom ────────────────────────────────────
async function gatherCatalog(deps: DoctorProbeDeps): Promise<CatalogFact> {
  const env = deps.env ?? process.env;
  // Backend local ⇒ o catálogo do broker não se aplica; marca N/A.
  if (isLocalBackend(deps)) {
    return { tiers: { reached: false }, custom: { reached: false }, localSkip: true };
  }
  const { brokerBaseUrl } = loadBrokerConfig(env);
  const doFetch = resolveFetch(deps);

  // Token best-effort: sem login pleno (ou sem `getAccessToken`) os GETs darão 401 —
  // exatamente o caso que o doctor reporta como ⚠ "fallback" (NUNCA ✗). Não falha aqui.
  let headers: Record<string, string> | undefined;
  if (deps.getAccessToken) {
    try {
      const token = await deps.getAccessToken();
      headers = { authorization: `Bearer ${token}` };
    } catch {
      headers = undefined; // sem token ⇒ probe anônimo (provavelmente 401 ⇒ ⚠).
    }
  }

  // Os dois probes são INDEPENDENTES ⇒ em paralelo (não somar os timeouts quando o
  // broker está fora). Ambos GET puro (sem corpo — ver `getInit`).
  const [tiers, customRes] = await Promise.all([
    httpProbe(`${brokerBaseUrl}${TIERS_PATH}`, doFetch, headers ? { headers } : {}),
    probeCustom(`${brokerBaseUrl}${CUSTOM_PATH}`, doFetch, headers),
  ]);
  return {
    tiers,
    custom: customRes.probe,
    ...(customRes.count !== undefined ? { customCount: customRes.count } : {}),
  };
}

/** Probe do `/v1/models/custom` que TAMBÉM conta os modelos quando 200. */
async function probeCustom(
  url: string,
  doFetch: StreamFetch,
  headers?: Record<string, string>,
): Promise<{ probe: ProbeFact; count?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await doFetch(url, getInit(controller.signal, headers));
    if (res.status < 200 || res.status >= 300) {
      return { probe: { reached: true, status: res.status } };
    }
    let count: number | undefined;
    try {
      const body: unknown = await res.json();
      const data = (body as { data?: unknown } | null)?.data;
      if (Array.isArray(data)) count = data.length;
    } catch {
      count = undefined; // corpo ilegível — segue 2xx sem contagem.
    }
    return {
      probe: { reached: true, status: res.status },
      ...(count !== undefined ? { count } : {}),
    };
  } catch {
    return { probe: { reached: false } };
  } finally {
    clearTimeout(timer);
  }
}

// ── #4 MCP — lê ~/.aluy/mcp.json + .mcp.json (+ Codex) e CONECTA de verdade ────
async function gatherMcp(deps: DoctorProbeDeps): Promise<McpFact> {
  const home = aluyHomeOf(deps);
  const root = deps.workspaceRoot ?? process.cwd();
  const codex = new CodexMcpConfigStore({ baseDir: codexHomeOf(deps) }).load();
  const global = new McpConfigStore({ baseDir: home }).load();
  const project = readProjectMcp(root);

  const configErrors = [codex.error, global.error, project.error].filter(
    (e): e is string => typeof e === 'string' && e.length > 0,
  );
  const sources: McpSource[] = [
    { origin: 'codex', config: codex.config },
    { origin: 'aluy-global', config: global.config },
    { origin: 'project', config: project.config },
  ];
  const listing = buildMcpListing(sources);

  // EST-0970 (validação ATIVA) — quando há fábrica de transport injetada, CONECTA de
  // verdade cada server ATIVO (handshake real → conta as tools). Reusa o MESMO
  // `discoverMcpTools` do boot (fail-soft: um server que não sobe vira `ok:false` com o
  // erro, sem derrubar os outros). Timeout curto por server. Sem fábrica (ou só com
  // servers inválidos/desativados) ⇒ pula a conexão (só leitura — comportamento #120).
  const conn = deps.makeMcpTransport ? await connectMcp(sources, deps.makeMcpTransport) : undefined;

  const servers: McpServerFact[] = listing.map((s) => {
    const warning = invalidCommandWarning(s);
    const invalid = warning !== undefined;
    const disabled = s.state.kind === 'disabled';
    const result = conn?.get(s.name);
    return {
      name: s.name,
      origin: s.origin,
      invalid,
      ...(invalid ? { invalidWarning: warning } : {}),
      disabled,
      // Só anexa o resultado da conexão a servers que de fato TENTAMOS conectar
      // (ativos e válidos). Inválido/desativado ⇒ sem `connected` (não tentado).
      ...(result && !invalid && !disabled
        ? {
            connected: result.ok,
            ...(result.ok
              ? { toolCount: result.toolCount ?? 0 }
              : { connectError: result.error ?? 'falha no handshake' }),
          }
        : {}),
    };
  });
  return { servers, configErrors };
}

/**
 * Conecta de verdade a cada server ATIVO via `discoverMcpTools` (handshake real, conta
 * as tools), com TIMEOUT curto por server (degrada — um server lento não trava o doctor).
 * Devolve um mapa `nome → { ok, toolCount | error }`. Fecha os transports no fim (cleanup)
 * EM TODOS os caminhos de saída — inclusive quando o timeout GLOBAL vence a corrida: nesse
 * caso a descoberta segue viva em background e o cleanup é DEFERIDO sobre ela (HUNT-MCP),
 * p/ não orfanar os servers que já tinham spawnado. NUNCA lança (fail-soft).
 */
async function connectMcp(
  sources: readonly McpSource[],
  makeTransport: (server: McpServerConfig) => McpTransport,
): Promise<Map<string, { ok: boolean; toolCount?: number; error?: string }>> {
  // Mescla na MESMA ordem de precedência do boot (Codex < global < projeto).
  const merged: McpConfig = mergeMcpConfigs(...sources.map((s) => s.config));
  // Envolve cada transport num timeout por server: um `connect()` que demora além do
  // teto vira um erro (o discovery o registra como `ok:false`, fail-soft).
  const guarded = (server: McpServerConfig): McpTransport =>
    withConnectTimeout(makeTransport(server), MCP_CONNECT_TIMEOUT_MS);

  // A descoberta REAL — guardada numa variável p/ NÃO ser abandonada quando o timeout
  // GLOBAL vence a corrida (ver o `catch`): mesmo que o /doctor desista de esperar, os
  // processos que ela JÁ spawnou precisam ser fechados quando ela enfim resolver.
  const discoveryPromise = discoverMcpTools(merged, guarded);
  let discovery: McpDiscoveryResult;
  try {
    // Timeout GLOBAL: o `discoverMcpTools` não pode travar o /doctor pra sempre.
    // Se o spawn de algum server (ex.: playwright) nunca responder, o teto de 15s
    // corta e degrada o MCP (sem servers) em vez de pendurar a checklist.
    discovery = await Promise.race([
      discoveryPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`timeout global de ${Math.round(MCP_GLOBAL_TIMEOUT_MS / 1000)}s`)),
          MCP_GLOBAL_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch {
    // HUNT-MCP — VAZAMENTO no timeout GLOBAL: a descoberta segue VIVA em background, e os
    // servers que ela já spawnou (handshake concluído) virariam processos ÓRFÃOS se
    // simplesmente retornássemos — o cleanup abaixo só rodava quando a descoberta VENCIA a
    // corrida. Aqui anexamos o MESMO cleanup à promessa abandonada: quando ela resolver
    // (cada `connect` tem teto por-server), fechamos os transports que subiram. Não
    // esperamos por isso (o /doctor já degradou); só garantimos que nada fica spawnado.
    void discoveryPromise.then(
      (late) => closeDiscoveredTransports(late.transports),
      () => {
        /* discovery é fail-soft interno — não deveria rejeitar; nada a fechar */
      },
    );
    return new Map(); // degrada: MCP sem servers (não trava o diagnóstico).
  }
  const out = new Map<string, { ok: boolean; toolCount?: number; error?: string }>();
  for (const s of discovery.servers) {
    out.set(
      s.server,
      s.ok
        ? { ok: true, toolCount: s.tools.length }
        : { ok: false, error: s.error ?? 'falha no handshake' },
    );
  }
  await closeDiscoveredTransports(discovery.transports);
  return out;
}

/**
 * Cleanup best-effort COM TIMEOUT dos transports que a descoberta subiu. O `close()` NÃO
 * pode PENDURAR o /doctor — um server que não fecha limpo (ex.: playwright com browser
 * aberto) travaria pra sempre. Cada close corre contra um teto curto; estourou ⇒ segue (o
 * processo vira órfão, melhor que pendurar). Extraído p/ ser chamado em AMBOS os caminhos
 * de saída: a descoberta vencendo a corrida (cleanup síncrono) E o timeout GLOBAL vencendo
 * (cleanup DEFERIDO sobre a promessa abandonada — senão os servers spawnados vazariam).
 */
async function closeDiscoveredTransports(transports: readonly McpTransport[]): Promise<void> {
  await Promise.all(
    transports.map(async (t) => {
      try {
        await Promise.race([
          t.close(),
          new Promise<void>((resolve) => setTimeout(resolve, MCP_CLOSE_TIMEOUT_MS)),
        ]);
      } catch {
        /* cleanup best-effort */
      }
    }),
  );
}

/**
 * Decora um `McpTransport` aplicando um TIMEOUT só ao `connect()` (o handshake). Se o
 * server não responder no teto, `connect` rejeita com uma mensagem clara — o discovery
 * a registra como `ok:false` (fail-soft) e segue p/ os outros. `callTool`/`close`
 * passam direto (o doctor só usa `connect`).
 */
function withConnectTimeout(inner: McpTransport, timeoutMs: number): McpTransport {
  return {
    async connect(server) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout de ${Math.round(timeoutMs / 1000)}s no handshake`)),
          timeoutMs,
        );
      });
      try {
        return await Promise.race([inner.connect(server), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    callTool: (name, input) => inner.callTool(name, input),
    close: () => inner.close(),
  };
}

function codexHomeOf(deps: DoctorProbeDeps): string {
  const env = deps.env ?? process.env;
  return env.CODEX_HOME ?? join(homedir(), '.codex');
}

/** Lê `<root>/.mcp.json` direto (fail-safe), só p/ a listagem (espelha `aluy mcp list`). */
function readProjectMcp(root: string): { config: McpConfig; error?: string } {
  const file = join(root, PROJECT_MCP_CONFIG_FILENAME);
  let raw: string;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_MCP_BYTES) return { config: EMPTY_MCP_CONFIG };
    raw = readFileSync(file, 'utf8');
  } catch {
    return { config: EMPTY_MCP_CONFIG };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: EMPTY_MCP_CONFIG, error: `${file}: JSON inválido.` };
  }
  try {
    return { config: parseMcpConfig(parsed) };
  } catch (e) {
    return { config: EMPTY_MCP_CONFIG, error: e instanceof McpConfigError ? e.message : String(e) };
  }
}

// ── #5 perfis de agente (.md) — válidos + rejeitados (RES-MD-3) ───────────────
function gatherAgents(deps: DoctorProbeDeps): AgentsFact {
  // Globais (`~/.aluy/agents/*.md`) — o caminho confinado e injetável (tmpdir em teste).
  // Os de PROJETO (`.claude/agents/*.md`) precisam do WorkspacePort; o doctor read-only
  // usa só o loader GLOBAL (suficiente p/ o caso que o Tiago viu — "saudador/somador" em
  // `~/.aluy/agents`). Projeto fica de fora p/ não montar o WorkspacePort completo aqui.
  const loader = new UserAgentsLoader({ baseDir: aluyHomeOf(deps) });
  const res = loader.load();
  return {
    validCount: res.profiles.length,
    rejected: res.errors.map((e) => ({ file: e.file, reason: e.reason })),
  };
}

// ── #6 config — ~/.aluy/config.json + limites/flags efetivos ──────────────────
function gatherConfig(deps: DoctorProbeDeps): ConfigFact {
  const env = deps.env ?? process.env;
  const file = join(aluyHomeOf(deps), CONFIG_FILENAME);
  let exists = false;
  let corrupted = false;
  let theme: string | undefined;
  let tier: string | undefined;
  try {
    const st = statSync(file);
    if (st.isFile()) {
      exists = true;
      const raw = readFileSync(file, 'utf8');
      try {
        const parsed = JSON.parse(raw) as { theme?: unknown; tier?: unknown };
        if (typeof parsed.theme === 'string') theme = parsed.theme;
        if (typeof parsed.tier === 'string') tier = parsed.tier;
      } catch {
        corrupted = true; // existe-mas-JSON-inválido ⇒ ✗ (config corrompido).
      }
    }
  } catch {
    exists = false; // ausente (1ª execução) ⇒ defaults, NÃO é erro.
  }

  const maxTokens = resolveMaxTokens(undefined, env.ALUY_MAX_TOKENS);
  const maxIterations = resolveMaxIterations(undefined, env.ALUY_MAX_ITERATIONS);
  // EST-0970 (validação de VALORES) — o tema/tier salvo RESOLVE no catálogo? `themeByName`
  // é exato (nome canônico salvo pelo /theme); `resolveTierKey` aceita os tiers
  // conhecidos/fallback. `false` ⇒ a camada de checks o marca como ⚠ (órfão, cai no
  // default). Só validamos quando HÁ valor salvo (ausente = defaults, não é erro).
  return {
    exists,
    corrupted,
    ...(theme !== undefined ? { theme, themeKnown: themeByName(theme) !== undefined } : {}),
    ...(tier !== undefined ? { tier, tierKnown: resolveTierKey(tier) !== undefined } : {}),
    maxTokens,
    maxIterations,
    flags: resolveFlags(env, deps.extraFlags),
  };
}

/** Flags ATIVAS derivadas do env + extras da sessão (modo `--yolo` etc.). */
function resolveFlags(env: NodeJS.ProcessEnv, extra?: readonly string[]): string[] {
  const flags: string[] = [...(extra ?? [])];
  if (env.ALUY_NATIVE_TOOLS_OFF === '1' || env.ALUY_NATIVE_TOOLS_OFF === 'true') {
    flags.push('ALUY_NATIVE_TOOLS_OFF');
  }
  if (env.ALUY_OVERWRITE_RENDER === '0') flags.push('ALUY_OVERWRITE_RENDER=0');
  if (env.ALUY_SAFE_GLYPHS === '1') flags.push('ALUY_SAFE_GLYPHS');
  return flags;
}

// ── #7 versão/build ───────────────────────────────────────────────────────────
function gatherVersion(): VersionFact {
  return { aluy: CLI_VERSION, node: process.version };
}

// ── #8 memória — store acessível? quantos fatos? (só conta) ───────────────────
async function gatherMemory(deps: DoctorProbeDeps): Promise<MemoryFact> {
  if (!deps.memory) {
    // Sem contador injetado (ex.: shell sem store montado) ⇒ tratamos como acessível
    // com 0 fatos (não inventa erro; o shell pode não montar a memória de sessão).
    return { accessible: true, count: 0 };
  }
  try {
    const n = await deps.memory.count();
    if (n === null) return { accessible: false, count: 0 };
    return { accessible: true, count: n };
  } catch {
    return { accessible: false, count: 0 };
  }
}

// ── #9 sidecars do Maestro ──────────────────────────────────────────────
async function gatherSidecars(deps: DoctorProbeDeps): Promise<SidecarsFact> {
  const doFetch = resolveFetch(deps);

  // 3 probes HTTP em PARALELO nos sidecars (loopback, sem auth). As URLs vêm dos
  // resolvers env-configuráveis (ALUY_{MEM0,OLLAMA,HEADROOM}_URL) — o doctor proba
  // ONDE o engine REALMENTE fala, não uma porta hardcodada. Default = porta canônica.
  const env = deps.env ?? process.env;
  // services (ADR-0136 §8/§9): porta/host salvos no config — proba ONDE o engine fala.
  let services: UserServicesConfig | undefined;
  try {
    services = new UserConfigStore({ baseDir: aluyHomeOf(deps) }).load().services;
  } catch {
    /* config ausente/corrompida ⇒ default (porta canônica). */
  }
  const [headroom, ollama, mem0] = await Promise.all([
    httpProbe(`${resolveHeadroomProbeUrl(env, services)}/health`, doFetch),
    httpProbe(`${resolveOllamaUrl(env, services)}/api/tags`, doFetch),
    httpProbe(`${resolveMem0Url(env, services)}/health`, doFetch),
  ]);

  // Lê perfil + toggles de ~/.aluy/config.json (fail-safe: default TURBO/3-ON).
  let profile: 'leve' | 'turbo' = 'turbo';
  let toggles: readonly string[] = ['ollama', 'mem0'];
  try {
    const home = aluyHomeOf(deps);
    const raw = readFileSync(join(home, CONFIG_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as {
      profile?: unknown;
      sidecarToggles?: { ollama?: boolean; mem0?: boolean };
    };
    if (parsed.profile === 'leve' || parsed.profile === 'turbo') {
      profile = parsed.profile;
    }
    const resolved = resolveSidecarToggles(parsed.sidecarToggles ?? {});
    const list: string[] = [];
    if (resolved.has('ollama')) list.push('ollama');
    if (resolved.has('mem0')) list.push('mem0');
    toggles = list; // sobrescreve sempre (vazio também é válido)
  } catch {
    // config ausente/corrompida ⇒ defaults (TURBO, 3-ON).
  }

  return { headroom, ollama, mem0, profile, toggles };
}

// ── #10 Maestro — supervisor de sessão (resolveMaestro do wiring) ──────────
async function gatherMaestro(deps: DoctorProbeDeps): Promise<MaestroFact> {
  const env = deps.env ?? process.env;
  const maestro = resolveMaestro({ env: env as Record<string, string | undefined> });
  return { enabled: maestro !== undefined };
}

/**
 * Coleta TODOS os fatos do diagnóstico. Cada gatherer é independente e blindado: um
 * erro vira um fato "indisponível", nunca derruba os outros nem lança. Roda os I/O em
 * paralelo (mais rápido; nenhum depende de outro). Testes podem sobrescrever qualquer
 * gatherer individual via `deps.gather*`.
 *
 * EST-0970 (ticks AO VIVO) — assim que CADA fato resolve, dispara `deps.onCheck(id, ...)`:
 * a checklist da UI "acende" o tick daquele item um a um (em vez de tudo de uma vez). O
 * relatório final é idêntico com ou sem o callback (puro além do efeito de UI).
 */
export async function gatherDoctorFacts(deps: DoctorProbeDeps = {}): Promise<DoctorFacts> {
  // Acumulador MUTÁVEL dos fatos (cada um preenchido ao resolver). `DoctorFacts` é
  // readonly; usamos uma cópia gravável e re-projetamos no fim.
  const acc: { -readonly [K in keyof DoctorFacts]?: DoctorFacts[K] } = {};
  const emit = (id: string): void => deps.onCheck?.(id, { ...acc });
  const settle = <K extends keyof DoctorFacts>(
    id: string,
    p: Promise<DoctorFacts[K]>,
    key: K,
  ): Promise<void> =>
    p.then((v) => {
      acc[key] = v;
      emit(id);
    });

  // versão é síncrona/instantânea — resolve de cara (1º tick).
  acc.version = gatherVersion();
  emit('version');

  // Os 4 I/O independentes correm em PARALELO; cada um acende seu tick ao resolver.
  await Promise.all([
    settle('auth', (deps.gatherAuth ?? (() => gatherAuth(deps)))(), 'auth'),
    settle('broker', (deps.gatherBroker ?? (() => gatherBroker(deps)))(), 'broker'),
    settle('catalog', (deps.gatherCatalog ?? (() => gatherCatalog(deps)))(), 'catalog'),
    settle('memory', (deps.gatherMemory ?? (() => gatherMemory(deps)))(), 'memory'),
    settle('mcp', (deps.gatherMcp ?? (() => gatherMcp(deps)))(), 'mcp'),
    settle(
      'agents',
      (deps.gatherAgents ?? (() => Promise.resolve(gatherAgents(deps))))(),
      'agents',
    ),
    settle(
      'config',
      (deps.gatherConfig ?? (() => Promise.resolve(gatherConfig(deps))))(),
      'config',
    ),
    settle('sidecars', (deps.gatherSidecars ?? (() => gatherSidecars(deps)))(), 'sidecars'),
    settle('maestro', (deps.gatherMaestro ?? (() => gatherMaestro(deps)))(), 'maestro'),
  ]);

  // EST-0970 (--deep) — o teste do tier ao vivo GASTA modelo: só roda quando o caller
  // injeta o `tierTester` (opt-in `--deep`/`--test`). Por último (depois que auth/broker
  // acenderam — não faz sentido bater o modelo se a credencial já falhou, mas mantemos
  // simples e honesto: o tester degrada sozinho). Ausente ⇒ `facts.tier` undefined.
  if (deps.tierTester) {
    await settle(
      'tier',
      deps.tierTester().then((t): TierFact => t),
      'tier',
    );
  }

  return {
    auth: acc.auth!,
    broker: acc.broker!,
    catalog: acc.catalog!,
    mcp: acc.mcp!,
    agents: acc.agents!,
    config: acc.config!,
    version: acc.version!,
    memory: acc.memory!,
    sidecars: acc.sidecars!,
    maestro: acc.maestro!,
    ...(acc.tier !== undefined ? { tier: acc.tier } : {}),
  };
}
