// F-WIN (descoberta) — I/O CONCRETO da DESCOBERTA AUTOMÁTICA da janela de contexto do
// modelo BYO: pergunta ao próprio provider (`GET {baseUrl}/models`) qual é o
// `context_length` do slug ativo e PERSISTE o número em
// `providers[<id>].contextByModel` do `~/.aluy/config.json`.
//
// O PORQUÊ: a janela por-modelo já era LIDA por todo o caminho a jusante
// (`modelWindowFromConfig` → `resolveContextWindow` → `contextWindow` do controller →
// `⛁ %` + auto-compactação), mas NINGUÉM a escrevia — o dono precisava caçar o número
// na doc do provider e editar o JSON na mão. Quem não editava rodava com janela 0:
// `⛁ %` congelado e auto-compactação INERTE (`decideAutoCompact` sai em
// `contextWindow <= 0`), i.e. sessão longa SEM rede de segurança. O provider quase
// sempre já sabe o número; faltava PERGUNTAR.
//
// Segue o PRECEDENTE do ADR-0153 (`test-then-register`, `test-then-register.ts`), que
// já faz uma chamada de rede ao provider com a credencial do keychain e persiste o
// resultado no config — MESMA forma (fábrica de I/O INJETADO, função memoizada, teto
// por sessão) e MESMAS travas:
//   • COND-S1 — fetch PINADO anti-SSRF (EST-1115) INJETADO pelo `run.tsx`; este módulo
//     NUNCA toca `globalThis.fetch` (o `/models` é egress p/ um host que o DADO do
//     config escolheu — o mesmo vetor de metadata-da-cloud do resto do BYO).
//   • COND-S2 — credencial via o MESMO `createLocalCredentialProvider` do boot
//     (keychain→env), injetada como `getKey`. A chave NUNCA é lida/logada/interpolada
//     aqui: só vai no header `authorization` (CLI-SEC-10).
//   • COND-S3 — teto de descobertas por sessão + memoização (anti-runaway).
//   • COND-S4 — persistência é append IDEMPOTENTE numa entrada JÁ existente (o store
//     recusa sintetizar provider novo); só o NÚMERO muda.
//
// FAIL-OPEN por construção (a diferença p/ o ADR-0153, que é fail-CLOSED): a spec da
// OpenAI NÃO obriga `context_length` no `/models`. Provider que não informa, 401,
// timeout, corpo inválido, rede fora, egress recusado pelo anti-SSRF ⇒ NADA quebra,
// só não descobrimos — degrada EXATAMENTE p/ o comportamento de hoje (0/inerte). Esta
// função NUNCA lança e NUNCA empurra erro p/ a TUI.

import {
  parseModelsListContexts,
  findModelContext,
  isPlausibleContextWindow,
  parseModelsListSlugs,
  type DiscoveredModelContext,
} from '@hiperplano/aluy-cli-core';
import type { ConnectivityFetch } from './connectivity-check.js';

/**
 * Teto de SLUGS DISTINTOS cuja janela tentamos descobrir por sessão. Espelha o
 * `MAX_LOCAL_MODEL_TESTS_PER_SESSION` do ADR-0153, mas MUITO menor: descoberta é do
 * modelo ATIVO do boot (um por sessão, mais o eventual `/model` de troca) — dezenas de
 * slugs distintos aqui seriam sintoma de loop, não de uso. Atingido o teto, devolvemos
 * "não descoberto" SEM pingar (custo zero).
 */
export const MAX_CONTEXT_DISCOVERIES_PER_SESSION = 8;

/** Timeout da chamada `/models` (ms). Curto de propósito: é trabalho de fundo, best-effort. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 8_000;

/**
 * Teto do CORPO lido do `/models`, em chars. OpenRouter lista ~400 modelos (~1MB de
 * JSON) — cabe. Um corpo maior que isto é anômalo (provider adulterado/endpoint
 * errado devolvendo um dump) e não vale o `JSON.parse` no boot: descartamos e não
 * descobrimos (fail-open). O `text()` já veio à memória — este teto protege o PARSE,
 * que é o caro (o download é limitado pelo timeout).
 */
export const MAX_MODELS_BODY_CHARS = 4_000_000;

/** Resultado de uma tentativa de descoberta. `window: 0` ⇒ NÃO descoberta (fail-open). */
export interface DiscoverContextWindowResult {
  /** Janela em tokens, já validada (`isPlausibleContextWindow`). `0` = não descoberta. */
  readonly window: number;
  /** `true` ⇒ gravou em `providers[<id>].contextByModel`; `false` ⇒ só sessão OU nada. */
  readonly persisted: boolean;
}

const NOT_DISCOVERED: DiscoverContextWindowResult = { window: 0, persisted: false };

export interface FetchModelsContextsArgs {
  /** `WireFormat` do provider ATIVO do boot (nunca de DADO — mesma disciplina da COND-S9). */
  readonly wireFormat: string;
  /** `base_url` do provider ATIVO do boot, já resolvido (override OU default do catálogo). */
  readonly baseUrl: string;
  /** Credencial já resolvida (keychain→env). `''` (auth:'none', Ollama) ⇒ sem header. */
  readonly key: string;
  /** Fetch PINADO anti-SSRF (EST-1115). OBRIGATÓRIO — nunca `globalThis.fetch`. */
  readonly fetchImpl: ConnectivityFetch;
  /** Timeout em ms (default `DEFAULT_DISCOVERY_TIMEOUT_MS`). */
  readonly timeoutMs?: number;
}

/**
 * F-MODEL-LIVE — I/O CRU do `GET {baseUrl}/models`: SÓ fetch PINADO + timeout + teto de
 * corpo + `JSON.parse`, SEM decidir o que extrair do corpo (isso é do CHAMADOR —
 * `parseModelsListContexts` p/ janela, `parseModelsListSlugs` p/ nomes). Extraído de
 * `fetchModelsContexts` p/ os DOIS consumidores (janela E lista de nomes do picker,
 * F-MODEL-LIVE) compartilharem o MESMO caminho de rede — nunca um 2º fetch duplicado.
 *
 * SÓ para `openai-compat`. O `wireFormat` `anthropic` também tem `/v1/models`, mas ele
 * NÃO devolve janela de contexto (só `id`/`display_name`/`created_at`) — pingá-lo seria
 * uma chamada garantidamente inútil pro caso de janela (o caso de nomes ainda usaria o
 * `id`, mas por ora nenhum chamador pede nomes de um provider `anthropic`); `gemini` não
 * fala este dialeto. Saímos ANTES da rede nos dois casos.
 *
 * `{base}/models` (e não `/v1/models`) porque o `baseUrl` do catálogo BYO já inclui o
 * `/v1` quando o provider o usa — é a MESMA composição do `checkModelConnectivity`
 * (`${base}/chat/completions`), então um provider que funciona p/ chat funciona aqui.
 *
 * `undefined` ⇒ qualquer falha (rede, timeout, 401/404, corpo não-JSON/grande demais,
 * redirect BLOQUEADO pelo fetch pinado) — NUNCA lança. NUNCA interpola a exceção em
 * lugar nenhum: a mensagem do fetch pinado carrega host/`location` (vetor de
 * SSRF/vazamento) e a do transporte pode ecoar a URL com credencial.
 */
async function fetchModelsBody(args: FetchModelsContextsArgs): Promise<unknown> {
  if (args.wireFormat !== 'openai-compat') return undefined;
  const base = args.baseUrl.replace(/\/+$/, '');
  if (base === '') return undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
  try {
    const res = await args.fetchImpl(`${base}/models`, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        // A credencial só entra quando EXISTE (`auth:'none'` do Ollama resolve p/ `''`
        // e mandar `Bearer ` vazio faz alguns servers responderem 401 à toa). NUNCA é
        // logada/interpolada em mensagem (CLI-SEC-10) — só este header.
        ...(args.key !== '' ? { authorization: `Bearer ${args.key}` } : {}),
      },
      // SEM `body`: GET com body (mesmo `''`) faz o fetch do Node LANÇAR antes da rede
      // (mesma armadilha documentada no `custom-models-client` do core).
    });
    // BUG (relato do dono: "só o tokenrouter não traz a lista de modelos") — MEDIDO no
    // gateway dele: `GET {base}/models` responde **400**, e `GET {base}/models?` — a MESMA
    // URL com uma query string VAZIA — responde **200** com os 127 modelos. É defeito do
    // roteador daquele gateway, não nosso; mas o efeito aqui era o dono achar que o aluy
    // não listava os modelos DELE, enquanto listava os de todo mundo.
    //
    // Uma 2ª tentativa com `?` é BARATA (só quando a 1ª falha), INÓCUA para quem já
    // funciona (nunca chega a rodar) e não muda o alvo: mesmo host, mesmo path, mesma
    // credencial — nada aqui vira vetor novo de egress. Só o 400/404 justificam a
    // repetição: 401 é credencial (repetir não conserta e gasta tentativa num provider
    // que pode contar falha no rate limit) e 5xx é falha do servidor.
    let resposta = res;
    if (!resposta.ok && (resposta.status === 400 || resposta.status === 404)) {
      resposta = await args.fetchImpl(`${base}/models?`, {
        method: 'GET',
        signal: ctrl.signal,
        headers: {
          accept: 'application/json',
          ...(args.key !== '' ? { authorization: `Bearer ${args.key}` } : {}),
        },
      });
    }
    if (!resposta.ok) return undefined; // 401/404/5xx ⇒ não descobrimos. Sem nota, sem erro (fail-open).
    const text = await resposta.text();
    if (text.length > MAX_MODELS_BODY_CHARS) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lê `GET {baseUrl}/models` e devolve os pares `{slug, context}` que o provider
 * informou. NUNCA lança: qualquer falha ⇒ `[]` = "não descobrimos nada". Ver
 * `fetchModelsBody` p/ o que conta como falha.
 */
export async function fetchModelsContexts(
  args: FetchModelsContextsArgs,
): Promise<readonly DiscoveredModelContext[]> {
  const body = await fetchModelsBody(args);
  return body === undefined ? [] : parseModelsListContexts(body);
}

/**
 * F-MODEL-LIVE — lê `GET {baseUrl}/models` e devolve os SLUGS anunciados (sem exigir
 * janela — ver `parseModelsListSlugs`, o irmão de `parseModelsListContexts` que não
 * descarta modelo por falta de `context_length`). MESMO fetch PINADO/teto/timeout de
 * `fetchModelsContexts` (via `fetchModelsBody`) — nenhum 2º caminho de rede. NUNCA
 * lança: qualquer falha ⇒ `[]`.
 */
export async function fetchModelsSlugs(args: FetchModelsContextsArgs): Promise<readonly string[]> {
  const body = await fetchModelsBody(args);
  return body === undefined ? [] : parseModelsListSlugs(body);
}

export interface CreateDiscoverContextWindowPortOptions extends Omit<
  FetchModelsContextsArgs,
  'key'
> {
  /**
   * Credencial resolvida A CADA chamada (keychain/OAuth rotacionam sem reiniciar a
   * sessão) — MESMO `createLocalCredentialProvider` do boot (COND-S2). Substitui o
   * `key` FIXO do `fetchModelsContexts`: a porta vive a sessão inteira, então nunca
   * congela uma credencial.
   */
  readonly getKey: () => Promise<string>;
  /**
   * Persistência IDEMPOTENTE em `providers[<id>].contextByModel` (COND-S4). Devolve
   * `false` p/ provider built-in SEM entrada em `providers[]` (aí a descoberta vale só
   * p/ a sessão corrente — nada quebra, só não é lembrada). Ausente ⇒ nunca persiste.
   */
  readonly persistContextWindow?: (slug: string, tokens: number) => boolean;
  /** Teto de slugs distintos (default `MAX_CONTEXT_DISCOVERIES_PER_SESSION`). Injetável p/ teste. */
  readonly maxDiscoveriesPerSession?: number;
}

/**
 * Monta a porta `discoverContextWindow(slug)`.
 *
 * DUAS memoizações, ambas anti-runaway (COND-S3):
 *   1. a LISTA `/models` é buscada UMA vez por sessão (promise memoizada) — N slugs
 *      perguntados resolvem 1 chamada de rede; e uma falha transitória fica memoizada
 *      junto (não re-tentamos em loop dentro da mesma sessão — escolha consciente, a
 *      próxima sessão tenta de novo);
 *   2. o RESULTADO por slug (inclusive "não descoberto") — o mesmo slug nunca custa
 *      duas passagens.
 * Mais o TETO de slugs distintos, que responde "não descoberto" sem sequer consultar.
 *
 * A função devolvida NUNCA lança nem rejeita (o `getKey` pode lançar
 * `MissingLocalCredentialError`; é capturado aqui). Chamá-la é sempre seguro em
 * background, sem `catch` do lado de fora.
 */
export function createDiscoverContextWindowPort(
  opts: CreateDiscoverContextWindowPortOptions,
): (slug: string) => Promise<DiscoverContextWindowResult> {
  const cap = opts.maxDiscoveriesPerSession ?? MAX_CONTEXT_DISCOVERIES_PER_SESSION;
  const perSlug = new Map<string, Promise<DiscoverContextWindowResult>>();
  let listPromise: Promise<readonly DiscoveredModelContext[]> | undefined;

  const loadList = (): Promise<readonly DiscoveredModelContext[]> => {
    if (listPromise === undefined) {
      listPromise = (async (): Promise<readonly DiscoveredModelContext[]> => {
        try {
          const key = await opts.getKey();
          return await fetchModelsContexts({
            wireFormat: opts.wireFormat,
            baseUrl: opts.baseUrl,
            key,
            fetchImpl: opts.fetchImpl,
            ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          });
        } catch {
          // `getKey` sem credencial (keychain vazio/locked) ⇒ não descobrimos. Fail-open:
          // o BYO sem chave já falha de forma honesta no PRIMEIRO turno; a descoberta não
          // é o lugar de reportar isso (e não pode derrubar o boot).
          return [];
        }
      })();
    }
    return listPromise;
  };

  return (slug: string): Promise<DiscoverContextWindowResult> => {
    const wanted = slug.trim();
    if (wanted === '') return Promise.resolve(NOT_DISCOVERED);
    const cached = perSlug.get(wanted.toLowerCase());
    if (cached !== undefined) return cached;
    // Teto atingido: NÃO memoiza (não foi de fato consultado) e não faz trabalho algum.
    if (perSlug.size >= cap) return Promise.resolve(NOT_DISCOVERED);

    const p = (async (): Promise<DiscoverContextWindowResult> => {
      const list = await loadList();
      const found = findModelContext(list, wanted);
      // Provider não informou a janela DESTE slug (ou não informa nenhuma — o caso que a
      // spec da OpenAI permite): "não descoberto". A precedência a jusante segue p/ o
      // degrau de baixo, que é 0/inerte — EXATAMENTE o comportamento de hoje.
      if (found === undefined || !isPlausibleContextWindow(found)) return NOT_DISCOVERED;
      // Persistência best-effort: uma falha de escrita (disco cheio, `~/.aluy` read-only)
      // NÃO invalida a descoberta — a janela ainda vale p/ a sessão corrente.
      let persisted = false;
      try {
        persisted = opts.persistContextWindow?.(wanted, found) ?? false;
      } catch {
        persisted = false;
      }
      return { window: found, persisted };
    })();
    perSlug.set(wanted.toLowerCase(), p);
    return p;
  };
}

/** Peças concretas (wireFormat/baseUrl/credencial/persistência) de UM provider. */
export interface ProviderDiscoveryDeps {
  readonly wireFormat: string;
  readonly baseUrl: string;
  readonly fetchImpl: ConnectivityFetch;
  readonly getKey: () => Promise<string>;
  readonly persistContextWindow?: (slug: string, tokens: number) => boolean;
}

export interface ProviderAwareDiscoverContextWindowPortOptions {
  /**
   * Lê o PROVIDER ATIVO agora — o MESMO par mutável (`activeLocalCatalog`/
   * `activeLocalProviderId`) que `switchLocalProvider` (`run.tsx`) escreve SÓ no
   * sucesso do `/provider`. NUNCA um valor congelado do boot.
   */
  readonly getActiveProviderId: () => string;
  /**
   * Resolve as peças concretas do provider pedido (catálogo ATIVO/credencial/fetch
   * pinado) — MESMA disciplina de quem monta a porta hoje em `run.tsx`
   * (`findProvider`/`defaultAuthFor`/`createLocalCredentialProvider`/
   * `createPinnedStreamFetch`). Chamado NO MÁXIMO 1x por provider distinto (a
   * memoização abaixo evita reconstruir/revalidar a cada slug).
   */
  readonly depsForProvider: (providerId: string) => ProviderDiscoveryDeps;
  readonly maxDiscoveriesPerSession?: number;
}

/**
 * F-WIN (descoberta) — versão de `discoverContextWindow` que segue o PROVIDER ATIVO da
 * sessão em vez do congelado no boot. Fecha o gap declarado da rc.117: a porta original
 * fechava `wireFormat`/`baseUrl`/credencial SÓ sobre o `localCfg`/`localCatalog`
 * resolvidos no BOOT — depois de um `/provider` bem-sucedido no meio da sessão, uma
 * descoberta disparada para o slug ativo continuaria perguntando ao provider ANTERIOR
 * (endpoint/credencial errados), o mesmo defeito de fundo que o `switchLocalProvider`
 * consertou pro client de verdade.
 *
 * Uma porta `createDiscoverContextWindowPort` por-provider é criada e MEMOIZADA (Map por
 * `providerId`) — a MESMA disciplina anti-runaway (COND-S3: 1 chamada de `/models` por
 * provider por sessão) continua valendo, agora por-provider em vez de uma vez só; nunca
 * reconstrói a porta de um provider já visto. A cada CHAMADA (não na construção), o
 * provider ATIVO é relido via `getActiveProviderId()`.
 *
 * FAIL-OPEN preservado: um provider cujas `depsForProvider` resolvem p/ `baseUrl` vazio
 * (ex.: provider desconhecido no catálogo ATIVO) ⇒ a porta interna já sai ANTES da rede
 * (mesma guarda de `fetchModelsContexts`) — "não descoberto", nunca um erro visível
 * (a descoberta é enfeite de status bar, não um caminho de segurança que precise
 * fail-CLOSED; ver o comentário de topo deste arquivo).
 */
export function createProviderAwareDiscoverContextWindowPort(
  opts: ProviderAwareDiscoverContextWindowPortOptions,
): (slug: string) => Promise<DiscoverContextWindowResult> {
  const portsByProvider = new Map<string, (slug: string) => Promise<DiscoverContextWindowResult>>();
  const portFor = (
    providerId: string,
  ): ((slug: string) => Promise<DiscoverContextWindowResult>) => {
    const cached = portsByProvider.get(providerId);
    if (cached !== undefined) return cached;
    const deps = opts.depsForProvider(providerId);
    const built = createDiscoverContextWindowPort({
      wireFormat: deps.wireFormat,
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
      getKey: deps.getKey,
      ...(deps.persistContextWindow !== undefined
        ? { persistContextWindow: deps.persistContextWindow }
        : {}),
      ...(opts.maxDiscoveriesPerSession !== undefined
        ? { maxDiscoveriesPerSession: opts.maxDiscoveriesPerSession }
        : {}),
    });
    portsByProvider.set(providerId, built);
    return built;
  };
  return (slug: string): Promise<DiscoverContextWindowResult> =>
    portFor(opts.getActiveProviderId())(slug);
}

// ── F-MODEL-LIVE — lista DINÂMICA de nomes p/ o `<LocalModelPicker>` (`/model`) ─────
//
// O DIAGNÓSTICO (dogfooding, já apurado): sob backend LOCAL o `/model` listava só
// `localModelCatalogPort.listNames()` — os slugs DECLARADOS no catálogo (embutido +
// `~/.aluy/config.json`) ∪ os registrados NESTA sessão (ADR-0153 D2). Pro `openrouter`
// built-in isso são só 5 slugs fixos; o provider de verdade expõe CENTENAS via
// `GET /models` (confirmado em campo: 338 no dia da investigação) — e o modelo que o
// dono efetivamente usa nem estava entre os 5 (o picker não conseguia sequer MOSTRAR o
// modelo ativo). A entrega anterior (rc.117) trocou a FONTE (broker → catálogo local)
// mas manteve a lista ESTÁTICA — não fechou o buraco, só mudou de onde ele vinha.
//
// Esta porta busca a lista VIVA (`fetchModelsSlugs`, MESMO fetch PINADO/teto/timeout de
// `discoverContextWindow` — nenhum 2º caminho de rede) e é a peça que `useLocalModelPicker`
// (packages/cli/src/ui/hooks/useLocalModelPicker.ts) chama ao ABRIR o picker. A UNIÃO
// com o catálogo DECLARADO/sessão/modelo ATIVO acontece do lado do hook (que já tem
// essas três fontes) — esta porta só entrega o que o PROVIDER disse, mais um sinal `ok`
// p/ a UI decidir se avisa "não foi possível listar" (fail-open honesto: nunca lista
// vazia SILENCIOSA, sempre com o aviso quando a rede falhou).

/** Resultado de UMA busca da lista viva do `/models`. */
export interface ListModelNamesResult {
  /** Slugs anunciados pelo provider (pode ser `[]` em falha OU provider sem modelos). */
  readonly names: readonly string[];
  /** `true` ⇒ a rede respondeu (mesmo que `names` venha vazio); `false` ⇒ falhou
   * (rede/timeout/401/wireFormat não-suportado) — a UI deve avisar o fallback. */
  readonly ok: boolean;
}

export interface CreateListModelNamesPortOptions extends Omit<FetchModelsContextsArgs, 'key'> {
  /** Credencial resolvida A CADA chamada (keychain/OAuth rotacionam) — MESMO padrão de
   * `CreateDiscoverContextWindowPortOptions.getKey`. */
  readonly getKey: () => Promise<string>;
}

/**
 * Monta a porta `listModelNames()`: busca `GET {baseUrl}/models` UMA vez por sessão
 * (promise memoizada — MESMA disciplina anti-runaway do `loadList` de
 * `createDiscoverContextWindowPort`: N aberturas do picker no MESMO provider resolvem 1
 * chamada de rede). NUNCA lança/rejeita — falha vira `{names:[], ok:false}`.
 */
export function createListModelNamesPort(
  opts: CreateListModelNamesPortOptions,
): () => Promise<ListModelNamesResult> {
  let cached: Promise<ListModelNamesResult> | undefined;
  return (): Promise<ListModelNamesResult> => {
    if (cached === undefined) {
      cached = (async (): Promise<ListModelNamesResult> => {
        try {
          const key = await opts.getKey();
          const body = await fetchModelsBody({
            wireFormat: opts.wireFormat,
            baseUrl: opts.baseUrl,
            key,
            fetchImpl: opts.fetchImpl,
            ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          });
          // `body === undefined` é o sinal ÚNICO de falha (rede/timeout/401/corpo
          // grande demais/wireFormat não-suportado) — ver `fetchModelsBody`. Um corpo
          // que existe mas não tem `data`/array válido cai em `parseModelsListSlugs`
          // devolvendo `[]`, e ainda assim contamos como `ok:true` (a rede respondeu;
          // só não havia nada útil pra extrair — não é o mesmo caso de "provider fora
          // do ar", então não merece o aviso de fallback).
          if (body === undefined) return { names: [], ok: false };
          return { names: parseModelsListSlugs(body), ok: true };
        } catch {
          // `getKey` sem credencial (keychain vazio/locked) ⇒ fallback honesto.
          return { names: [], ok: false };
        }
      })();
    }
    return cached;
  };
}

export interface ProviderAwareListModelNamesPortOptions {
  /** MESMO par mutável que `switchLocalProvider` (`run.tsx`) escreve — nunca um valor
   * congelado do boot (ver `ProviderAwareDiscoverContextWindowPortOptions`). */
  readonly getActiveProviderId: () => string;
  /** MESMA resolução de peças concretas usada pelo `discoverContextWindow` — o
   * `persistContextWindow` do `ProviderDiscoveryDeps` é ignorado aqui (esta porta não
   * persiste nada, só lista nomes), reutilizamos o tipo p/ o CHAMADOR poder passar a
   * MESMA função `depsForProvider` das duas portas sem duplicar a resolução. */
  readonly depsForProvider: (providerId: string) => ProviderDiscoveryDeps;
}

/**
 * F-MODEL-LIVE — versão de `listModelNames` que segue o PROVIDER ATIVO da sessão (não o
 * congelado no boot), MESMA forma de `createProviderAwareDiscoverContextWindowPort`: uma
 * porta `createListModelNamesPort` por-provider, MEMOIZADA (Map por `providerId`) — a
 * cada CHAMADA (não na construção) o provider ATIVO é relido via `getActiveProviderId()`.
 * Um provider trocado via `/provider` no meio da sessão já lista os modelos DELE na
 * próxima abertura do picker, nunca os do provider anterior.
 */
export function createProviderAwareListModelNamesPort(
  opts: ProviderAwareListModelNamesPortOptions,
): () => Promise<ListModelNamesResult> {
  const portsByProvider = new Map<string, () => Promise<ListModelNamesResult>>();
  const portFor = (providerId: string): (() => Promise<ListModelNamesResult>) => {
    const cached = portsByProvider.get(providerId);
    if (cached !== undefined) return cached;
    const deps = opts.depsForProvider(providerId);
    const built = createListModelNamesPort({
      wireFormat: deps.wireFormat,
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl,
      getKey: deps.getKey,
    });
    portsByProvider.set(providerId, built);
    return built;
  };
  return (): Promise<ListModelNamesResult> => portFor(opts.getActiveProviderId())();
}
