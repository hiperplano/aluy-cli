// F-SALDO-BYO — SALDO/CONSUMO da PRÓPRIA conta no gateway BYO, p/ o rodapé mostrar sob
// backend LOCAL. Fecha o buraco do relato do dono: ele carregou crédito no gateway
// dele e o `aluy` não mostrava NADA — porque `quotaFetcher` (`session/wiring.ts`) é
// montado a partir do `quotaClient` do BROKER (EST-0948/ADR-0069); sob backend LOCAL
// não existe ESSA fonte. O `◔ sessão` que aparece ali é a contagem de TOKENS desta
// sessão — não é saldo de conta nenhuma.
//
// ─────────────────────────────────────────────────────────────────────────────
// NÃO HÁ PADRÃO (medido, não suposto): cada gateway BYO expõe saldo do seu jeito, e o
// caminho "óbvio" às vezes nem funciona:
//
//   • família one-api/new-api (o gateway do dono é um): `GET /api/user/self` devolve
//     `{quota,...}`, mas exige TOKEN DE SESSÃO — com a API key (`sk-...`) devolve
//     `401 {"message":"Session validation failed. Please log in again.","success":
//     false}` (MEDIDO ao vivo contra `api.tokenrouter.com`, corpo real capturado em
//     `tests/model/local/fixtures/balance/`). A API key NÃO abre essa porta.
//
//   • MEDIDO no MESMO gateway, com a MESMA API key: o dialeto de billing LEGADO da
//     OpenAI (`GET /v1/dashboard/billing/subscription` + `GET
//     /v1/dashboard/billing/usage`) FUNCIONA — `200` nos dois, direto com a API key,
//     sem sessão. Muito gateway self-hosted "OpenAI-compatible" (não só one-api/
//     new-api) replica esse par por compatibilidade com ferramentas antigas que o
//     consultavam. `subscription.hard_limit_usd` = teto em USD; `usage.total_usage` =
//     consumido, na CONVENÇÃO da API legada da OpenAI (CENTAVOS de USD — replicada por
//     dezenas de bibliotecas de terceiros da época; não pude CONFIRMAR a escala ao
//     vivo porque a conta medida está com `total_usage:0`, então a divisão por 100 é
//     inferência de convenção documentada, não medição direta — sinalizado aqui e no
//     relato p/ quem for revisar).
//
//   • OpenRouter: `GET /api/v1/credits` devolve `{data:{total_credits,total_usage}}`
//     (crédito da CONTA, em USD) — MEDIDO ao vivo, `200` direto com a API key.
// ─────────────────────────────────────────────────────────────────────────────
//
// POR ISSO o desenho é DETECÇÃO POR TENTATIVA: uma lista de "dialetos" (uma função por
// formato conhecido), tentados EM ORDEM; o primeiro que devolver algo aproveitável
// vence. NENHUM dialeto sabe do outro. Um gateway novo, desconhecido, sem NENHUM dos
// dois formatos ⇒ `undefined` — DEGRADAÇÃO SILENCIOSA, zero nota, zero erro na tela,
// EXATAMENTE como o rodapé já se comporta quando o broker não reporta quota
// (`QuotaFooter.tsx`: "sem fonte ⇒ não renderiza"). Este módulo NUNCA promete: só
// mostra o que MEDIU.
//
// PURO na parte de PARSE (`parse*`/`combine*` — só JSON→dado, testável com o corpo
// REAL capturado, sem rede); I/O ISOLADO nas funções de tentativa (`*Dialect` e
// `fetchBalanceJson`) — só elas tocam `fetchImpl`.
//
// TRAVAS (mesma disciplina de `context-window-discovery.ts`/`connectivity-check.ts`):
//   • fetch PINADO anti-SSRF (`createPinnedStreamFetch`, EST-1115) OBRIGATÓRIO — este
//     módulo NUNCA toca `globalThis.fetch`; o egress é p/ um host que vem de DADO de
//     config (o `baseUrl` do provider BYO), o MESMO vetor de metadata-da-cloud do
//     resto do backend local.
//   • timeout CURTO (default `DEFAULT_BALANCE_TIMEOUT_MS`, menor que o de descoberta
//     de janela — isto é enfeite de rodapé, não caminho crítico) + teto de corpo
//     (`MAX_BALANCE_BODY_CHARS`).
//   • `createDiscoverBalancePort` MEMOIZA (no máximo 1 chamada de rede por dialeto por
//     PORTA — "1x por sessão"; um `cacheMs` opcional permite refrescar de minutos em
//     minutos em vez de nunca).
//   • CLI-SEC-10 — a credencial NUNCA é logada/ecoada/interpolada em mensagem
//     nenhuma: toda falha (rede, timeout, 401, corpo estranho, `getKey` que lança)
//     é ENGOLIDA aqui dentro e vira `undefined` — nunca um `Error` relançado com
//     `message` que poderia carregar host/corpo/credencial. O CHAMADOR só recebe
//     dado ou nada; nunca uma exceção deste módulo.

import type { ConnectivityFetch } from './connectivity-check.js';
import { descartarCorpo } from './descartar-corpo.js';

/**
 * O saldo restante da conta no gateway BYO, já num formato que o rodapé consegue
 * pintar em poucas colunas (ex.: `crédito: 50 USD`) — espelha o `ServerLimitSegment`
 * do broker (`value`/rótulo próprios). `remaining` já vem FORMATADO (sem casas
 * decimais espúrias de float — `formatBalanceAmount`); `unit` é o rótulo curto da
 * moeda/unidade (`"USD"` nos dois dialetos de hoje). Ausência do tipo inteiro
 * (`LocalBalance | undefined`) é o sinal de degradação — NUNCA um valor inventado.
 */
export interface LocalBalance {
  /** Saldo restante já formatado (`"50"`, `"4.3"`, `"99.59"`). */
  readonly remaining: string;
  /** Unidade do saldo (`"USD"`…). Ausente ⇒ o chamador mostra só o número. */
  readonly unit?: string;
}

/** Peças de I/O que um dialeto precisa p/ tentar ler o saldo de UM provider. */
export interface BalanceIoDeps {
  /**
   * `WireFormat` do provider ATIVO. Só `'openai-compat'` tem os dois dialetos
   * conhecidos hoje (o próprio `/v1/dashboard/billing/*` e o `/api/v1/credits` do
   * OpenRouter são convenções do mundo openai-compat); outro wireFormat ⇒ nenhum
   * dialeto sequer tenta a rede (mesma guarda de `fetchModelsContexts`).
   */
  readonly wireFormat: string;
  /** `base_url` do provider ATIVO, já resolvido (override OU default do catálogo). */
  readonly baseUrl: string;
  /** Credencial já resolvida (keychain→cofre→env). `''` (auth:'none') ⇒ sem header. */
  readonly key: string;
  /** Fetch PINADO anti-SSRF (EST-1115). OBRIGATÓRIO — nunca `globalThis.fetch`. */
  readonly fetchImpl: ConnectivityFetch;
  /** Timeout em ms POR TENTATIVA de rede (default `DEFAULT_BALANCE_TIMEOUT_MS`). */
  readonly timeoutMs?: number;
}

/** Um "dialeto": tenta ler o saldo de UM formato conhecido. `undefined` ⇒ não é este. */
export type BalanceDialect = (deps: BalanceIoDeps) => Promise<LocalBalance | undefined>;

/** Timeout curto de propósito — enfeite de rodapé, não caminho crítico. */
export const DEFAULT_BALANCE_TIMEOUT_MS = 5_000;

/** Teto do corpo lido, em chars — os dois dialetos conhecidos respondem corpos pequenos
 * (dezenas/centenas de bytes); um corpo muito maior é anômalo (endpoint errado
 * devolvendo outra coisa) e não vale o `JSON.parse` num caminho de enfeite. */
export const MAX_BALANCE_BODY_CHARS = 262_144;

// ── parse PURO (JSON→dado; testável com corpo REAL capturado, sem rede) ──────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Número finito ≥ 0 a partir de string/número. `undefined` se ausente/inválido/negativo. */
function toFiniteNonNeg(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Formata o saldo p/ exibição — MESMA convenção de `formatBalance` (server-limits.ts,
 * broker): sem casas decimais espúrias de float, no máx. 2 casas.
 */
export function formatBalanceAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * `GET /v1/dashboard/billing/subscription` (dialeto de billing LEGADO da OpenAI,
 * replicado por gateways self-hosted p/ compat) → o TETO em USD (`hard_limit_usd`).
 * MEDIDO ao vivo (`api.tokenrouter.com`, corpo real em
 * `fixtures/balance/tokenrouter-billing-subscription.json`): `{"object":
 * "billing_subscription","has_payment_method":true,"soft_limit_usd":50,
 * "hard_limit_usd":50,"system_hard_limit_usd":50,"access_until":0}`.
 * Tolerante: corpo não-objeto, campo ausente/não-numérico/negativo ⇒ `undefined`.
 */
export function parseOpenAiCompatBillingSubscription(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined;
  return toFiniteNonNeg(body['hard_limit_usd']);
}

/**
 * `GET /v1/dashboard/billing/usage` → o CONSUMIDO, em USD (o campo `total_usage` da
 * API legada da OpenAI vem em CENTAVOS — convenção documentada/replicada por várias
 * bibliotecas de terceiros da época; NÃO confirmada ao vivo aqui porque a conta medida
 * tem `total_usage:0` — zero não distingue escala. Sinalizado no cabeçalho do módulo).
 * MEDIDO ao vivo (corpo real em `fixtures/balance/tokenrouter-billing-usage.json`):
 * `{"object":"list","total_usage":0}`. Ausente/inválido ⇒ `undefined` (o combinador
 * trata como "consumo desconhecido", não como "zero" — ver `combineOpenAiCompatBilling`).
 */
export function parseOpenAiCompatBillingUsage(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined;
  const cents = toFiniteNonNeg(body['total_usage']);
  return cents === undefined ? undefined : cents / 100;
}

/**
 * Combina teto + consumo do dialeto de billing legado num `LocalBalance`. `limitUsd`
 * ausente ⇒ `undefined` (sem teto não há saldo a mostrar — degrada). `usageUsd`
 * ausente (usage não leu, MAS subscription leu) ⇒ trata como 0 consumido: mostrar o
 * TETO como saldo é mais honesto que esconder o widget inteiro por causa da 2ª
 * chamada (o dono já teria a resposta certa se nunca consumiu nada). `remaining`
 * nunca fica negativo (consumo > teto ⇒ satura em 0).
 */
export function combineOpenAiCompatBilling(
  limitUsd: number | undefined,
  usageUsd: number | undefined,
): LocalBalance | undefined {
  if (limitUsd === undefined) return undefined;
  const remaining = Math.max(0, limitUsd - (usageUsd ?? 0));
  return { remaining: formatBalanceAmount(remaining), unit: 'USD' };
}

/**
 * `GET /api/v1/credits` (OpenRouter) → `{data:{total_credits,total_usage}}`, os dois
 * em USD (crédito da CONTA — moeda literal do OpenRouter, 1 crédito = US$1). MEDIDO ao
 * vivo (corpo real em `fixtures/balance/openrouter-credits.json`):
 * `{"data":{"total_credits":105,"total_usage":100.697326477}}` → saldo 4.3 USD.
 * `total_usage` ausente ⇒ trata como 0 (mesma lógica de `combineOpenAiCompatBilling`).
 * `total_credits` ausente/corpo estranho ⇒ `undefined`. `remaining` nunca negativo.
 */
export function parseOpenRouterCredits(body: unknown): LocalBalance | undefined {
  if (!isRecord(body)) return undefined;
  const data = body['data'];
  if (!isRecord(data)) return undefined;
  const total = toFiniteNonNeg(data['total_credits']);
  if (total === undefined) return undefined;
  const usage = toFiniteNonNeg(data['total_usage']) ?? 0;
  const remaining = Math.max(0, total - usage);
  return { remaining: formatBalanceAmount(remaining), unit: 'USD' };
}

// ── I/O isolado (só estas funções tocam `fetchImpl`) ──────────────────────────────

/**
 * `GET {baseUrl}{path}` com timeout + teto de corpo + `JSON.parse`. NUNCA lança:
 * qualquer falha (rede, timeout, redirect bloqueado pelo anti-SSRF, não-2xx, corpo
 * não-JSON/grande demais) ⇒ `undefined`. A credencial só entra no header
 * `authorization` (nunca na URL/corpo) e nunca é interpolada em mensagem alguma —
 * falhas são ENGOLIDAS aqui, nunca relançadas (CLI-SEC-10).
 */
async function fetchBalanceJson(
  deps: BalanceIoDeps,
  path: string,
): Promise<unknown> {
  const base = deps.baseUrl.replace(/\/+$/, '');
  if (base === '') return undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? DEFAULT_BALANCE_TIMEOUT_MS);
  try {
    const res = await deps.fetchImpl(`${base}${path}`, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        ...(deps.key !== '' ? { authorization: `Bearer ${deps.key}` } : {}),
      },
      // SEM `body`: GET com body (mesmo `''`) faz o fetch do Node LANÇAR antes da rede.
    });
    if (!res.ok) {
      // SAÍDA EM 2 CTRL-C — sair daqui sem tocar no corpo era o que segurava o processo:
      // o `/credits` do tokenrouter responde 404 e a `IncomingMessage` do fetch pinado
      // ficava pendurada, com o socket preso ao laço de eventos até o cão de guarda de 2s
      // do `run.tsx` matar tudo à força. Ver `descartar-corpo.ts` p/ a medição.
      descartarCorpo(res);
      return undefined;
    }
    const text = await res.text();
    if (text.length > MAX_BALANCE_BODY_CHARS) return undefined;
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dialeto 1 — billing LEGADO da OpenAI (`/v1/dashboard/billing/subscription` +
 * `/v1/dashboard/billing/usage`). Duas chamadas SEQUENCIAIS (a 2ª só roda se a 1ª
 * achou um teto — sem teto não há o que combinar, poupa a 2ª chamada). Só
 * `openai-compat` (guarda ANTES da rede, mesma disciplina de `fetchModelsContexts`).
 */
export const openAiCompatBillingDialect: BalanceDialect = async (deps) => {
  if (deps.wireFormat !== 'openai-compat') return undefined;
  const subBody = await fetchBalanceJson(deps, '/dashboard/billing/subscription');
  const limitUsd = parseOpenAiCompatBillingSubscription(subBody);
  if (limitUsd === undefined) return undefined;
  const usageBody = await fetchBalanceJson(deps, '/dashboard/billing/usage');
  const usageUsd = parseOpenAiCompatBillingUsage(usageBody);
  return combineOpenAiCompatBilling(limitUsd, usageUsd);
};

/** Dialeto 2 — crédito de conta do OpenRouter (`/credits`). Só `openai-compat`. */
export const openRouterCreditsDialect: BalanceDialect = async (deps) => {
  if (deps.wireFormat !== 'openai-compat') return undefined;
  const body = await fetchBalanceJson(deps, '/credits');
  return parseOpenRouterCredits(body);
};

/** Ordem de tentativa default: billing legado primeiro (mais comum entre gateways
 * self-hosted genéricos), OpenRouter por último (um único provider conhecido). */
/**
 * F-SALDO-SO-OPENROUTER (decisão do dono, e ele estava certo) — só o dialeto do
 * OpenRouter fica LIGADO por padrão.
 *
 * O que ele viu: "os créditos restantes não estão aparecendo corretamente... isso varia
 * de provedor para provedor, não? se variar, então não precisa dessa informação, só para
 * o OpenRouter".
 *
 * E o defeito era pior que variação: o `openAiCompatBillingDialect` vinha PRIMEIRO e lê
 * `hard_limit_usd` — que é o TETO configurado da conta, não o saldo. Num gateway que
 * responde os dois endpoints, ele ganhava do dialeto certo e pintava um número que NÃO é
 * saldo. Saldo errado é pior que saldo ausente: um número na tela é usado para decidir.
 *
 * O `/api/v1/credits` do OpenRouter é API OFICIAL e devolve o par exato
 * (`total_credits` − `total_usage`); é o único em que a conta fecha. O dialeto legado
 * CONTINUA no módulo e testado — quem quiser habilitá-lo passa a lista explicitamente —,
 * mas não sai adivinhando saldo de gateway genérico por conta própria.
 */
export const DEFAULT_BALANCE_DIALECTS: readonly BalanceDialect[] = [openRouterCreditsDialect];

/** A lista COMPLETA, incluindo o dialeto legado — opt-in explícito (ver acima). */
export const ALL_BALANCE_DIALECTS: readonly BalanceDialect[] = [
  openRouterCreditsDialect,
  openAiCompatBillingDialect,
];

/**
 * Tenta cada dialeto EM ORDEM; devolve o primeiro `LocalBalance` achado. NENHUM
 * dialeto sabe do outro — um gateway que não bate com NENHUM formato conhecido ⇒
 * `undefined` (degrada silencioso, zero nota). NUNCA lança (cada dialeto já engole
 * sua própria falha; o `try` aqui é só uma 2ª rede de segurança caso um dialeto
 * futuro esqueça de engolir algo).
 */
export async function discoverBalance(
  deps: BalanceIoDeps,
  dialects: readonly BalanceDialect[] = DEFAULT_BALANCE_DIALECTS,
): Promise<LocalBalance | undefined> {
  for (const dialect of dialects) {
    try {
      const found = await dialect(deps);
      if (found !== undefined) return found;
    } catch {
      // Rede de segurança — nunca deveria disparar (todo dialeto engole sua falha).
      continue;
    }
  }
  return undefined;
}

export interface CreateDiscoverBalancePortOptions extends Omit<BalanceIoDeps, 'key'> {
  /** Credencial resolvida A CADA chamada (keychain/cofre/env rotacionam) — MESMO
   * padrão de `getKey` em `context-window-discovery.ts`. Pode LANÇAR (ex.:
   * `MissingLocalCredentialError`) — capturado aqui, nunca propagado. */
  readonly getKey: () => Promise<string>;
  readonly dialects?: readonly BalanceDialect[];
  /**
   * Cache em ms: uma nova tentativa de rede só roda depois que o cache expira.
   * Ausente ⇒ MEMOIZA p/ sempre (1 tentativa por PORTA — "no máximo 1x por sessão",
   * já que a porta vive a sessão inteira). Um resultado `undefined` (falhou/gateway
   * desconhecido) TAMBÉM é memoizado — não fica re-tentando a cada refresh do rodapé.
   */
  readonly cacheMs?: number;
  /** Relógio injetável p/ teste (default `Date.now`). Só usado quando `cacheMs` é dado. */
  readonly now?: () => number;
}

/**
 * Monta a porta `() => Promise<LocalBalance | undefined>` que o rodapé chamaria
 * (ponto de ligação FORA deste módulo — ver cabeçalho). MEMOIZA por padrão (nunca
 * mais de 1 chamada de rede por dialeto na vida da porta); com `cacheMs`, refresca
 * periodicamente em vez de nunca. NUNCA lança/rejeita.
 */
export function createDiscoverBalancePort(
  opts: CreateDiscoverBalancePortOptions,
): () => Promise<LocalBalance | undefined> {
  const now = opts.now ?? Date.now;
  let cached: Promise<LocalBalance | undefined> | undefined;
  let cachedAt = 0;

  return (): Promise<LocalBalance | undefined> => {
    const fresh =
      cached !== undefined && (opts.cacheMs === undefined || now() - cachedAt < opts.cacheMs);
    if (fresh) return cached as Promise<LocalBalance | undefined>;

    cachedAt = now();
    cached = (async (): Promise<LocalBalance | undefined> => {
      let key: string;
      try {
        key = await opts.getKey();
      } catch {
        // Sem credencial (keychain vazio/locked) ⇒ sem saldo a ler; degrada.
        return undefined;
      }
      try {
        return await discoverBalance(
          {
            wireFormat: opts.wireFormat,
            baseUrl: opts.baseUrl,
            key,
            fetchImpl: opts.fetchImpl,
            ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          },
          opts.dialects,
        );
      } catch {
        return undefined;
      }
    })();
    return cached;
  };
}
