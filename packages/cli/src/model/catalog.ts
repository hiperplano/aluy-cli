// EST-0962 (lado @hiperplano/aluy-cli) — FALLBACK do catálogo de tiers + display do seletor.
//
// FONTE DA VERDADE = o CATÁLOGO do broker. O seletor `/model` busca os tiers no
// broker (`GET /v1/tiers/catalog`, EST-0962/ADR-0030 §3) p/ mostrar nome amigável +
// sinal de custo por tier — e quando ele responde, a lista do broker (que pode ter
// MAIS tiers que este fallback, incl. tiers NOVOS) SUBSTITUI este fallback INTEIRO
// (ver `useModelPicker`). Só quando o broker NÃO responde (offline/sem scope/sem
// login) ou volta vazio caímos neste FALLBACK de tiers CONHECIDOS — assim o `/model`
// continua trocando o tier mesmo sem catálogo, com uma mensagem NEUTRA (HG-2: nunca
// o provider/credencial). O fallback NUNCA limita o que o broker mostra.
//
// HG-2: o fallback usa SÓ o que já é público (a chave do tier + um nome amigável
// derivado dela). NÃO inventa provider/modelo concreto — quando o catálogo está
// fora, mostramos só `tier + sinal de custo` (sem a composição de modelos, que só
// o broker conhece). A resolução `tier → (provider, model, credencial)` é
// server-only, intocada.

import type { TierCatalogEntry, CostSignal } from '@hiperplano/aluy-cli-core';

/**
 * Tiers CONHECIDOS do FALLBACK — usados SÓ quando o catálogo do broker não responde
 * (offline/sem scope/sem login) ou volta vazio (provisionamento). A FONTE DA VERDADE
 * dos tiers é o CATÁLOGO do broker (`GET /v1/tiers/catalog`): quando ele responde, o
 * `useModelPicker` SUBSTITUI esta lista pela do broker INTEIRA — que pode ter MAIS
 * tiers (este fallback NÃO limita a UI). Por isso a lista aqui só precisa cobrir os
 * tiers ESTÁVEIS conhecidos, p/ o `/model` seguir trocando mesmo offline (EST-0962).
 *
 * Ordem, `displayName` e `costSignal` em PARIDADE com o broker (`model_tiers`,
 * migrations 0002/0012/0020 — ADR-0030 §3, `catalog.cost_signal_for`):
 *   • Ordem por RANK da vitrine (EST-0991): flux(10) < granito(20) < strata(30) < deep(40).
 *   • `displayName` = `model_tiers.display_name` ATUAL (migration 0012, EST-0162):
 *     a `key` é o ID IMUTÁVEL (`aluy-deep`/`aluy-flux`/…); só o nome amigável mudou
 *     — "Aluy Flux"→"Flui" e "Aluy Deep"→"Cortex". NÃO existe chave `aluy-cortex`:
 *     "Cortex" é só o display de `aluy-deep` (renomear tier = DADO, nunca a key/código).
 *   • `costSignal` = `cost_signal_for(profile)`: economical=fast, standard=balanced,
 *     premium=reasoning (flux=fast, granito/strata=balanced, deep=reasoning).
 * Sem composição (modelo por tier só o broker conhece — HG-2): o fallback NÃO inventa
 * nome de modelo concreto (offline, o nome poderia estar STALE/errado e enganar o
 * usuário). A janela de contexto por tier — que a auto-compactação precisa mesmo
 * offline — vem do `FALLBACK_CONTEXT_TOKENS` abaixo (só o NÚMERO, não um modelo falso).
 */
export const FALLBACK_TIERS: readonly TierCatalogEntry[] = [
  { key: 'aluy-flux', displayName: 'Flui', costSignal: 'economical', composition: [] },
  { key: 'aluy-granito', displayName: 'Granito', costSignal: 'standard', composition: [] },
  { key: 'aluy-strata', displayName: 'Strata', costSignal: 'standard', composition: [] },
  { key: 'aluy-deep', displayName: 'Cortex', costSignal: 'premium', composition: [] },
];

/**
 * EST-0973/EST-1015 (fix) — janela de contexto por tier para o caminho OFFLINE (broker
 * fora), em TOKENS. É o denominador REAL da auto-compactação e do `⛁ %` quando o
 * catálogo vivo não está disponível — sem isto a EST-0973 usava 200k hardcoded p/ todos
 * (Strata=128k real estourava antes do trigger de 85%). Aqui guardamos só o NÚMERO,
 * preservando o HG-2 (o fallback NÃO carrega o NOME do modelo — só o broker o conhece).
 * Com catálogo vivo, `contextWindowForTier` usa o `context` do modelo principal real.
 */
export const FALLBACK_CONTEXT_TOKENS: Readonly<Record<string, number>> = {
  'aluy-flux': 256_000,
  'aluy-granito': 1_000_000,
  'aluy-strata': 128_000,
  'aluy-deep': 200_000,
};

/**
 * EST-0973 (fix HUNT) — janela de contexto PADRÃO (conservadora) para um tier CANÔNICO
 * cuja janela concreta não pôde ser resolvida (tier NOVO do broker que ainda não está no
 * `FALLBACK_CONTEXT_TOKENS`, ou entrada do catálogo sem composição utilizável). É o
 * mesmo número que o controller usa quando nasce sem `contextWindow` explícito — assim a
 * AUTO-COMPACTAÇÃO segue PROTEGENDO a janela (dispara a 85% de 200k) em vez de ficar
 * INERTE (contextWindow=0 ⇒ overflow → stall em 100%, a dor do dogfood). NÃO se aplica a
 * `custom` (janela genuinamente imprevisível, inerte é o fail-safe correto).
 */
export const DEFAULT_TIER_CONTEXT_TOKENS = 200_000;

/**
 * EST-0962 — NOME DE EXIBIÇÃO de um tier a partir da sua KEY interna. É o que o footer
 * (<StatusBar>), o header compacto (<Header>) e a nota de "tier trocado" mostram p/ o
 * usuário: `Granito`/`Flui`/`Strata`/`Cortex` — NUNCA a key crua `aluy-granito`.
 *
 * Precedência (a FONTE DA VERDADE é o catálogo do broker — ADR-0030 §3):
 *   1. CATÁLOGO do broker (`catalog`, quando carregado): o `displayName` dele VENCE —
 *      cobre tiers NOVOS e renomeações futuras sem tocar no código.
 *   2. FALLBACK local (`FALLBACK_TIERS`): quando o catálogo está 401/ausente/vazio
 *      (broker não expõe o catálogo ao PAT dev) — o mapa determinístico key→display.
 *   3. A própria KEY (último recurso): tier desconhecido (nem catálogo nem fallback) ⇒
 *      mostra a key crua — não inventa nome e não quebra (ex.: `custom`, tier futuro).
 *
 * Puro/testável (sem rede). `catalog` ausente/vazio ⇒ usa só o fallback local.
 */
export function tierDisplayName(key: string, catalog?: readonly TierCatalogEntry[]): string {
  const fromCatalog = catalog?.find((e) => e.key === key);
  if (fromCatalog !== undefined) return fromCatalog.displayName;
  const fromFallback = FALLBACK_TIERS.find((e) => e.key === key);
  if (fromFallback !== undefined) return fromFallback.displayName;
  return key;
}

/** Rótulo PT-BR do sinal de custo p/ a UI (`econômico`/`padrão`/`premium`). */
export function costLabel(signal: CostSignal): string {
  switch (signal) {
    case 'economical':
      return 'econômico';
    case 'premium':
      return 'premium';
    case 'standard':
      return 'padrão';
    default:
      // Sinal desconhecido (extensão futura do broker): mostra cru, sem inventar.
      return String(signal);
  }
}

/**
 * Nome amigável do MODELO PRINCIPAL do tier (posição 0 da composição) p/ a linha do
 * seletor. Vazio quando não há composição (fallback sem catálogo). NUNCA expõe
 * provider de credencial — é o nome PÚBLICO do catálogo (HG-2 relaxado, ADR-0030 §3).
 */
export function principalModel(entry: TierCatalogEntry): string {
  const principal = entry.composition.find((m) => m.role === 'principal') ?? entry.composition[0];
  return principal?.name ?? '';
}

/**
 * Linha de exibição de uma entrada do catálogo no seletor (e no `/model` linear):
 * `Strata · Claude 3.5 Sonnet · padrão`. Sem o nome do modelo (fallback), elide a
 * parte do meio: `Strata · padrão`.
 */
export function tierLine(entry: TierCatalogEntry): string {
  const model = principalModel(entry);
  const cost = costLabel(entry.costSignal);
  return model === ''
    ? `${entry.displayName} · ${cost}`
    : `${entry.displayName} · ${model} · ${cost}`;
}

/**
 * EST-0973 (fix) — PARSEIA a string de contexto do catálogo (`'128k'`, `'256k'`,
 * `'200k'`, `'1M'`) para o número de tokens correspondente. É o denominador REAL da
 * janela do modelo — a auto-compactação e o `⛁ %` da UI dependem deste valor para NÃO
 * usar um hardcoded 200k que não reflete o tier ativo (ex.: Strata = 128k real, mas
 * era tratado como 200k ⇒ a janela estourava ANTES do trigger de 85%).
 *
 * Suporta sufixos `k` (mil) e `M` (milhão). Valor inválido/vazio ⇒ `0` (desconhecida).
 * A escolha do modelo CONCRETO é do broker (principal vs reserva); nós usamos o
 * principal como denominador (mais conservador — o reserva geralmente é ≥ principal).
 * PURO, exportado p/ uso no wiring e no controller (re-resolve na troca de tier).
 */
export function parseContextWindow(s: string): number {
  if (!s || typeof s !== 'string') return 0;
  const trimmed = s.trim();
  if (trimmed === '') return 0;
  // Extrai número + sufixo opcional (k=×1000, M=×1_000_000).
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
  if (!match) return 0;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const suffix = match[2].toLowerCase();
  if (suffix === 'k') return Math.floor(num * 1000);
  if (suffix === 'm') return Math.floor(num * 1_000_000);
  return Math.floor(num);
}

/** Env p/ FIXAR a janela quando o tier não a conhece (custom/local). Aceita `128k`/`200000`/`1M`. */
export const CONTEXT_WINDOW_ENV = 'ALUY_CONTEXT_WINDOW';

/**
 * F64 (fix) — janela EFETIVA: o tier conhecido vence; quando ele é desconhecido
 * (`custom`/vazio ⇒ `contextWindowForTier` = 0, ex. `--backend local` + modelo BYO),
 * cai num OVERRIDE de env `ALUY_CONTEXT_WINDOW` (opt-in). Isso HABILITA a
 * auto-compactação no modo local/custom — antes ela ficava INERTE (janela 0) e uma
 * sessão longa não tinha rede de segurança. Sem o env ⇒ 0 (comportamento atual,
 * SEM regressão: inerte, fail-safe). O env nunca SOBREPÕE uma janela de tier
 * conhecida (o broker é a fonte da verdade). PURO/testável.
 */
export function resolveContextWindow(
  tierKey: string,
  env: Record<string, string | undefined> = {},
  catalog?: readonly TierCatalogEntry[],
  configWindow?: number | undefined, // ADR-0150 balde(a): config.context.window (custom only)
): number {
  const fromTier = contextWindowForTier(tierKey, catalog);
  if (fromTier > 0) return fromTier; // tier conhecido manda
  // Custom: opt-in via env `ALUY_CONTEXT_WINDOW`, senão config.context.window, senão 0 (inerte).
  const fromEnv = parseContextWindow(env[CONTEXT_WINDOW_ENV] ?? '');
  if (fromEnv > 0) return fromEnv;
  return configWindow !== undefined && Number.isInteger(configWindow) && configWindow > 0
    ? configWindow
    : 0;
}

/**
 * EST-0973 (fix) — resolve a janela de contexto para um tier. Com CATÁLOGO VIVO, usa o
 * `context` do modelo PRINCIPAL real (o broker é a fonte da verdade). OFFLINE (fallback,
 * composição vazia por HG-2), cai no `FALLBACK_CONTEXT_TOKENS` (só o número por tier —
 * sem inventar nome de modelo). Retorna 0 (⇒ auto-compactação INERTE, sem overflow) SÓ
 * para `custom`/vazio (janela genuinamente imprevisível). Puro/testável.
 *
 * HUNT (fix) — para um tier CANÔNICO/conhecido pelo broker cuja janela concreta não
 * resolve (tier NOVO ainda fora do `FALLBACK_CONTEXT_TOKENS`, ou entrada do catálogo sem
 * `context` parseável), cai no `DEFAULT_TIER_CONTEXT_TOKENS` (200k) — NUNCA 0. Antes,
 * `setTier`/boot para esses tiers zeravam a janela ⇒ a auto-compactação ficava INERTE e
 * a janela ESTOURAVA (stall em 100%). 0 fica reservado a `custom`/vazio, onde inerte é
 * o fail-safe correto (não há janela conhecida para proteger).
 */
export function contextWindowForTier(
  tierKey: string,
  catalog?: readonly TierCatalogEntry[],
): number {
  // Custom/vazio: janela imprevisível — volta 0 p/ inerte (fail-safe: não dispara em
  // 200k hardcoded numa janela que pode ser bem menor).
  if (tierKey === 'custom' || tierKey === '') return 0;
  // CATÁLOGO VIVO: o modelo principal real carrega o `context` verdadeiro.
  if (catalog && catalog.length > 0) {
    const entry = findTier(catalog, tierKey);
    // Entrada presente no catálogo do broker: é um tier CONHECIDO. Usa o `context` do
    // principal; se não houver composição/`context` parseável, cai no número fixo do tier
    // ou no PADRÃO protetor (200k) — nunca 0 (senão a auto-compactação ficaria inerte
    // num tier que o broker conhece ⇒ overflow). Tier AUSENTE do catálogo cai abaixo.
    if (entry) {
      const principal =
        entry.composition.find((m) => m.role === 'principal') ?? entry.composition[0];
      const fromCatalog = principal ? parseContextWindow(principal.context) : 0;
      if (fromCatalog > 0) return fromCatalog;
      return FALLBACK_CONTEXT_TOKENS[tierKey] ?? DEFAULT_TIER_CONTEXT_TOKENS;
    }
  }
  // OFFLINE ou tier fora do catálogo carregado: número conhecido por tier; tier canônico
  // SEM número conhecido (ex.: novo do broker) cai no PADRÃO protetor — nunca 0 (HG-2: só
  // o número, sem nome de modelo concreto no fallback).
  return FALLBACK_CONTEXT_TOKENS[tierKey] ?? DEFAULT_TIER_CONTEXT_TOKENS;
}

/** `true` se a chave casa um tier do catálogo (p/ validar `/model <tier>` literal). */
export function findTier(
  entries: readonly TierCatalogEntry[],
  key: string,
): TierCatalogEntry | undefined {
  return entries.find((e) => e.key === key);
}

/**
 * Aliases LEGADOS de display → `key` (compat). Cobre nomes amigáveis que NÃO são mais
 * o `display_name` ATUAL do broker, mas ainda podem ser digitados por quem os aprendeu:
 *   • `deep` — display ANTIGO de `aluy-deep` (hoje "Cortex", migration 0012/EST-0162).
 *     Mantido por compat: `/model deep` não quebra após o rename.
 * Os displays ATUAIS ("cortex"/"flui"/"strata"/"granito") NÃO entram aqui — casam
 * sozinhos pela varredura de `displayName`. `flux` (display antigo) também não precisa:
 * já casa pelo atalho `aluy-${a}` (= `aluy-flux`).
 */
const LEGACY_DISPLAY_ALIASES: Readonly<Record<string, string>> = {
  deep: 'aluy-deep',
};

/**
 * Normaliza o argumento de `/model <tier>` p/ uma chave de tier conhecida. Aceita a
 * chave plena (`aluy-strata`), o nome curto SEM prefixo (`strata`), o nome de
 * exibição ATUAL (`Strata`/`Cortex`/`Flui`) e aliases LEGADOS (`deep`→`aluy-deep`),
 * tudo case-insensitive. Devolve a chave canônica ou `undefined` se não casar nenhum
 * tier conhecido. Puro/testável (sem rede).
 */
export function resolveTierKey(arg: string): string | undefined {
  const a = arg.trim().toLowerCase();
  if (a === '') return undefined;
  for (const t of FALLBACK_TIERS) {
    if (t.key.toLowerCase() === a) return t.key;
    if (t.key.toLowerCase() === `aluy-${a}`) return t.key;
    if (t.displayName.toLowerCase() === a) return t.key;
  }
  // Alias de display LEGADO (ex.: "deep" após o rename p/ "Cortex"): mapeia p/ a key.
  const legacy = LEGACY_DISPLAY_ALIASES[a];
  if (legacy !== undefined) return legacy;
  // Chave `aluy-*` desconhecida mas bem-formada: aceita literalmente (o broker
  // valida — tier inexistente ⇒ `422 UNKNOWN_TIER` honesto na próxima chamada).
  if (/^aluy-[a-z0-9-]+$/.test(a)) return a;
  return undefined;
}

/** Saída de `/model <tier>` literal: nota a empurrar (título + linhas). */
export interface TierNote {
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * Aplica `/model <tier>` LITERAL (não-TTY / atalho): resolve a chave, troca o tier
 * via o `setTier` injetado e devolve a NOTA a mostrar. Tier desconhecido (não casa
 * `resolveTierKey`) e NÃO-VAZIO ⇒ trata como SLUG de modelo CUSTOM (via `tier:'custom'`,
 * ADR-0030 §3, warn-but-allow). HG-2: só o tier/slug — nunca provider.
 */
export function applyTierLiteral(
  setTier: (tier: string, model?: string) => void,
  arg: string,
): TierNote {
  const trimmed = arg.trim();
  const key = resolveTierKey(arg);
  if (key !== undefined) {
    setTier(key);
    return {
      title: 'model',
      lines: [
        // EST-0962 — mostra o NOME DE EXIBIÇÃO (`Granito`), não a key crua (`aluy-granito`);
        // tier desconhecido sem mapa local cai na própria key (último recurso, não quebra).
        `tier trocado para: ${tierDisplayName(key)}`,
      ],
    };
  }

  // F147 — arg que NÃO é tier conhecido: trata como SLUG de modelo CUSTOM (warn-but-allow).
  if (trimmed !== '') {
    setTier('custom', trimmed);
    return {
      title: 'model',
      lines: [
        `modelo Custom: ${trimmed}`,
        '◍ identificador enviado ao broker/provider sem validação prévia',
        '⚠ fora do catálogo curado: custo/qualidade variável, sem auditoria.',
      ],
    };
  }

  // arg vazio = sem tier definível
  return {
    title: 'model',
    lines: [
      `tier desconhecido: ""`,
      `tiers conhecidos: ${FALLBACK_TIERS.map((t) => t.key).join(' · ')}`,
      '◍ a composição (modelo por tier) vem do broker — `/model` sem argumento lista',
      '◍ para modelo Custom: `/model <slug>` (ex.: `/model claude-opus-4-8`)',
    ],
  };
}
