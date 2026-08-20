// F-WIN (embutido) — CATÁLOGO ESTÁTICO de janelas de contexto PUBLICAMENTE conhecidas,
// casadas por FAMÍLIA de slug. Fecha o degrau que faltava na cadeia de descoberta de
// janela em BYO: `config declarado (contextByModel) → descoberta ao vivo (GET /models)
// → EMBUTIDO (este arquivo) → 0/inerte`.
//
// O BURACO: nem todo provider OpenAI-compat expõe `context_length`/`context_window`/…
// no `/models` (ver o comentário de topo de `context-discovery.ts` — TokenRouter
// responde 200 com só `id`/`object`/`created`/`owned_by`/`supported_endpoint_types`/
// `tags`, NENHUM campo de janela, medido em campo em 127 modelos). Para um provider
// assim a descoberta É estruturalmente impossível — mas a janela do MODELO em si não é
// desconhecida: é DADO PÚBLICO (a doc do fabricante), só não viaja pela API daquele
// gateway específico. Antes deste módulo, o único jeito de fechar isso era o dono
// digitar o número à mão em `providers[].contextByModel`; a maioria não sabia que
// precisava (a mensagem do `run.tsx` avisa, mas só DEPOIS de rodar sem rede de
// segurança). Este catálogo elimina essa fricção p/ os slugs que reconhecemos.
//
// POSIÇÃO NA PRECEDÊNCIA (ver `resolveContextWindow` em `@hiperplano/aluy-cli/model/catalog.ts`):
// abaixo do que o dono DECLAROU à mão e abaixo do que a DESCOBERTA AO VIVO achou — o
// dono pode ter um motivo pra declarar um número diferente do nominal do fabricante
// (provider que corta a janela, proxy que trunca, teste deliberado) e isso NUNCA perde
// pra um chute embutido. Mas ACIMA do 0 puro: um slug RECONHECIDO não deveria deixar a
// auto-compactação inerte só porque o gateway específico não anuncia o campo.
//
// F134 (HUNT-COMPACT) — a decisão de que janela DESCONHECIDA desliga o size-aware do
// Compactor (em vez de chutar 200k) permanece INTOCADA: este módulo só resolve slugs
// que CASAM uma família catalogada. Slug fora do catálogo ⇒ `undefined` ⇒ a cadeia
// segue pro próximo degrau (hoje: 0). NUNCA um chute genérico tipo "modelo desconhecido
// = 200k" — isso é exatamente o que o F134 proibiu.
//
// VALORES: só entram números com fonte PÚBLICA razoavelmente confiável (doc do
// fabricante/anúncio de lançamento amplamente divulgado) ou já ESTABELECIDOS neste
// mesmo repo (`FALLBACK_CONTEXT_TOKENS` em `@hiperplano/aluy-cli/model/catalog.ts`, que
// documenta "Strata → 128k (DeepSeek V4 Pro principal)" e "Flui → 256k (DeepSeek V4
// Flash principal)" — reaproveitados aqui p/ os SLUGS crus do mesmo modelo, fora do
// contexto de tier). Um número ERRADO é PIOR que não ter número (trunca em silêncio ou
// compacta cedo demais) — famílias sem fonte confiável ficam DE FORA de propósito
// (ex.: nenhuma entrada Xiaomi/MiMo neste arquivo — sem fonte confiável o suficiente
// no momento da escrita; e Grok/GPT-5 idem, ausentes por incerteza, não por esquecimento).
//
// PORTÁVEL/PURO (fronteira ADR-0053 §8): zero import, zero rede, zero I/O. Só DADO +
// duas funções de casamento. Mora no `cli-core` (irmão de `context-discovery.ts`) pela
// MESMA razão: é o pedaço PORTÁVEL da janela de contexto — o pacote `cli` decide ONDE
// entra na precedência (`resolveContextWindow`), este módulo só responde "esta família
// de slug tem uma janela conhecida?".

/**
 * Janelas de contexto CONHECIDAS por FAMÍLIA canônica de slug (tokens). A chave é o
 * slug JÁ NORMALIZADO por `normalizeModelFamily` (sem vendor, sem sufixo de data,
 * lowercase) — casar um slug novo é adicionar UMA linha aqui, nunca um `if`/`switch`
 * novo. Famílias organizadas por fabricante; cada bloco cita a fonte da confiança.
 */
export const KNOWN_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  // ── DeepSeek ───────────────────────────────────────────────────────────────
  // v4-pro/v4-flash: MESMO número já usado neste repo p/ os tiers Strata/Flui
  // (`FALLBACK_CONTEXT_TOKENS` em `@hiperplano/aluy-cli/model/catalog.ts` — "Strata
  // (aluy-strata) → 128k (DeepSeek V4 Pro principal)" / "Flui (aluy-flux) → 256k
  // (DeepSeek V4 Flash principal)"). É o caso que motivou este módulo: o dono roda
  // `deepseek/deepseek-v4-pro-0813` em BYO e o gateway não anuncia `context_length`.
  'deepseek-v4-pro': 128_000,
  'deepseek-v4-flash': 256_000,
  // v3.x: janela publicada pela DeepSeek p/ `deepseek-chat`/`deepseek-reasoner`
  // (V3/V3.1/V3.2, mesma família de API) — 128k (131072) tokens.
  'deepseek-v3': 128_000,
  'deepseek-v3.1': 128_000,
  'deepseek-v3.2': 128_000,
  'deepseek-chat': 128_000,

  // ── Qwen (Alibaba) ─────────────────────────────────────────────────────────
  // Qwen2.5 e Qwen3: janela publicada de 128k (32k nativo + extensão YaRN, é o
  // número que a doc do fabricante anuncia como suportado e o que os providers
  // BYO expõem como `max_model_len`).
  'qwen2.5': 128_000,
  'qwen2.5-72b-instruct': 128_000,
  'qwen2.5-32b-instruct': 128_000,
  'qwen2.5-14b-instruct': 128_000,
  'qwen2.5-7b-instruct': 128_000,
  'qwen2.5-coder-32b-instruct': 128_000,
  qwen3: 128_000,
  'qwen3-32b': 128_000,
  'qwen3-14b': 128_000,
  'qwen3-8b': 128_000,
  // Variante explicitamente de contexto longo (branding próprio do fabricante).
  'qwen2.5-turbo': 1_000_000,

  // ── Anthropic Claude ───────────────────────────────────────────────────────
  // 200k é a janela PADRÃO publicada p/ toda a linha Claude 3/3.5/3.7/4/4.5 (a
  // janela estendida de 1M em alguns modelos é um BETA opt-in por header — usar
  // aqui o padrão é o valor SEGURO/conservador, nunca o beta).
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-7-sonnet': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-opus-4': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-haiku-4-5': 200_000,

  // ── OpenAI GPT ─────────────────────────────────────────────────────────────
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 1_000_000,
  'gpt-4.1-nano': 1_000_000,
  o1: 200_000,
  'o1-preview': 128_000,
  'o1-mini': 128_000,
  o3: 200_000,
  'o3-mini': 200_000,

  // ── Google Gemini ──────────────────────────────────────────────────────────
  'gemini-1.5-pro': 2_000_000,
  'gemini-1.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,

  // ── Meta Llama ─────────────────────────────────────────────────────────────
  'llama-3.1-8b': 128_000,
  'llama-3.1-70b': 128_000,
  'llama-3.1-405b': 128_000,
  'llama-3.2-1b': 128_000,
  'llama-3.2-3b': 128_000,
  'llama-3.2-11b': 128_000,
  'llama-3.2-90b': 128_000,
  'llama-4-scout': 10_000_000,
  'llama-4-maverick': 1_000_000,

  // ── Mistral ────────────────────────────────────────────────────────────────
  'mistral-large-2': 128_000,
  'mistral-large': 128_000,
};

/**
 * Normaliza um slug de modelo p/ a chave de FAMÍLIA que `KNOWN_MODEL_CONTEXT_WINDOWS`
 * usa: lowercase, sem prefixo de VENDOR (`vendor/modelo` → `modelo`) e sem sufixo de
 * DATA no fim (`-0813`, `-20241022`, `-2024-08-13`). É o que faz o MESMO modelo casar
 * como `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-pro-0813` e
 * `deepseek-v4-pro` — os providers variam se prefixam o vendor e se sufixam um
 * snapshot de data, o fabricante não muda.
 *
 * Conservador de propósito: NÃO mexe em números de versão (`gpt-4`, `qwen2.5`,
 * `llama-3.1`) nem em sufixos de tamanho (`-70b`, `-mini`) — só reconhece sufixo de
 * data (4, 6 ou 8 dígitos, ou `-AAAA-MM-DD` com traço). Um `if` genérico de "última
 * sequência numérica" apagaria a distinção entre `gpt-4` e `gpt-4o`/`gpt-3`; aqui só
 * o PADRÃO INEQUÍVOCO de data é removido.
 */
export function normalizeModelFamily(slug: string): string {
  let s = slug.trim().toLowerCase();
  const slashIdx = s.lastIndexOf('/');
  if (slashIdx >= 0) s = s.slice(slashIdx + 1);
  // Data ISO com traço: "-2024-08-13" (ano-mês-dia, cada grupo com 1-2 dígitos p/
  // mês/dia salvo casos sem zero à esquerda).
  s = s.replace(/-\d{4}-\d{1,2}-\d{1,2}$/, '');
  // Data compacta: 8 (AAAAMMDD), 6 (AAMMDD) ou 4 (MMDD) dígitos coladas no fim.
  s = s.replace(/-\d{8}$/, '');
  s = s.replace(/-\d{6}$/, '');
  s = s.replace(/-\d{4}$/, '');
  return s;
}

/**
 * Janela EMBUTIDA (conhecimento público) p/ um slug, ou `undefined` se a família não
 * é reconhecida. PURA/determinística — mesmo slug sempre devolve o mesmo número
 * (nenhuma dependência de rede/config/hora). `undefined`/vazio ⇒ `undefined` (nunca
 * lança). É a peça que `resolveContextWindow` consulta ABAIXO de declarado/descoberto
 * e ACIMA do fail-safe de `0` — ver o comentário de topo do arquivo.
 */
export function builtinContextWindowForSlug(slug: string | undefined): number | undefined {
  const raw = (slug ?? '').trim();
  if (raw === '') return undefined;
  const family = normalizeModelFamily(raw);
  if (family === '') return undefined;
  const window = KNOWN_MODEL_CONTEXT_WINDOWS[family];
  return window !== undefined && Number.isInteger(window) && window > 0 ? window : undefined;
}
