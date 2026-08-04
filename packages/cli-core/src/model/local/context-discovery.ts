// F-WIN (descoberta) — PARSE PURO do `GET {baseUrl}/models` de um provider BYO
// OpenAI-compatible, p/ DESCOBRIR a JANELA DE CONTEXTO de um slug sem o usuário
// digitar o número.
//
// O BURACO que isto fecha: a janela por-modelo (`providers[].contextByModel`) já é
// LIDA por todo o caminho a jusante (`modelWindowFromConfig` → `resolveContextWindow`
// → `contextWindow` do controller → `⛁ %` + auto-compactação), mas NINGUÉM a
// ESCREVIA — o dono tinha que descobrir o número na doc do provider e editar o
// `~/.aluy/config.json` na mão. Sem isso a janela fica 0 ⇒ `⛁ %` congelado e
// auto-compactação INERTE (`decideAutoCompact` sai em `contextWindow <= 0`) — sessão
// longa sem rede de segurança, exatamente a dor do dogfood. Muitos agregadores
// OpenAI-compat (OpenRouter, Together, vLLM, LM Studio…) JÁ carregam o `context_length`
// de cada modelo na lista `/models`. Este módulo é o tradutor daquele corpo.
//
// ⚠ MAS NEM TODOS — e isto NÃO é uma falha a consertar aqui. Verificado em campo
// (rc.108): o `GET https://api.tokenrouter.com/v1/models` responde 200 com 19 modelos
// e NENHUM campo de janela (só `id`/`object`/`created`/`owned_by`/`supported_endpoint_
// types`/`tags`) — nem no `/api/pricing`, nem em header de resposta. É o formato MÍNIMO
// que a spec da OpenAI permite. Para um provider assim a descoberta é estruturalmente
// impossível e sai `[]` por projeto (fail-open); quem AVISA o dono de que ele precisa
// declarar o número à mão é o `run.tsx` (nota `janela`), não este parse — aqui não há
// palpite a dar. Não adianta somar campos novos ao `CONTEXT_FIELDS` abaixo: o provider
// não manda campo NENHUM.
//
// PORTÁVEL/PURO (fronteira ADR-0053 §8): SÓ tipos + parse de um `unknown` já lido.
// Nenhum `fetch`/`node:*`/keychain aqui — o I/O CONCRETO (fetch PINADO anti-SSRF
// EST-1115, credencial do keychain, persistência no `~/.aluy/config.json`) mora no
// pacote `@hiperplano/aluy-cli` (`model/local/context-window-discovery.ts`), mesma
// divisão de `catalog.ts` (dado puro) × `config.ts` (load do JSON).
//
// DADO_NÃO_CONFIÁVEL: o corpo vem da REDE, de um provider que o usuário escolheu mas
// que não auditamos. O parse NUNCA lança, IGNORA entrada malformada, DESCARTA todo
// campo que não seja `id`/janela (um provider comprometido mandando `api_key_ref`/
// `base_url` não atravessa nada p/ o config) e recusa número IMPLAUSÍVEL (ver
// `isPlausibleContextWindow` — um `context_length: 1` transformaria a auto-compactação
// num loop infinito, e um `1e18` a desligaria na prática).

/** Uma janela DESCOBERTA p/ um slug — o par mínimo que o config precisa. */
export interface DiscoveredModelContext {
  /** Slug EXATO como o provider o reporta (`id` da entrada) — a chave de `contextByModel`. */
  readonly slug: string;
  /** Janela em TOKENS, já normalizada e validada por `isPlausibleContextWindow`. */
  readonly context: number;
}

/**
 * Piso PLAUSÍVEL de janela (tokens). Um provider que reporta `context_length: 1`/`0`
 * (campo placeholder, modelo de embedding, bug do agregador) NÃO pode virar denominador:
 * a auto-compactação dispararia a cada turno (85% de 1024 é ~870 tokens — o system prompt
 * sozinho já estoura) e a sessão entraria em loop de compactação. Abaixo disto ⇒ tratamos
 * como "não descoberto" (fail-open, cai no 0/inerte de sempre — o fail-safe conhecido).
 */
export const MIN_PLAUSIBLE_CONTEXT_TOKENS = 1024;

/**
 * Teto PLAUSÍVEL de janela (tokens). Cobre com folga o maior modelo real anunciado
 * (10M do Llama 4 Scout) e barra o absurdo (`1e18`, `Number.MAX_SAFE_INTEGER`, unidade
 * trocada p/ BYTES por um agregador): uma janela gigante DESLIGA a auto-compactação na
 * prática (nunca chega a 85%) — o mesmo estrago do 0, só que silencioso e persistido no
 * config. Acima disto ⇒ "não descoberto" (fail-open).
 */
export const MAX_PLAUSIBLE_CONTEXT_TOKENS = 10_000_000;

/**
 * Teto de ENTRADAS lidas de um corpo `/models`. OpenRouter já lista ~400 modelos; um
 * corpo adulterado com 10^6 entradas viraria memória/CPU à toa no boot. Passado o teto,
 * paramos de acumular (o que já casou vale — não invalidamos a descoberta por causa do
 * excesso). Anti-runaway, espelhando a disciplina de tetos do ADR-0153.
 */
export const MAX_MODELS_PARSED = 2048;

/**
 * `true` se `n` é uma janela de contexto que faz sentido usar como DENOMINADOR real
 * (inteiro dentro de [MIN, MAX]). PURA — é o gatekeeper único entre o número que veio
 * da REDE e o número que vai ao `contextByModel`/`contextWindow`. Ver o PORQUÊ dos dois
 * limites nas constantes acima (piso: loop de compactação; teto: compactação desligada).
 */
export function isPlausibleContextWindow(n: number): boolean {
  return (
    Number.isInteger(n) && n >= MIN_PLAUSIBLE_CONTEXT_TOKENS && n <= MAX_PLAUSIBLE_CONTEXT_TOKENS
  );
}

/**
 * Normaliza o valor CRU de janela de uma entrada `/models` p/ TOKENS.
 *
 * Aceita as duas formas que os providers usam na prática:
 *   • NÚMERO (`131072`, `200000`) — o formato de `context_length`/`max_model_len`;
 *     um float (`131072.0`, comum em JSON de Python) é truncado p/ inteiro.
 *   • STRING (`"131072"`, `"128k"`, `"1M"`) — o formato de display que alguns
 *     agregadores repetem no `context` (MESMA gramática do `parseContextWindow` do
 *     pacote `cli`, que já lê `128k`/`200000`/`1M` do catálogo do broker; replicada
 *     aqui — e não importada — porque o core NÃO PODE depender do `cli` (a seta da
 *     dependência é `cli → cli-core`, fronteira ADR-0053 §8).
 *
 * Qualquer outra coisa (bool, objeto, `null`, `"unknown"`, negativo, NaN, Infinity) ⇒
 * `0` = "não informado". NUNCA lança (DADO_NÃO_CONFIÁVEL). Não aplica os limites de
 * plausibilidade — isso é do `isPlausibleContextWindow` (separado p/ o parse continuar
 * honesto sobre o que o provider DISSE).
 */
export function parseContextTokens(raw: unknown): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.floor(raw);
  }
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(trimmed);
  if (match === null) return 0;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const suffix = match[2].toLowerCase();
  if (suffix === 'k') return Math.floor(num * 1000);
  if (suffix === 'm') return Math.floor(num * 1_000_000);
  return Math.floor(num);
}

/**
 * CAMPOS de janela reconhecidos numa entrada de `/models`, EM ORDEM DE PRECEDÊNCIA. A
 * spec da OpenAI NÃO obriga nenhum deles (o `/models` dela devolve só
 * `id`/`object`/`created`/`owned_by`) — cada agregador inventou o seu, e é por isso que
 * a descoberta é BEST-EFFORT por natureza:
 *   • `context_length` — OpenRouter e a maioria dos agregadores (TokenRouter, Together).
 *   • `context_window` — Groq/alguns gateways.
 *   • `max_context_length` — llama.cpp server / KoboldCpp.
 *   • `max_model_len` — vLLM (`/v1/models` do OpenAI-compat server dele).
 *   • `context` — formato de DISPLAY (`"128k"`), o mesmo do catálogo do broker.
 * O aninhado `top_provider.context_length` (OpenRouter, a janela REAL do provider
 * roteado, que pode ser MENOR que a nominal) é tratado à parte em `contextFromEntry`.
 */
const CONTEXT_FIELDS: readonly string[] = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_model_len',
  'context',
];

/**
 * Extrai a janela (tokens) de UMA entrada de `/models`, ou `0` se ela não informa
 * nenhum dos campos conhecidos. PURA/exportada p/ teste.
 *
 * O `top_provider.context_length` do OpenRouter, quando presente e MENOR que a janela
 * nominal, VENCE: é a janela que o provider roteado de fato aceita, e o menor é o
 * denominador SEGURO (dimensionar a compactação pela nominal maior estouraria a janela
 * real ⇒ 400 do provider no meio da sessão, o estrago que a auto-compactação existe p/
 * evitar). Nunca usamos o MAIOR — conservador por construção.
 */
export function contextFromEntry(entry: unknown): number {
  if (!isRecord(entry)) return 0;
  let best = 0;
  for (const field of CONTEXT_FIELDS) {
    const n = parseContextTokens(entry[field]);
    if (n > 0) {
      best = n;
      break; // precedência: o 1º campo conhecido que informa algo manda.
    }
  }
  const top = entry['top_provider'];
  if (isRecord(top)) {
    const nested = parseContextTokens(top['context_length']);
    // Só REBAIXA (nunca sobe): a janela efetiva do provider roteado é o teto real.
    if (nested > 0 && (best === 0 || nested < best)) best = nested;
  }
  return best;
}

/**
 * Saneia o corpo do `GET {baseUrl}/models` em pares `{slug, context}` PLAUSÍVEIS.
 *
 * Aceita as duas formas de envelope vistas em campo: `{ "object":"list", "data":[…] }`
 * (OpenAI-compat canônico) e um ARRAY cru no topo (alguns servers locais). Cada entrada
 * precisa de um `id` string não-vazio (é a CHAVE de `contextByModel`; sem ele a entrada
 * é inútil) e de uma janela PLAUSÍVEL — entradas sem janela são simplesmente OMITIDAS
 * (o provider não informa ⇒ não descobrimos, fail-open, jamais um chute). Dedup por
 * slug (primeira ocorrência vence). NUNCA lança; corpo inválido ⇒ `[]`.
 *
 * Defesa-em-profundidade (HG-2/CLI-SEC-7): copia SÓ `id` + o número. Nenhum outro campo
 * do provider atravessa p/ o config do usuário.
 */
export function parseModelsListContexts(body: unknown): readonly DiscoveredModelContext[] {
  const data = Array.isArray(body) ? body : isRecord(body) ? body['data'] : undefined;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModelContext[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const raw of data) {
    if (scanned >= MAX_MODELS_PARSED) break; // anti-runaway (corpo absurdo)
    scanned += 1;
    if (!isRecord(raw)) continue;
    const idRaw = raw['id'];
    const slug = typeof idRaw === 'string' ? idRaw.trim() : '';
    if (slug === '') continue;
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const context = contextFromEntry(raw);
    // Janela ausente OU implausível ⇒ a entrada NÃO entra: melhor não descobrir nada
    // do que persistir um denominador que quebraria a auto-compactação (ver constantes).
    if (!isPlausibleContextWindow(context)) continue;
    out.push({ slug, context });
  }
  return out;
}

/**
 * F-MODEL-LIVE — saneia o corpo do `GET {baseUrl}/models` em SLUGS (só o `id`), SEM
 * exigir janela de contexto. É o irmão de `parseModelsListContexts` p/ um consumidor
 * diferente: o `/model` (picker) precisa listar TODO modelo que o provider anuncia —
 * inclusive os que não informam `context_length` nenhum (o caso do TokenRouter, ver o
 * comentário de topo do arquivo: 19 modelos, NENHUM campo de janela). Se este parse
 * também exigisse janela plausível, um provider assim listaria ZERO modelos no
 * picker — o MESMO buraco que motivou a descoberta dinâmica, só que pro nome em vez
 * do número.
 *
 * MESMA tolerância a DADO_NÃO_CONFIÁVEL de `parseModelsListContexts`: aceita os dois
 * envelopes (`{data:[…]}` e array cru), NUNCA lança, dedup por slug (case-insensitive,
 * 1ª ocorrência vence), teto de `MAX_MODELS_PARSED` entradas lidas (anti-runaway).
 */
export function parseModelsListSlugs(body: unknown): readonly string[] {
  const data = Array.isArray(body) ? body : isRecord(body) ? body['data'] : undefined;
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const raw of data) {
    if (scanned >= MAX_MODELS_PARSED) break; // anti-runaway (corpo absurdo)
    scanned += 1;
    if (!isRecord(raw)) continue;
    const idRaw = raw['id'];
    const slug = typeof idRaw === 'string' ? idRaw.trim() : '';
    if (slug === '') continue;
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slug);
  }
  return out;
}

/**
 * Acha a janela de UM slug na lista já parseada. Casa case-insensitive e ignorando
 * espaço nas pontas (os slugs viajam como `vendor/modelo` e o config do dono pode ter
 * capitalização diferente da do provider) — MESMA disciplina de casamento do
 * `modelWindowFromConfig`, p/ que "descobriu" e "acha depois no config" nunca divirjam.
 * Sem casamento ⇒ `undefined` (fail-open, nunca um vizinho parecido).
 */
export function findModelContext(
  list: readonly DiscoveredModelContext[],
  slug: string,
): number | undefined {
  const wanted = slug.trim().toLowerCase();
  if (wanted === '') return undefined;
  for (const e of list) {
    if (e.slug.trim().toLowerCase() === wanted) return e.context;
  }
  return undefined;
}

/** Narrowing de fronteira (a rede é `unknown`; sem `any`). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
