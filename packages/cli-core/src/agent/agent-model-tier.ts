// EST-0977 · EST-0962 · ADR-0061 §3 / Q-2 · CLI-SEC-7 (GS-MD4) — mapa `model`→`tier` (PURO).
//
// O frontmatter `model:` de um agente-`.md` é uma PREFERÊNCIA DE TIER (estilo Claude
// `sonnet`/`opus`/`haiku`, ou já uma chave de tier do Aluy). Este módulo é a ÚNICA
// tradução que o CLI faz: nome amigável → chave de tier do Aluy. A resolução
// `tier → (provider, modelo, credencial, quota)` é 100% do broker (CLI-SEC-7) — o
// CLI NUNCA sabe o provider nem carrega chave.
//
// EST-0962 — o BROKER é a FONTE DA VERDADE dos tiers. A lista hardcoded abaixo é só
// um conjunto de SINÔNIMOS amigáveis (vocabulário Claude/genérico → chave Aluy); ela
// NÃO é uma allowlist que restringe os tiers. Uma chave de tier BEM-FORMADA que não
// esteja entre os sinônimos (ex.: `aluy-granito` ou qualquer tier NOVO do broker)
// PASSA ADIANTE como tier — o broker valida (tier inexistente ⇒ erro honesto na
// chamada). Só `model` realmente sem cara de tier (ex.: `gpt-9-turbo`) ⇒ `undefined`
// (o chamador cai no TIER DA SESSÃO — fallback seguro, jamais provider direto).
//
// PORTÁVEL: tabela/string pura, sem rede e sem catálogo (o catálogo vivo do broker
// é consumido pela TUI; aqui só o piso determinístico p/ o agente-`.md`).

/**
 * Chaves de tier que o CLI conhece de cor (espelha o FALLBACK_TIERS do @aluy/cli).
 * É SÓ o fallback offline — NÃO restringe: o broker pode ter MAIS tiers (EST-0962),
 * e tiers desconhecidos bem-formados passam adiante na resolução abaixo.
 */
export const ALUY_TIER_KEYS = ['aluy-flux', 'aluy-granito', 'aluy-strata', 'aluy-deep'] as const;
export type AluyTierKey = (typeof ALUY_TIER_KEYS)[number];

/**
 * Mapa de SINÔNIMOS amigáveis (incl. o vocabulário Claude Code, como referência de
 * design) → chave de tier do Aluy. Conservador: por capacidade/custo aproximado.
 * NÃO é exaustivo nem é uma allowlist — é só um atalho p/ nomes comuns. Tiers novos
 * do broker (`aluy-*`) NÃO precisam entrar aqui: passam direto (ver `resolveModelTier`).
 *   - econômico/rápido  → aluy-flux
 *   - equilíbrio leve   → aluy-granito
 *   - padrão            → aluy-strata
 *   - premium/raciocínio→ aluy-deep
 */
const MODEL_SYNONYM_TO_TIER: Readonly<Record<string, string>> = {
  // chaves nativas do Aluy (passam direto; aqui só p/ documentar).
  'aluy-flux': 'aluy-flux',
  'aluy-granito': 'aluy-granito',
  'aluy-strata': 'aluy-strata',
  'aluy-deep': 'aluy-deep',
  flux: 'aluy-flux',
  granito: 'aluy-granito',
  strata: 'aluy-strata',
  // `cortex` = display ATUAL de `aluy-deep` (migration 0012); `deep` = display ANTIGO,
  // mantido por compat. Ambos resolvem p/ a MESMA key imutável `aluy-deep` (não há key
  // `aluy-cortex` — renomear tier é DADO, nunca a key/código; ADR-0030).
  cortex: 'aluy-deep',
  deep: 'aluy-deep',
  // vocabulário Claude Code (referência de design — sem cópia de código).
  haiku: 'aluy-flux',
  sonnet: 'aluy-strata',
  opus: 'aluy-deep',
  // genéricos comuns.
  fast: 'aluy-flux',
  cheap: 'aluy-flux',
  standard: 'aluy-strata',
  balanced: 'aluy-strata',
  premium: 'aluy-deep',
  reasoning: 'aluy-deep',
};

/**
 * `true` se `key` (já normalizada) tem CARA de chave de tier do Aluy: prefixo
 * `aluy-` + corpo `[a-z0-9-]`. É o filtro que separa "tier novo do broker" (passa
 * adiante) de "model cru de provider" (ex.: `gpt-9-turbo`, que NÃO passa).
 */
function looksLikeAluyTierKey(key: string): boolean {
  return /^aluy-[a-z0-9-]+$/.test(key);
}

/**
 * Resolve a preferência `model` do `.md` numa chave de TIER. Case-insensitive,
 * tolera espaços. EST-0962 — o broker é a FONTE: além dos SINÔNIMOS conhecidos,
 * qualquer chave `aluy-*` bem-formada PASSA ADIANTE como tier (o broker valida),
 * mesmo que o CLI não a conheça. `model` sem cara de tier (provider cru) OU vazio
 * ⇒ `undefined` (o chamador usa o tier da SESSÃO; nunca um provider direto, nunca
 * erro fatal). Devolve `string` (chave de tier): a `AluyTierKey` quando casa um
 * sinônimo, ou a própria chave `aluy-*` desconhecida. PURO.
 */
export function resolveModelTier(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const key = model.trim().toLowerCase();
  if (key === '') return undefined;
  // 1) Sinônimo amigável conhecido (haiku/sonnet/strata/granito/…): mapeia.
  const synonym = MODEL_SYNONYM_TO_TIER[key];
  if (synonym !== undefined) return synonym;
  // 2) Chave de tier `aluy-*` bem-formada mas DESCONHECIDA (tier novo do broker,
  //    ex.: `aluy-granito` antes de virar sinônimo, ou um futuro `aluy-quartzo`):
  //    PASSA ADIANTE — o broker é a fonte da verdade e valida (EST-0962). NUNCA
  //    a barramos só por não estar na tabela de sinônimos.
  if (looksLikeAluyTierKey(key)) return key;
  // 3) Nada com cara de tier (model cru de provider) ⇒ undefined (tier da sessão).
  return undefined;
}
