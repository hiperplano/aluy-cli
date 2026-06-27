// EST-0989 · i18n — o NÚCLEO da tradução: `t(key, params?)` com FALLBACK e interpolação.
//
// `t()` resolve uma chave estável p/ o texto no idioma ATIVO. A cadeia de fallback
// (DoD: "nunca mostra a chave crua"):
//   1. catálogo do idioma ativo (ex.: en) — se a chave existe lá, usa.
//   2. catálogo pt-BR (canônico/completo) — toda chave existe aqui (TS garante).
//   3. a própria chave (degradação last-resort) — só alcançável se alguém burlar o
//      tipo (chave fora do `Catalog` via cast); aciona um aviso SÓ em dev.
//
// Interpolação: `{nome}` no texto é substituído pelo `params.nome` (texto inerte —
// CLI-SEC: sem HTML/shell; o valor entra cru, é dado, não markup). Um placeholder
// sem param correspondente é DEIXADO como está (`{nome}`) — visível como bug em dev,
// nunca quebra. `i18n()` cria um `t` LIGADO a um idioma (o que a App injeta no contexto).

import type { Catalog, I18nKey, I18nParams, PartialCatalog } from './catalog.js';
import type { Lang } from './lang.js';
import { DEFAULT_LANG } from './lang.js';
import { ptBR } from './pt-BR.js';
import { en } from './en.js';

/** Os catálogos por idioma. pt-BR é o COMPLETO; en é PARCIAL (fallback p/ pt-BR). */
const CATALOGS: Readonly<Record<Lang, Catalog | PartialCatalog>> = {
  'pt-BR': ptBR,
  en,
};

/** O catálogo CANÔNICO (piso de todo fallback) — sempre completo. */
const CANONICAL: Catalog = ptBR;

/**
 * Substitui os `{param}` no `text` pelos valores de `params`. Determinístico, sem
 * regex perigosa: varre `{...}` e troca pelo valor (string) quando existe; senão
 * deixa o literal `{param}` (sinal de chave de param errada, visível em dev). Não
 * interpreta o valor (texto inerte) — sem injeção via catálogo (CLI-SEC).
 */
export function interpolate(text: string, params?: I18nParams): string {
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = params[name];
    return v === undefined ? match : String(v);
  });
}

/**
 * Resolve o TEXTO de uma chave num idioma, com fallback en→pt-BR→chave (SEM
 * interpolação — uso interno/teste). Puro: recebe o idioma, não lê estado global.
 */
export function resolveText(lang: Lang, key: I18nKey): string {
  const active = CATALOGS[lang];
  const fromActive = active[key];
  if (fromActive !== undefined) return fromActive;
  // fallback p/ o canônico (pt-BR) — toda chave do `Catalog` existe aqui.
  const fromCanonical = CANONICAL[key];
  if (fromCanonical !== undefined) return fromCanonical;
  // last-resort: a própria chave (só se burlaram o tipo). Aviso só em dev.
  warnMissingKey(key);
  return key;
}

/**
 * `t(lang, key, params?)` — a forma EXPLÍCITA (recebe o idioma). A App usa a forma
 * LIGADA (`i18n(lang).t`) p/ não repassar o idioma em cada chamada; esta existe p/
 * código fora do React (não-TTY, handlers linear) e p/ teste direto.
 */
export function t(lang: Lang, key: I18nKey, params?: I18nParams): string {
  return interpolate(resolveText(lang, key), params);
}

/** A assinatura do `t` LIGADO a um idioma (o que viaja no contexto React). */
export type TFunction = (key: I18nKey, params?: I18nParams) => string;

/**
 * Cria um tradutor LIGADO a um idioma. `i18n('en').t('hints.idle')` resolve no en
 * com fallback. Também expõe o `lang` ativo (p/ marcar o item no picker etc.).
 */
export interface I18n {
  readonly lang: Lang;
  readonly t: TFunction;
}

export function i18n(lang: Lang = DEFAULT_LANG): I18n {
  return {
    lang,
    t: (key, params) => t(lang, key, params),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aviso de chave faltante — SÓ em dev (NODE_ENV !== 'production'), uma vez por chave
// p/ não spammar. Em produção é silencioso (a degradação p/ a chave já não quebra).
// Nunca lança: i18n é QoL, jamais derruba a TUI.
// ─────────────────────────────────────────────────────────────────────────────
const warned = new Set<string>();
function warnMissingKey(key: string): void {
  if (process.env.NODE_ENV === 'production') return;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[i18n] missing key (no catalog entry): ${key}`);
}
