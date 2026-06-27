// EST-1116 · ADR-0120 · ADR-0076 · ADR-0030 §3 · CLI-SEC-7 — `aluy models` / `aluy
// providers` (shell): lista os providers/modelos DISPONÍVEIS, fora da sessão.
//
// A face SHELL da discoverability de modelos (hoje só há as flags `--provider`/`--model`
// e o menu `/model` em sessão): mostra DUAS seções —
//   1. LOCAL (BYO): os providers/adapters do backend local (anthropic/openai/openrouter),
//      o modo de auth e o modelo default. Metadata PÚBLICA montada AQUI (o `@hiperplano/aluy-cli`
//      detém os defaults — CLI-SEC-7/CA-3: o core não embute endpoint/SDK/chave).
//   2. BROKER: tiers + providers registrados + modelos custom, do CATÁLOGO VIVO do broker
//      (`GET /v1/tiers/catalog`, `/v1/providers`, `/v1/models/custom`). FAIL-SOFT: broker
//      fora / sem login ⇒ a seção vira AVISOS ("indisponível — …"), NÃO quebra (exit 0).
//      Espelha o `aluy doctor` (cada fonte é independente e blindada).
//
// REUSO (DoD): usa os MESMOS clientes do `/model` da sessão (`createTierCatalogClient`/
// `createProvidersClient`/`createCustomModelClient`) e o MESMO formatador PURO do core
// (`buildModelsNote`). Nada de parse/IO de catálogo reimplementado. Espelha
// `commands/agents.ts`/`commands/skills.ts` (EST-0977/EST-1112).
//
// EXIT 0 SEMPRE: é uma LISTAGEM (como `aluy agents`), não um gate. CLI-SEC-7: a saída só
// carrega NOMES/SLUGS públicos (os parsers do catálogo já descartam o sensível).

import {
  LoginService,
  buildModelsNote,
  createTierCatalogClient,
  createProvidersClient,
  createCustomModelClient,
  type ModelsScope,
  type LocalProviderListing,
  type BrokerListing,
  type BrokerSource,
  resolveBackend,
  type StreamFetch,
  type CredentialStore,
  type LocalProviderCatalog,
} from '@hiperplano/aluy-cli-core';
import { loadAuthConfig } from '../auth/config.js';
import { loadBrokerConfig } from '../model/config.js';
import { loadLocalProviderCatalog } from '../io/providers-config.js';
import { KeychainCredentialStore } from '../auth/keychain-store.js';

/**
 * Monta a metadata PÚBLICA dos providers locais a partir do CATÁLOGO (ADR-0118): o
 * default embutido + override do usuário (`~/.aluy/providers.json`). Substitui as 3
 * constantes hardcoded de antes (`AUTH_MODES_BY_PROVIDER`/`CATALOG_HINT_BY_PROVIDER`/
 * `ALL_LOCAL_PROVIDERS`). CLI-SEC-7: só nome/auth/modelo-default/hint públicos — nunca
 * `base_url`/chave (o `base_url` do catálogo NÃO é exposto na listagem). PURO. */
function buildLocalListing(catalog: LocalProviderCatalog): readonly LocalProviderListing[] {
  return catalog.entries.map((e) => ({
    provider: e.id,
    authModes: e.auth,
    defaultModel: e.defaultModel,
    ...(e.catalogHint !== undefined ? { catalogHint: e.catalogHint } : {}),
  }));
}

/** Deps injetáveis p/ teste (sem tocar keychain/rede/env). */
export interface ModelsRunnerDeps {
  readonly env?: NodeJS.ProcessEnv;
  /** Escopo já resolvido (do `--backend`). Default: `both`. */
  readonly scope?: ModelsScope;
  /** Visão: `models` (default, tudo) ou `providers` (foco nos providers). */
  readonly view?: 'models' | 'providers';
  /** Sink de saída (default: stdout). Injetável p/ capturar no teste. */
  readonly out?: (line: string) => void;
  /** `--json`: imprime o objeto estruturado em vez das linhas. */
  readonly json?: boolean;
  /** Store de credencial (default: keychain real). Injetável p/ teste. */
  readonly store?: CredentialStore;
  /** `fetch` injetável p/ os clientes do broker (testes mockam a rede). */
  readonly brokerFetch?: StreamFetch;
  /**
   * Catálogo de providers locais já resolvido (default embutido + override do usuário).
   * Injetável p/ teste; default: carrega `~/.aluy/providers.json` mesclado (ADR-0118).
   */
  readonly localCatalog?: LocalProviderCatalog;
}

/** Mensagem NEUTRA do motivo da indisponibilidade (HG-2: nunca o provider/credencial). */
function reasonFrom(err: unknown): string {
  // SessionExpiredError ⇒ "faça login"; demais ⇒ "broker fora/sem conexão". NUNCA
  // ecoa stack/credencial. Olha só o nome da classe (sem acoplar ao import).
  const name = err instanceof Error ? err.name : '';
  if (name === 'SessionExpiredError') return 'faça `aluy login` (sem sessão).';
  return 'broker fora ou sem conexão (cheque a ALUY_BROKER_URL).';
}

/** Roda uma fonte do broker fail-soft: devolve `{ok:true,data}` ou `{ok:false,reason}`. */
async function source<T>(fn: () => Promise<T>): Promise<BrokerSource<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, reason: reasonFrom(err) };
  }
}

/** Consulta o catálogo VIVO do broker (3 fontes independentes, todas fail-soft). */
async function gatherBroker(
  deps: ModelsRunnerDeps,
  env: NodeJS.ProcessEnv,
): Promise<BrokerListing> {
  const authConfig = loadAuthConfig(env);
  const brokerConfig = loadBrokerConfig(env);
  const store = deps.store ?? new KeychainCredentialStore();
  const login = new LoginService(
    { ...authConfig, baseUrl: authConfig.identityBaseUrl, store },
    { envToken: () => env.ALUY_TOKEN },
  );
  const fetchOpt = deps.brokerFetch ? { fetch: deps.brokerFetch } : {};
  const tiersClient = createTierCatalogClient({
    brokerBaseUrl: brokerConfig.brokerBaseUrl,
    login,
    ...fetchOpt,
  });
  const providersClient = createProvidersClient({
    brokerBaseUrl: brokerConfig.brokerBaseUrl,
    login,
    ...fetchOpt,
  });
  const customClient = createCustomModelClient({
    brokerBaseUrl: brokerConfig.brokerBaseUrl,
    login,
    ...fetchOpt,
  });

  // Cada fonte é independente: uma falhar NÃO derruba as outras (espelha o /doctor).
  const [tiers, providers, custom] = await Promise.all([
    source(() => tiersClient.list()),
    source(() => providersClient.list()),
    source(() => customClient.list()),
  ]);
  return { tiers, providers, custom };
}

/**
 * Executa `aluy models` (e `aluy providers`, mesmo runner). Monta a metadata local
 * (DADO público) e — quando o scope inclui broker — consulta o catálogo VIVO fail-soft,
 * formata com o `buildModelsNote` do core e imprime. Read-only; SEMPRE exit 0 (listagem).
 *
 * Com `--json`, imprime um objeto estruturado no stdout (sem decoração) p/ script.
 */
export async function runModels(deps: ModelsRunnerDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line: string) => process.stdout.write(line + '\n'));
  const scope: ModelsScope = deps.scope ?? 'both';
  const view = deps.view ?? 'models';

  // Catálogo local EFETIVO: default embutido + override do usuário (fail-soft no load).
  const catalog = deps.localCatalog ?? loadLocalProviderCatalog();
  const local = buildLocalListing(catalog);
  const wantBroker = scope === 'broker' || scope === 'both';
  const broker = wantBroker ? await gatherBroker(deps, env) : undefined;

  // Backend ativo (resolvido por precedência env>config — sem flag aqui; é display).
  const activeBackend = resolveBackend({ env: env.ALUY_BACKEND });

  if (deps.json === true) {
    // Saída estruturada p/ script: só DADO público (CLI-SEC-7). O `BrokerSource`
    // serializa como {ok,...} — o consumidor de script lê o `ok` p/ saber se degradou.
    const payload = {
      view,
      scope,
      activeBackend,
      local,
      ...(broker !== undefined ? { broker } : {}),
    };
    out(JSON.stringify(payload));
    return 0;
  }

  const note = buildModelsNote({
    scope,
    view,
    activeBackend,
    local,
    ...(broker !== undefined ? { broker } : {}),
  });
  out(
    view === 'providers'
      ? 'aluy providers — providers disponíveis (local + broker)'
      : 'aluy models — providers e modelos disponíveis',
  );
  out('');
  for (const line of note.lines) out(line);
  // Listagem, não gate: broker indisponível VIRA aviso (não derruba). Exit 0 sempre.
  return 0;
}
