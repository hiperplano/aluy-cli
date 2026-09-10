// Os TOKENS REAPROVEITADOS do cache de prompt, normalizados entre dialetos.
//
// O dono perguntou em 10/09/2026: "a gente usa prompt caching?". A resposta honesta era
// "não sei" — líamos só `prompt_tokens`/`completion_tokens`, e nenhum dos campos que os
// providers usam para dizer quanto do prompt foi reaproveitado. Nos providers de cache
// IMPLÍCITO (DeepSeek, OpenAI, GLM…) ele quase certamente já estava acontecendo, sendo
// cobrado mais barato, e ninguém — nem ele, nem eu — tinha como ver.
//
// Isto é o oposto de um detalhe cosmético: sem o número, não dá para PROVAR que o
// `cache_control` que passamos a mandar teve efeito. A visibilidade vem antes do conserto
// porque é ela que torna o conserto verificável.
//
// TRÊS DIALETOS para o mesmo número:
//
//   OpenAI / OpenRouter   usage.prompt_tokens_details.cached_tokens
//   DeepSeek              usage.prompt_cache_hit_tokens  (+ ..._miss_tokens)
//   Anthropic             usage.cache_read_input_tokens  (+ cache_creation_input_tokens)
//
// PURO: objeto cru (não-confiável, vem da rede) → números. Nunca lança; campo que não
// casa o formato esperado é IGNORADO, nunca chutado.

/** O que se conseguiu ler do `usage` sobre cache. Campo ausente ⇒ o provider não reportou. */
export interface UsoDeCache {
  /** Tokens do prompt servidos do cache (não reprocessados). */
  readonly lidos?: number;
  /** Tokens GRAVADOS no cache nesta chamada (só dialeto explícito reporta). */
  readonly gravados?: number;
}

/** Número inteiro não-negativo, ou `undefined`. Rejeita `NaN`, negativo e não-número. */
function inteiro(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return Math.trunc(v);
}

function objeto(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Lê o uso de cache de um `usage` CRU, seja qual for o dialeto. PURO.
 *
 * Devolve `{}` quando o provider não reportou nada — que é DIFERENTE de reportar zero. A
 * distinção importa: zero significa "nada foi reaproveitado" (o cache existe e não pegou);
 * ausente significa "não dá para saber", e a UI precisa dizer coisas diferentes nos dois.
 */
export function lerUsoDeCache(raw: unknown): UsoDeCache {
  const u = objeto(raw);
  if (u === undefined) return {};

  // OpenAI/OpenRouter — aninhado em `prompt_tokens_details`.
  const detalhes = objeto(u.prompt_tokens_details);
  const openai = detalhes !== undefined ? inteiro(detalhes.cached_tokens) : undefined;

  // DeepSeek — plano, no topo do `usage`.
  const deepseek = inteiro(u.prompt_cache_hit_tokens);

  // Anthropic — plano, com um campo separado para a ESCRITA.
  const anthropicLido = inteiro(u.cache_read_input_tokens);
  const anthropicGravado = inteiro(u.cache_creation_input_tokens);

  const lidos = openai ?? deepseek ?? anthropicLido;
  const out: { lidos?: number; gravados?: number } = {};
  if (lidos !== undefined) out.lidos = lidos;
  if (anthropicGravado !== undefined) out.gravados = anthropicGravado;
  return out;
}

/**
 * A FRAÇÃO do prompt que veio do cache, em % inteiro. `undefined` quando não dá para
 * saber (provider não reportou, ou o prompt é vazio).
 *
 * É isto que vale a pena mostrar, não o número absoluto: "8.4k reaproveitados" não diz se
 * foi muito ou pouco sem o total ao lado.
 */
export function pctDeCache(
  tokensIn: number | undefined,
  lidos: number | undefined,
): number | undefined {
  if (lidos === undefined || tokensIn === undefined || tokensIn <= 0) return undefined;
  // O `cached` do dialeto OpenAI é um SUBCONJUNTO de `prompt_tokens`; o do Anthropic NÃO
  // (lá `input_tokens` já exclui o que veio do cache). Clampar em 100 cobre os dois sem
  // precisar saber qual dialeto respondeu — e sem nunca exibir "137% em cache".
  return Math.min(100, Math.round((lidos / tokensIn) * 100));
}

/**
 * DIAGNÓSTICO do cache — uma linha que diz o que o provider de fato mandou.
 *
 * Existe porque a pergunta "por que não aparece o cache?" tem pelo menos quatro respostas
 * (o provider não reporta; reporta e deu zero; não pedimos o detalhamento; o modelo não
 * cacheia), e sem o dado cru elas são indistinguíveis — foi exatamente onde eu fiquei em
 * 10/09 quando o dono disse "no windows não está aparecendo o cache". Chutar qual das
 * quatro é o defeito de silêncio ambíguo outra vez.
 *
 * PURO. Só METADADOS do `usage` — nunca conteúdo de prompt.
 */
export function diagnosticoDeCache(raw: unknown): string {
  const u = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
  if (u === undefined) return 'cache: o provider não mandou usage nenhum';
  const { lidos, gravados } = lerUsoDeCache(raw);
  if (lidos === undefined && gravados === undefined) {
    // Listar as CHAVES que vieram é o que distingue "não pedimos o detalhamento" de "este
    // provider não faz cache": num caso vem só o par de totais, no outro vêm outros campos.
    const chaves = Object.keys(u).sort().join(', ');
    return `cache: o provider NÃO reportou campo de cache. usage trouxe: ${chaves || '(vazio)'}`;
  }
  const partes: string[] = [];
  if (lidos !== undefined) partes.push(`lidos=${String(lidos)}`);
  if (gravados !== undefined) partes.push(`gravados=${String(gravados)}`);
  const pin = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
  const pct = pctDeCache(pin, lidos);
  if (pct !== undefined) partes.push(`${String(pct)}%`);
  return `cache: ${partes.join(' · ')}`;
}
