// ADR-0120 / EST-1113 — FÁBRICA do backend local (I/O concreto, @hiperplano/aluy-cli).
//
// Monta o `LocalModelClient` a partir da config BYO resolvida: escolhe o adapter
// do provider, VALIDA o `base_url` (anti-SSRF PROV-SEC-1 com o resolver de DNS
// real), e liga o resolvedor de credencial (keychain→env, ou OAuth). Toca rede/DNS
// ⇒ mora aqui (ADR-0053 §8). O core só recebe peças PORTÁVEIS já prontas.

import {
  AnthropicAdapter,
  OpenAiCompatAdapter,
  LocalModelClient,
  validateProviderBaseUrl,
  defaultLocalCatalog,
  findProvider,
  BrokerModelCaller,
  type ProviderAdapter,
  type LocalProviderKind,
  type LocalAuthKind,
  type CredentialProvider,
  type StreamFetch,
  type LocalProviderCatalog,
  type WireFormat,
  type ModelCaller,
} from '@hiperplano/aluy-cli-core';
import { NodeHostResolver } from '../../io/web-port.js';
import { createLocalCredentialProvider } from './credential-resolver.js';
import { createPinnedStreamFetch } from './pinned-stream-fetch.js';

/**
 * base_url default público de UM provider, do CATÁLOGO (ADR-0118: era um map hardcoded).
 * Provider desconhecido ⇒ `undefined` (o caller exige um override de base_url ou falha).
 */
function defaultBaseUrlFor(
  provider: LocalProviderKind,
  catalog: LocalProviderCatalog,
): string | undefined {
  return findProvider(catalog, provider)?.baseUrl;
}

/**
 * Auth DEFAULT derivado do catálogo: provider KEYLESS (entrada com auth `['none']`, ex.:
 * Ollama local) ⇒ `'none'` (sem credencial). Qualquer outro / desconhecido ⇒ `'apikey'`.
 * Usado quando a flag/config não fixa o auth — assim Ollama "só funciona" sem pedir chave.
 */
export function defaultAuthFor(
  provider: LocalProviderKind,
  catalog: LocalProviderCatalog,
): LocalAuthKind {
  const modes = findProvider(catalog, provider)?.auth;
  if (modes !== undefined && modes.length > 0 && modes.every((m) => m === 'none')) return 'none';
  return 'apikey';
}

/**
 * Cria o adapter pelo `wireFormat` da entrada do catálogo (ADR-0118: o `wireFormat`
 * escolhe o ADAPTER de código). Hoje: `anthropic` ⇒ AnthropicAdapter; `openai-compat`/
 * `gemini` ⇒ OpenAiCompatAdapter parametrizado por base_url (um adapter `gemini` próprio
 * vira código quando houver provider que o use — ADR-0118 §1; por ora o compat é o
 * degrade aceitável). Provider sem entrada no catálogo ⇒ default `openai-compat`.
 */
function adapterFor(
  provider: LocalProviderKind,
  catalog: LocalProviderCatalog,
  defaultBaseUrl: string,
): ProviderAdapter {
  const wireFormat: WireFormat = findProvider(catalog, provider)?.wireFormat ?? 'openai-compat';
  if (wireFormat === 'anthropic') return new AnthropicAdapter();
  return new OpenAiCompatAdapter({ provider, defaultBaseUrl });
}

export interface BuildLocalClientOptions {
  readonly provider: LocalProviderKind;
  readonly model: string;
  readonly auth?: LocalAuthKind;
  /** Override de base_url (validado por anti-SSRF). Ausente ⇒ default público. */
  readonly baseUrl?: string;
  /** Teto de OUTPUT por chamada (Anthropic exige max_tokens). */
  readonly maxTokens?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** `fetch` injetável (testes). Default: global. */
  readonly fetch?: StreamFetch;
  /** Provedor de credencial injetável (testes). Default: keychain→env real. */
  readonly getCredential?: CredentialProvider;
  /** EST-1114 — provedor de access token OAuth (refrescado) p/ `auth:'oauth'`. */
  readonly oauthAccessToken?: () => Promise<string | undefined>;
  /** Resolver de DNS injetável (testes do anti-SSRF). Default: NodeHostResolver. */
  readonly resolver?: { resolve(host: string): Promise<readonly string[]> };
  /**
   * Catálogo de providers locais (ADR-0118). Default: o EMBUTIDO. O boot passa o catálogo
   * já mesclado com `~/.aluy/providers.json` p/ que o `wireFormat`/`base_url` default do
   * provider (mesmo os adicionados por config) sejam respeitados.
   */
  readonly catalog?: LocalProviderCatalog;
  /**
   * Mapa SLUG → fragmento de corpo cru (`providers[].upstreamByModel` do config do dono),
   * repassado à config do client. Quem consulta é o `toLocalRequest`, POR REQUEST e sobre
   * o slug ATIVO — ver `LocalProviderConfig.upstreamByModel`. Ausente ⇒ nada muda no
   * corpo (não-regressão para quem nunca declarou upstream).
   */
  readonly upstreamByModel?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * Monta o `LocalModelClient`. ASSÍNCRONO porque a validação anti-SSRF do `base_url`
 * resolve DNS. Lança se o `base_url` overridado aponta p/ alvo interno (PROV-SEC-1).
 */
export async function buildLocalModelClient(
  opts: BuildLocalClientOptions,
): Promise<LocalModelClient> {
  const catalog = opts.catalog ?? defaultLocalCatalog();
  // auth EFETIVO: a flag/config (`opts.auth`) vence; senão DERIVA do catálogo — provider
  // keyless (auth `['none']`, ex.: Ollama local) ⇒ 'none' automático (sem o usuário setar
  // nada). Demais ⇒ 'apikey'. Assim escolher "Ollama (local)" no onboard "só funciona".
  const auth: LocalAuthKind = opts.auth ?? defaultAuthFor(opts.provider, catalog);
  const resolver = opts.resolver ?? new NodeHostResolver();

  // base_url DEFAULT do provider (do catálogo). Provider desconhecido sem override de
  // base_url ⇒ erro claro (não há p/ onde apontar).
  const providerDefaultBaseUrl = defaultBaseUrlFor(opts.provider, catalog);
  if (providerDefaultBaseUrl === undefined && (opts.baseUrl === undefined || opts.baseUrl === '')) {
    throw new Error(
      `backend local: provider desconhecido '${opts.provider}' (não está no catálogo) e ` +
        `sem --local-base-url. Adicione-o em ~/.aluy/providers.json ou passe um base_url.`,
    );
  }
  const adapter = adapterFor(opts.provider, catalog, providerDefaultBaseUrl ?? '');

  // base_url EFETIVA: override validado (anti-SSRF) OU default público do catálogo.
  // PROV-SEC-1: esta validação de BOOT é defesa-em-profundidade (falha cedo num
  // base_url interno). A trava DE VERDADE do egress é o IP-PIN + redirect no fetch
  // pinado abaixo (EST-1115) — re-resolve→valida→pina A CADA chamada/hop, fechando
  // o DNS-rebinding (TOCTOU) e o redirect→metadata que a validação-única deixava.
  let baseUrl = opts.baseUrl ?? providerDefaultBaseUrl ?? '';
  if (opts.baseUrl !== undefined && opts.baseUrl !== '') {
    const check = await validateProviderBaseUrl(opts.baseUrl, resolver);
    if (!check.ok) {
      throw new Error(`backend local: ${check.reason} (PROV-SEC-1, anti-SSRF)`);
    }
    baseUrl = opts.baseUrl;
  }

  // EST-1115 — o egress BYO usa o fetch PINADO/STREAMING (IP-PIN + redirect
  // fail-closed). Em teste, um `fetch` injetado VENCE (mocka a rede). Em produção,
  // sem `fetch`, montamos o pinado (NUNCA cai no `globalThis.fetch` cru).
  const doFetch: StreamFetch = opts.fetch ?? createPinnedStreamFetch({ resolver });

  const getCredential =
    opts.getCredential ??
    createLocalCredentialProvider({
      provider: opts.provider,
      auth,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.oauthAccessToken ? { oauthAccessToken: opts.oauthAccessToken } : {}),
    });

  return new LocalModelClient({
    adapter,
    config: {
      provider: opts.provider,
      model: opts.model,
      auth,
      ...(opts.baseUrl ? { baseUrl } : {}),
      ...(opts.upstreamByModel ? { upstreamByModel: opts.upstreamByModel } : {}),
    },
    baseUrl,
    getCredential,
    fetch: doFetch,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
  });
}

/**
 * ADR-0152 (D6b) — porta `callerForLocalModel(slug)`: fábrica que RECONSTRÓI o
 * client local do FILHO com o MESMO provider/auth/base_url/env/credencial do PAI
 * (`base`, todo o `BuildLocalClientOptions` MENOS `model`, já resolvidos no BOOT
 * pelo `run.tsx`) — só o `model` muda p/ o `slug` pedido. Chamador de
 * `buildLocalModelClient({ ...base, model: slug })`: por NÃO passar `fetch`/
 * `getCredential` explícitos aqui, herda os MESMOS defaults do pai (o fetch PINADO
 * `createPinnedStreamFetch`, EST-1115, e o `createLocalCredentialProvider`) — NUNCA
 * `globalThis.fetch` cru, nunca uma credencial derivada de DADO (GS-SAM-L1/L2).
 *
 * PROIBIDO: `base` só pode conter o que o BOOT já resolveu (catálogo/provider/auth/
 * baseUrl/env/oauthAccessToken/upstreamByModel) — jamais um `provider`/`base_url`/
 * `api_key` vindo de spawn/`.md`/config (condição de segurança 1). O `upstreamByModel`
 * entra na lista PERMITIDA pelo mesmo motivo do `catalog`: é declaração do DONO em
 * `~/.aluy/config.json`, não sai de spawn/`.md`, e não escolhe endpoint nem credencial —
 * é fragmento de corpo que o agregador JÁ autenticado interpreta. O chamador (controller, via
 * `childCallerFor`) só passa o `slug` — um DADO de catálogo (HG-2), nunca credencial.
 *
 * MEMOIZADA por slug (client + caller): a validação anti-SSRF do `base_url` (só
 * roda quando há OVERRIDE, ver `buildLocalModelClient`) e a montagem do client
 * rodam NO MÁXIMO 1× por slug distinto nesta sessão — não a cada spawn (ADR-0152
 * D6b: "não re-valida DNS por spawn — mesmo endpoint do pai, já confiável").
 * `callerForLocalModel(slug)` é SÍNCRONA (devolve o `ModelCaller` na hora); a
 * montagem ASSÍNCRONA do client acontece de forma PREGUIÇOSA na 1ª `.call()`.
 */
export function createLocalChildCallerFactory(
  base: Omit<BuildLocalClientOptions, 'model'>,
): (slug: string) => ModelCaller {
  const clients = new Map<string, Promise<LocalModelClient>>();
  const callers = new Map<string, ModelCaller>();
  return (slug: string): ModelCaller => {
    const cached = callers.get(slug);
    if (cached) return cached;
    const caller: ModelCaller = {
      call: async (args) => {
        let pending = clients.get(slug);
        if (!pending) {
          pending = buildLocalModelClient({ ...base, model: slug });
          clients.set(slug, pending);
        }
        const client = await pending;
        // `tier` é IGNORADO pelo `LocalModelClient` fora do caminho `tier:'custom'`
        // (o `model` concreto vem da config BYO deste client, já fixada no `slug`
        // acima) — o valor aqui é só p/ satisfazer o shape de `BrokerModelCallerOptions`
        // (o MESMO adaptador que `wiring.ts` usa p/ os callers por-tier/custom).
        return new BrokerModelCaller({ client, tier: 'custom' }).call(args);
      },
    };
    callers.set(slug, caller);
    return caller;
  };
}

export interface ProviderAwareLocalChildCallerFactoryOptions {
  /**
   * Lê o PROVIDER ATIVO agora — o MESMO par mutável (`activeLocalCatalog`/
   * `activeLocalProviderId`) que `switchLocalProvider` (`run.tsx`) escreve SÓ no
   * sucesso do `/provider`. NUNCA um valor congelado do boot.
   */
  readonly getActiveProviderId: () => LocalProviderKind;
  /** Idem, o catálogo ATIVO (pode ganhar um provider custom cadastrado NESTA sessão). */
  readonly getActiveCatalog: () => LocalProviderCatalog;
  /** Provider resolvido no BOOT (flag>env>config>default) — usa `bootAuth`/`bootBaseUrl` abaixo. */
  readonly bootProvider: LocalProviderKind;
  /** Auth JÁ RESOLVIDO do boot (flag/config aplicados) — só vale p/ o `bootProvider`. */
  readonly bootAuth: LocalAuthKind;
  /** Override de base_url do boot (`--local-base-url`) — só vale p/ o `bootProvider`. */
  readonly bootBaseUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Provedor de access token OAuth por-provider (EST-1114), injetável p/ teste. */
  readonly oauthAccessTokenFor?: (
    provider: LocalProviderKind,
  ) => (() => Promise<string | undefined>) | undefined;
  /**
   * F-UP — mapa de upstream declarado (`providers[].upstreamByModel`) POR PROVIDER, lido
   * na hora (não congelado no boot): `/provider` troca o provider ativo e o mapa do
   * ANTERIOR não vale mais. MESMO padrão do `oauthAccessTokenFor` acima.
   *
   * Sem isto, um sub-agente roteado ao MESMO slug do pai sairia por um upstream
   * DIFERENTE do que o dono declarou — em silêncio, que é a classe de defeito que este
   * conserto existe para fechar.
   */
  readonly upstreamByModelFor?: (
    provider: LocalProviderKind,
  ) => Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
  /**
   * `fetch` injetável (TESTES) — repassado a toda fábrica por-provider. Produção NUNCA
   * passa isto (herda o fetch PINADO `createPinnedStreamFetch`, EST-1115, dentro de
   * `buildLocalModelClient`); existe só p/ observar requests sem tocar rede real, o
   * MESMO padrão de `createLocalChildCallerFactory`/`local-child-caller-factory.test.ts`.
   */
  readonly fetch?: StreamFetch;
  /** Idem, credencial injetável (TESTES) — produção nunca passa (herda `createLocalCredentialProvider`). */
  readonly getCredential?: CredentialProvider;
  /** Idem, resolvedor de DNS injetável (TESTES do anti-SSRF). */
  readonly resolver?: { resolve(host: string): Promise<readonly string[]> };
}

/**
 * F-PROV — versão de `callerForLocalModel` (ADR-0152 D6b) que segue o PROVIDER ATIVO
 * da sessão em vez do congelado no boot. Fecha o gap que a rc.117 deixou DECLARADO: o
 * `/provider` já troca de verdade o `LocalModelClient` do PAI (`switchLocalProvider`)
 * e o catálogo do `/model` (`localModelCatalog`, run.tsx) já segue o provider trocado —
 * mas `callerForLocalModel` (a porta de ROTEAMENTO de sub-agente, usada por
 * `childCallerFor`/`spawn_agent`) continuava fechada SÓ sobre o que o boot resolveu.
 * Sem este fix, um sub-agente roteado a um modelo local depois de um `/provider`
 * bem-sucedido no meio da sessão saía pelo endpoint/credencial do provider ANTERIOR —
 * silenciosamente, o mesmo tipo de defeito que o `/provider` original tinha.
 *
 * Estratégia: uma fábrica `createLocalChildCallerFactory` MEMOIZADA por `providerId`
 * (nunca reconstrói client/valida anti-SSRF de novo p/ um provider já visto — preserva
 * a memoização por-slug de D6b); a cada CHAMADA (não na construção), o provider ATIVO é
 * relido via `getActiveProviderId()`. O provider do BOOT usa a config JÁ RESOLVIDA
 * (`bootAuth`/`bootBaseUrl`, flags/env/config aplicados — ZERO regressão); um provider
 * TROCADO depois usa os DEFAULTS do catálogo ATIVO (`defaultAuthFor` + base_url
 * público) — a MESMA resolução que `switchLocalProvider` usa pra montar o client dele
 * (SEM reaplicar overrides de flag/env que eram do provider ANTERIOR).
 *
 * Credencial NUNCA vem do slug/DADO: só o `provider` (lido do estado ATIVO, nunca de
 * spawn/`.md`/config) decide qual `createLocalCredentialProvider` a fábrica interna usa
 * (herdado via os defaults do `buildLocalModelClient`, dentro de `createLocalChildCallerFactory`).
 *
 * Fail-closed: se o provider ativo não existir no catálogo ativo, `buildLocalModelClient`
 * (chamado preguiçosamente na 1ª `.call()` da fábrica interna) LANÇA um erro legível —
 * nunca cai silenciosamente num provider diferente do selecionado; `childCallerFor`/
 * `runChild` convertem essa rejeição em `ok:false` (não roteia), o mesmo fail-closed que
 * D6b já garante p/ o caso "pai fora de backend local".
 */
export function createProviderAwareLocalChildCallerFactory(
  opts: ProviderAwareLocalChildCallerFactoryOptions,
): (slug: string) => ModelCaller {
  const factoriesByProvider = new Map<string, (slug: string) => ModelCaller>();
  const factoryFor = (providerId: LocalProviderKind): ((slug: string) => ModelCaller) => {
    const cached = factoriesByProvider.get(providerId);
    if (cached !== undefined) return cached;
    const catalog = opts.getActiveCatalog();
    const isBootProvider = providerId === opts.bootProvider;
    const auth: LocalAuthKind = isBootProvider
      ? opts.bootAuth
      : defaultAuthFor(providerId, catalog);
    const oauthAccessToken = opts.oauthAccessTokenFor?.(providerId);
    const upstreamByModel = opts.upstreamByModelFor?.(providerId);
    const factory = createLocalChildCallerFactory({
      catalog,
      provider: providerId,
      auth,
      ...(upstreamByModel !== undefined ? { upstreamByModel } : {}),
      ...(isBootProvider && opts.bootBaseUrl !== undefined ? { baseUrl: opts.bootBaseUrl } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(auth === 'oauth' && oauthAccessToken !== undefined ? { oauthAccessToken } : {}),
      // TESTES apenas — produção nunca preenche estes três (ver os comentários dos
      // campos em `ProviderAwareLocalChildCallerFactoryOptions`).
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts.getCredential !== undefined ? { getCredential: opts.getCredential } : {}),
      ...(opts.resolver !== undefined ? { resolver: opts.resolver } : {}),
    });
    factoriesByProvider.set(providerId, factory);
    return factory;
  };
  return (slug: string): ModelCaller => factoryFor(opts.getActiveProviderId())(slug);
}
