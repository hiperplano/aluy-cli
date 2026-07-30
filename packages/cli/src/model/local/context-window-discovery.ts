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
 * Lê `GET {baseUrl}/models` e devolve os pares `{slug, context}` que o provider
 * informou. NUNCA lança: qualquer falha (rede, timeout, 401/404, corpo não-JSON,
 * redirect BLOQUEADO pelo fetch pinado) ⇒ `[]` = "não descobrimos nada".
 *
 * SÓ para `openai-compat`. O `wireFormat` `anthropic` também tem `/v1/models`, mas ele
 * NÃO devolve janela de contexto (só `id`/`display_name`/`created_at`) — pingá-lo seria
 * uma chamada garantidamente inútil; `gemini` não fala este dialeto. Nos dois casos
 * saímos ANTES da rede.
 *
 * `{base}/models` (e não `/v1/models`) porque o `baseUrl` do catálogo BYO já inclui o
 * `/v1` quando o provider o usa — é a MESMA composição do `checkModelConnectivity`
 * (`${base}/chat/completions`), então um provider que funciona p/ chat funciona aqui.
 */
export async function fetchModelsContexts(
  args: FetchModelsContextsArgs,
): Promise<readonly DiscoveredModelContext[]> {
  if (args.wireFormat !== 'openai-compat') return [];
  const base = args.baseUrl.replace(/\/+$/, '');
  if (base === '') return [];
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
    if (!res.ok) return []; // 401/404/5xx ⇒ não descobrimos. Sem nota, sem erro (fail-open).
    const text = await res.text();
    if (text.length > MAX_MODELS_BODY_CHARS) return [];
    const body: unknown = JSON.parse(text);
    return parseModelsListContexts(body);
  } catch {
    // Rede/timeout/JSON inválido/egress recusado pelo anti-SSRF. NUNCA interpolamos a
    // exceção em lugar nenhum: a mensagem do fetch pinado carrega host/`location`
    // (vetor de SSRF/vazamento) e a do transporte pode ecoar a URL com credencial.
    return [];
  } finally {
    clearTimeout(timer);
  }
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
