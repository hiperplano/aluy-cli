// O MARCADOR de cache de prompt (`cache_control`), e onde ele vai.
//
// Duas famílias de cache, e a diferença é o que a pergunta do dono (10/09/2026 — "a gente
// usa prompt caching?" / "só vai funcionar pra anthropic? estou usando o openrouter")
// expôs que eu tinha enquadrado errado:
//
//   IMPLÍCITO  — o provider casa o prefixo sozinho (DeepSeek, OpenAI, GLM…). Não há nada a
//                mandar; basta o prefixo ser ESTÁVEL, e o nosso é (system puro + histórico
//                append-only). Já funcionava; só éramos cegos a ele.
//   EXPLÍCITO  — só acontece se você MARCAR onde cortar (Anthropic, Gemini). Sem o marcador
//                o desconto é ZERO, por mais estável que o prefixo seja.
//
// O ponto que importa para quem usa OpenRouter: ele aceita `cache_control` DENTRO do
// formato OpenAI-compat e repassa ao provider de baixo. Ou seja, isto NÃO é um caminho
// "Anthropic" separado — é o mesmo adaptador que ele já usa, e o `anthropic/claude-*`
// roteado por lá é exatamente o caso que hoje não cacheia nada.
//
// ONDE cortar: no fim do SYSTEM. É o maior pedaço imutável da conversa (catálogo de tools +
// instruções do projeto + agentes + comandos — facilmente dezenas de milhares de tokens) e
// o único cuja estabilidade nós controlamos. O histórico cresce por append: o provider de
// cache implícito já o aproveita sozinho, e marcá-lo exigiria mover o breakpoint a cada
// turno — que é como se gasta os poucos breakpoints disponíveis sem ganhar nada.
//
// POR QUE NÃO MARCAR SEMPRE: um breakpoint tem custo de ESCRITA (no dialeto Anthropic, ágio
// sobre o token normal) e o cache tem TTL curto. Marcar um system minúsculo paga o ágio para
// economizar quase nada. O piso abaixo existe para isso.
//
// PURO: sem I/O, sem rede.

/**
 * Piso de tokens para valer a pena marcar. Estimado em CARACTERES (~4 por token) porque
 * aqui não há tokenizer — e não precisa haver: a decisão é grosseira ("é grande?"), e errar
 * por 20% não muda o desfecho.
 *
 * 1024 tokens é o mínimo que os dialetos explícitos aceitam para um breakpoint. Abaixo
 * disso o marcador é ignorado pelo provider, então mandá-lo é só ruído no payload.
 */
export const MIN_TOKENS_P_CACHE = 1024;

/** Estimativa grosseira de caracteres por token — a decisão é "é grande?", não exata. */
const CHARS_POR_TOKEN = 4;

/**
 * Pisos MAIORES, por FAMÍLIA de modelo. Medido na documentação do OpenRouter (11/09/2026).
 *
 * A primeira versão cravou 1024 para todos, que é o piso da OpenAI e de parte da linha
 * Anthropic — mas NÃO de todos. Nos modelos abaixo o marcador é simplesmente IGNORADO
 * quando o bloco é menor, e o efeito é o pior possível: o payload muda (vira array de
 * partes), nada é cacheado, e nada avisa. Um conserto que não conserta e não reclama.
 *
 * Casamento por FRAGMENTO do slug, não por igualdade: o mesmo modelo aparece como
 * `claude-opus-4-8`, `anthropic/claude-opus-4-8` e `anthropic/claude-opus-4-8:batch`
 * dependendo de quem roteia. Igualdade exata perderia os dois últimos.
 */
const PISOS_POR_FRAGMENTO: readonly (readonly [string, number])[] = [
  ['claude-opus-4-8', 4096],
  ['claude-opus-4-6', 4096],
  ['claude-opus-4-5', 4096],
  ['claude-haiku-4-5', 4096],
  ['claude-haiku-4.5', 4096],
  ['claude-opus-4.8', 4096],
  ['claude-opus-4.6', 4096],
  ['claude-opus-4.5', 4096],
  ['gemini-2.5-pro', 4096],
  ['claude-haiku-3.5', 2048],
  ['claude-3-5-haiku', 2048],
];

/** O piso EFETIVO em tokens para um slug. PURO. Default: `MIN_TOKENS_P_CACHE`. */
export function pisoDeCachePara(model: string | undefined): number {
  const m = (model ?? '').trim().toLowerCase();
  if (m === '') return MIN_TOKENS_P_CACHE;
  let piso = MIN_TOKENS_P_CACHE;
  // MAIOR piso que casa vence: um slug que case duas famílias (raro, mas possível num
  // agregador) tem de respeitar a exigência mais estrita, nunca a mais frouxa.
  for (const [frag, valor] of PISOS_POR_FRAGMENTO) {
    if (m.includes(frag) && valor > piso) piso = valor;
  }
  return piso;
}

export function valeCachear(texto: string | undefined, model?: string): boolean {
  if (texto === undefined || texto === '') return false;
  return texto.length >= pisoDeCachePara(model) * CHARS_POR_TOKEN;
}

/**
 * O `system` no formato OpenAI-compat, com o breakpoint quando vale a pena.
 *
 * String pura quando não vale — e essa é a forma que TODO provider OpenAI-compat entende,
 * inclusive os que nunca ouviram falar de `cache_control`. Só promovemos para o array de
 * partes quando há o que ganhar, para não mudar o payload de quem não usa cache explícito.
 */
export function systemOpenAiComCache(
  system: string,
  model?: string,
): string | readonly Record<string, unknown>[] {
  if (!valeCachear(system, model)) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

/**
 * O `system` no formato Anthropic nativo, com o breakpoint quando vale a pena.
 *
 * Lá o `system` é um campo separado que aceita string OU array de blocos; o `cache_control`
 * só existe na segunda forma.
 */
export function systemAnthropicComCache(
  system: string,
  model?: string,
): string | readonly Record<string, unknown>[] {
  if (!valeCachear(system, model)) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}
