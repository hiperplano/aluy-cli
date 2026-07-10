// EST-0977 · EST-0962 · ADR-0061 §3 / Q-2 · CLI-SEC-7 (GS-MD4) — mapa `model`→`tier` (PURO).
// ADR-0146 (EST-SUBAGENT-MODEL) — vocabulário ESTENDIDO (`same-as-parent`/`custom`) +
// retorno TIPADO por `kind` + probe L1 (léxico) + utilidades PURAS de L2 (sugestão por
// distância de edição sobre o catálogo vivo, injetado pelo locus concreto).
//
// O frontmatter `model:` de um agente-`.md` (ou o parâmetro `model` do `spawn_agent`,
// ou o dial `subAgent.model` do config) é uma PREFERÊNCIA DE TIER (estilo Claude
// `sonnet`/`opus`/`haiku`, uma chave `aluy-*`, ou um SENTINELA de herança/BYO:
// `same-as-parent`/`parent`/`inherit` e `custom`/`custom:<slug>`). Este módulo é a
// ÚNICA tradução que o CLI faz: string crua → `ModelTierResolution` tipada. A
// resolução `tier → (provider, modelo, credencial, quota)` segue 100% do broker
// (CLI-SEC-7) — o CLI NUNCA sabe o provider nem carrega chave.
//
// EST-0962 — o BROKER é a FONTE DA VERDADE dos tiers. A lista hardcoded abaixo é só
// um conjunto de SINÔNIMOS amigáveis (vocabulário Claude/genérico → chave Aluy); ela
// NÃO é uma allowlist que restringe os tiers. Uma chave de tier BEM-FORMADA que não
// esteja entre os sinônimos (ex.: `aluy-granito` ou qualquer tier NOVO do broker)
// PASSA ADIANTE como tier (`kind:'tier'`) — o broker valida (tier inexistente ⇒ erro
// honesto na chamada).
//
// ADR-0146 (D2, probe L1) — `model` SEM cara de tier/sentinela (ex.: `gpt-9-turbo`,
// um typo de tier) deixa de cair silenciosamente em "herda o pai": vira
// `kind:'unknown'` — candidato a ERRO com sugestão (o locus concreto confronta com o
// catálogo vivo, L2, ANTES do fan-out — ver `suggestModelName`/`formatUnknownModelError`
// abaixo). Ausência de `model` (ou string vazia) é SEMPRE `kind:'inherit'` — a
// herança deliberada/default de hoje, nunca um erro.
//
// PORTÁVEL: tabela/string pura, sem rede e sem catálogo (o catálogo vivo do broker é
// consumido pelo locus concreto via porta injetada; aqui só o piso determinístico +
// as utilidades PURAS de formatação/sugestão).

/**
 * Chaves de tier que o CLI conhece de cor (espelha o FALLBACK_TIERS do @hiperplano/aluy-cli).
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
 * ADR-0146 (D3) — SENTINELAS de HERANÇA (`same-as-parent`/`parent`/`inherit`): "use o
 * caller do PAI ao vivo" (tier+slug+provider correntes — o caminho A já existente,
 * agora selecionável EXPLICITAMENTE por `.md`/spawn/dial). Aliases aceitos (Q-2).
 */
const INHERIT_SENTINELS = new Set(['same-as-parent', 'parent', 'inherit']);

/** ADR-0146 (D3) — sentinela de HERANÇA BYO/Custom (sem slug — usa o do pai). */
const CUSTOM_SENTINEL = 'custom';
/** Prefixo do sentinela `custom:<slug>` (Q-2). */
const CUSTOM_PREFIX = 'custom:';

/**
 * ADR-0152 (D6a) — sentinela de roteamento a um MODELO LOCAL específico (sem slug —
 * degenerado, usa o modelo corrente do pai) do MESMO provider local do pai.
 */
const LOCAL_SENTINEL = 'local';
/** Prefixo do sentinela `local:<slug>` (D6a) — explícito, vale em QUALQUER backend. */
const LOCAL_PREFIX = 'local:';

/**
 * ADR-0152 (D6, condição de segurança 3) — teto defensivo p/ um SLUG de modelo LOCAL
 * (mesma natureza/teto do `MAX_OPAQUE_LEN` do `user-config.ts` — chave de catálogo).
 */
const MAX_MODEL_SLUG_LEN = 128;

/**
 * ADR-0152 (D6, condição de segurança 3) — `true` se `v` é uma string com FORMA
 * razoável p/ virar o `config.model` de um `LocalModelClient`: não-vazia, curta, SEM
 * barra (`/` — evita path-like/travessia), SEM `:` (reservado ao PREFIXO do sentinela,
 * nunca ao corpo do slug) e SEM nenhum caractere de controle (inclui CR/LF — corta
 * injeção de header/linha). Aplicada ANTES de qualquer slug (spawn/`.md`/config,
 * `local:<slug>`/`custom:<slug>` sob backend local) virar `config.model` — em
 * `resolveModelTier`, o ÚNICO funil por onde toda fonte passa. Forma inválida ⇒ o
 * chamador trata como `kind:'unknown'` (nunca vira credencial/endpoint; nunca lança).
 * PURA.
 */
export function isReasonableModelSlug(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t === '' || t.length > MAX_MODEL_SLUG_LEN) return false;
  if (t.includes('/') || t.includes(':')) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001F\u007F]/.test(t);
}

/**
 * ADR-0146 — resultado TIPADO de `resolveModelTier` (substitui o antigo
 * `string | undefined`): distingue a NATUREZA da preferência, não só a chave.
 *
 *  - `tier`    — chave de tier hospedada (sinônimo conhecido OU `aluy-*` bem-formada
 *                mas desconhecida — o broker valida).
 *  - `inherit` — herda o caller do PAI ao vivo (tier+slug+provider correntes). É o
 *                default de hoje (ausência de `model`) E o sentinela explícito
 *                `same-as-parent`/`parent`/`inherit`.
 *  - `custom`  — via BYO/Custom do pai, com o `slug` indicado (`custom:<slug>`) ou,
 *                sem slug, o slug CORRENTE do pai. Só faz sentido com o pai em
 *                `tier:'custom'` (o locus concreto valida — probe D2).
 *  - `local`   — ADR-0152 (D6) — roteia a um MODELO LOCAL específico do MESMO
 *                provider do pai (`local:<slug>`, sempre; OU, sob `ctx.backend
 *                === 'local'`, um slug CRU não reconhecido, OU `custom`/`custom:<slug>`
 *                como ALIAS). `slug` ausente ⇒ degenerado — usa o modelo corrente do pai.
 *  - `unknown` — string com CARA de nome de modelo cru que não bate com nada acima
 *                (ex.: typo de tier, `gpt-9-turbo`) — candidato a ERRO+sugestão
 *                (probe D2), NUNCA mais uma herança silenciosa.
 */
export type ModelTierResolution =
  | { readonly kind: 'tier'; readonly key: string }
  | { readonly kind: 'inherit' }
  | { readonly kind: 'custom'; readonly slug?: string }
  | { readonly kind: 'local'; readonly slug?: string }
  | { readonly kind: 'unknown'; readonly raw: string };

/**
 * Resolve a preferência `model` (do `.md`, do parâmetro `spawn_agent`, ou do dial de
 * config) numa `ModelTierResolution` TIPADA. Case-insensitive, tolera espaços.
 * PURO/sem rede — L1 do probe (ADR-0146 §D2): distingue "herda de propósito"
 * (`kind:'inherit'`, incl. ausência/vazio) de "pediu algo que não reconheço"
 * (`kind:'unknown'` — o locus concreto confronta com o catálogo vivo, L2, e produz
 * erro+sugestão ANTES do fan-out; nunca mais cai em herança silenciosa).
 *
 * EST-0962 — o broker é a FONTE: além dos SINÔNIMOS conhecidos, qualquer chave
 * `aluy-*` bem-formada PASSA ADIANTE como tier (o broker valida), mesmo que o CLI
 * não a conheça.
 *
 * ADR-0152 (D6) — `ctx?.backend` é um HINT de DADO (não I/O — o chamador, que já
 * conhece `meta.backend`, o injeta). Sob `ctx.backend === 'local'`: (a) `custom`/
 * `custom:<slug>` vira ALIAS de `local` (mesma semântica — o "provider custom" no
 * local É o provider local do pai); (b) um slug CRU sem cara de tier/sentinela vira
 * `kind:'local'` (ergonomia BYO) em vez de `unknown`. `local:<slug>`/`local` (prefixo/
 * sentinela explícitos) resolvem em `kind:'local'` em QUALQUER backend/ctx — forma
 * portátil. `ctx` ausente ou `backend:'broker'` ⇒ comportamento do ADR-0146 INTOCADO
 * (zero regressão): slug cru = `unknown`, `custom`* = `kind:'custom'`. O FORMATO do
 * slug (condição de segurança 3) é validado AQUI — `isReasonableModelSlug` — antes de
 * qualquer promoção a `kind:'local'`; forma inválida cai em `unknown` (fail-closed).
 */
export function resolveModelTier(
  model: string | undefined,
  ctx?: { readonly backend?: 'local' | 'broker' },
): ModelTierResolution {
  if (model === undefined) return { kind: 'inherit' };
  const raw = model.trim();
  if (raw === '') return { kind: 'inherit' };
  const key = raw.toLowerCase();
  const isLocalBackend = ctx?.backend === 'local';
  // 1) Sentinelas de HERANÇA explícita (D3) — o dono pediu "siga o pai" por nome.
  if (INHERIT_SENTINELS.has(key)) return { kind: 'inherit' };
  // 2) ADR-0152 (D6a) — `local`/`local:<slug>`, prefixo/sentinela EXPLÍCITOS, valem em
  //    QUALQUER backend (forma portátil de um `.md`/dial). Preserva o CASE do slug.
  if (key === LOCAL_SENTINEL) return { kind: 'local' };
  if (key.startsWith(LOCAL_PREFIX)) {
    const slug = raw.slice(LOCAL_PREFIX.length).trim();
    if (slug === '') return { kind: 'local' };
    return isReasonableModelSlug(slug) ? { kind: 'local', slug } : { kind: 'unknown', raw };
  }
  // 3) Sentinela BYO/Custom (D3) — `custom` (usa o slug corrente do pai) ou
  //    `custom:<slug>` (usa o slug indicado). Preserva o CASE do slug (chave de
  //    catálogo Custom — pode ser sensível a maiúsc./minúsc. no provider externo).
  //    ADR-0152 (D6a) — sob backend LOCAL, é ALIAS de `local` (mesma semântica).
  if (key === CUSTOM_SENTINEL) return isLocalBackend ? { kind: 'local' } : { kind: 'custom' };
  if (key.startsWith(CUSTOM_PREFIX)) {
    const slug = raw.slice(CUSTOM_PREFIX.length).trim();
    if (slug === '') return isLocalBackend ? { kind: 'local' } : { kind: 'custom' };
    if (isLocalBackend) {
      return isReasonableModelSlug(slug) ? { kind: 'local', slug } : { kind: 'unknown', raw };
    }
    return { kind: 'custom', slug };
  }
  // 4) Sinônimo amigável conhecido (haiku/sonnet/strata/granito/…): mapeia.
  const synonym = MODEL_SYNONYM_TO_TIER[key];
  if (synonym !== undefined) return { kind: 'tier', key: synonym };
  // 5) Chave de tier `aluy-*` bem-formada mas DESCONHECIDA (tier novo do broker,
  //    ex.: `aluy-granito` antes de virar sinônimo, ou um futuro `aluy-quartzo`):
  //    PASSA ADIANTE — o broker é a fonte da verdade e valida (EST-0962). NUNCA
  //    a barramos só por não estar na tabela de sinônimos.
  if (looksLikeAluyTierKey(key)) return { kind: 'tier', key };
  // 6) ADR-0152 (D6a) — sob backend LOCAL, um slug CRU sem cara de tier/sentinela
  //    conhecido vira `kind:'local'` (ergonomia BYO: "deepseek-v4-flash" funciona sem
  //    prefixo) — SÓ se tiver forma razoável de slug (condição de segurança 3);
  //    senão cai em `unknown` (fail-closed, nunca vira `config.model`).
  if (isLocalBackend) {
    return isReasonableModelSlug(raw) ? { kind: 'local', slug: raw } : { kind: 'unknown', raw };
  }
  // 7) Nada com cara de tier/sentinela conhecido ⇒ candidato a ERRO (probe D2/L2).
  return { kind: 'unknown', raw };
}

/**
 * ADR-0146 (D2/L1) — nomes CONHECIDOS de cor (sinônimos + sentinelas), p/ o probe L2
 * oferecer sugestão mesmo com o catálogo vivo indisponível (degrade honesto, sem
 * rede). NÃO é allowlist — só o vocabulário FIXO que este módulo reconhece.
 */
export function knownModelNames(): readonly string[] {
  return [
    ...new Set([
      ...Object.keys(MODEL_SYNONYM_TO_TIER),
      ...INHERIT_SENTINELS,
      CUSTOM_SENTINEL,
      LOCAL_SENTINEL,
    ]),
  ];
}

/**
 * Distância de Levenshtein PURA (sem libs) — base da sugestão do probe L2. Custo
 * O(n·m); os nomes de modelo/tier são curtos (dezenas de chars), sem risco de custo.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1, // deleção
        curr[j - 1]! + 1, // inserção
        prev[j - 1]! + cost, // substituição
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
  }
  return prev[n]!;
}

/**
 * ADR-0146 (D2/L2) — sugere o nome mais PRÓXIMO de `raw` entre `candidates` (nomes de
 * tier/sinônimo, PÚBLICOS — nunca provider/credencial). Case-insensitive. Só sugere
 * dentro de um limiar RAZOÁVEL (evita "quis dizer X?" bizarro p/ uma string
 * totalmente diferente) — limiar proporcional ao tamanho do termo buscado. PURO.
 */
export function suggestModelName(
  raw: string,
  candidates: readonly string[],
): string | undefined {
  const target = raw.trim().toLowerCase();
  if (target === '' || candidates.length === 0) return undefined;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = levenshtein(target, candidate.trim().toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  const threshold = Math.max(2, Math.floor(target.length * 0.4));
  return best !== undefined && bestDist <= threshold ? best : undefined;
}

/**
 * ADR-0146 (D2) — formata o ERRO LEGÍVEL do probe p/ um `model` DESCONHECIDO
 * (`kind:'unknown'`), com SUGESTÃO por distância de edição + a lista de nomes
 * disponíveis. `catalogNames` são as chaves do catálogo VIVO do broker (L2, quando
 * disponível); `catalogNames === undefined` ⇒ o catálogo não pôde ser confirmado
 * (broker offline/sem escopo) — degrade HONESTO (nunca trava o fluxo em silêncio),
 * caindo só nos nomes CONHECIDOS de cor (L1). PURO (recebe os dados já buscados —
 * quem busca o catálogo é o locus concreto).
 */
export function formatUnknownModelError(
  raw: string,
  catalogNames?: readonly string[],
): string {
  const known = knownModelNames();
  const candidates = [...new Set([...known, ...(catalogNames ?? [])])];
  const suggestion = suggestModelName(raw, candidates);
  const MAX_LISTED = 8;
  const listed = candidates.slice(0, MAX_LISTED).join(', ');
  const tail = candidates.length > MAX_LISTED ? ', …' : '';
  const head =
    suggestion !== undefined
      ? `modelo "${raw}" não encontrado — você quis dizer "${suggestion}"?`
      : `modelo "${raw}" não encontrado.`;
  const avail =
    catalogNames !== undefined
      ? `Disponíveis: ${listed}${tail}.`
      : `não deu para confirmar no catálogo vivo (broker indisponível) — nomes conhecidos: ${listed}${tail}.`;
  return `${head} ${avail}`;
}

/**
 * ADR-0152 (D6c) — formata o ERRO LEGÍVEL do probe LOCAL p/ um SLUG de modelo local
 * não encontrado no catálogo LISTÁVEL do provider (o `.md`/spawn/config pediu um
 * `local:<slug>` que não bate com nada declarado). Espelha `formatUnknownModelError`,
 * mas o vocabulário é o do PROVIDER LOCAL (slugs de modelo, não tiers/sinônimos do
 * Aluy) — `availableNames` são SÓ os slugs de modelo (DADO público, mesma natureza do
 * que a status bar do pai já mostra em `local · <slug>`); NUNCA provider/base_url/
 * api_key/host (HG-2/CLI-SEC-7, GS-SAM-L4). PURA (recebe os nomes já buscados — quem
 * lista o catálogo local é o locus concreto, porta injetada).
 */
export function formatUnknownLocalModelError(
  raw: string,
  availableNames: readonly string[],
): string {
  const suggestion = suggestModelName(raw, availableNames);
  const MAX_LISTED = 8;
  const listed = availableNames.slice(0, MAX_LISTED).join(', ');
  const tail = availableNames.length > MAX_LISTED ? ', …' : '';
  const head =
    suggestion !== undefined
      ? `modelo local "${raw}" não encontrado — você quis dizer "${suggestion}"?`
      : `modelo local "${raw}" não encontrado.`;
  return `${head} Disponíveis: ${listed}${tail}.`;
}

/**
 * ADR-0146 (Q-3) — RANKING de custo RELATIVO dos tiers hospedados que o CLI conhece
 * de cor (espelha `MODEL_SYNONYM_TO_TIER`: flux < granito < strata < deep). Só serve
 * ao AVISO não-bloqueante de "tier mais caro" — NUNCA bloqueia nem restringe (tiers
 * fora desta tabela, incl. `custom`, não geram aviso — sem dado de custo comparável).
 */
const TIER_COST_RANK: Readonly<Record<string, number>> = {
  'aluy-flux': 0,
  'aluy-granito': 1,
  'aluy-strata': 2,
  'aluy-deep': 3,
};

/**
 * ADR-0146 (Q-3) — `true` se `candidate` é um tier hospedado CONHECIDO mais CARO que
 * `current` (ambos chaves `aluy-*`). Sem dado de custo p/ qualquer um dos dois (tier
 * novo do broker, `custom`, string crua) ⇒ `false` — o aviso é OPORTUNISTA (nunca
 * bloqueia; sem dado, simplesmente não avisa). PURO.
 */
export function isCostlierTier(candidate: string, current: string): boolean {
  const c = TIER_COST_RANK[candidate];
  const cur = TIER_COST_RANK[current];
  if (c === undefined || cur === undefined) return false;
  return c > cur;
}

/**
 * ADR-0146 (D5) / ADR-0152 (D5-bis) — formata o RÓTULO de exibição do tier/modelo
 * RESOLVIDO de um filho p/ a UI (`<SubAgents>`), a partir da `ModelTierResolution` +
 * a pista CORRENTE do pai (`parent.tier`/`parent.model`/`parent.activeModel` — mesma
 * natureza do que a status bar do pai já mostra). NUNCA inclui provider/base_url/
 * credencial (HG-2/CLI-SEC-7) — só a chave de tier e/ou o slug de catálogo
 * Custom/local (chave OPACA de UI). PURA — não sabe de `backend`; quem decide SE
 * `parent.activeModel` é seguro exibir (só sob `backend==='local'`) é o locus
 * concreto (o controller), que só preenche o campo nesse caso (ADR-0152 D5-bis).
 *
 * Precedência no ramo `inherit`/`unknown`: (a) `parent.activeModel` presente ⇒
 * `herdado (${activeModel})` — o modelo CONCRETO que o pai de fato usa; (b) senão,
 * `parent.tier === 'custom' && parent.model` ⇒ `herdado (custom · ${model})`
 * (comportamento do ADR-0146, inalterado); (c) senão ⇒ `herdado (${parent.tier})`
 * (comportamento do ADR-0146, inalterado).
 *
 * ADR-0152 (D6) — ramo `local`: `local · ${slug}` — o SLUG pedido para ESTE filho
 * (`resolution.slug`), ou, no caso degenerado (sem slug — "usa o modelo corrente do
 * pai"), o `parent.activeModel`/`parent.model` (mesma pista que a status bar do pai
 * já exibe). NUNCA provider/base_url/credencial.
 */
export function formatResolvedModelLabel(
  resolution: ModelTierResolution,
  parent: { readonly tier: string; readonly model?: string; readonly activeModel?: string },
): string {
  switch (resolution.kind) {
    case 'tier':
      return resolution.key;
    case 'custom': {
      const slug = resolution.slug ?? parent.model;
      return slug !== undefined ? `custom · ${slug}` : 'custom';
    }
    case 'local': {
      const slug = resolution.slug ?? parent.activeModel ?? parent.model;
      return slug !== undefined ? `local · ${slug}` : 'local';
    }
    case 'inherit':
    case 'unknown':
    default:
      if (parent.activeModel !== undefined) return `herdado (${parent.activeModel})`;
      return parent.tier === 'custom' && parent.model !== undefined
        ? `herdado (custom · ${parent.model})`
        : `herdado (${parent.tier})`;
  }
}
