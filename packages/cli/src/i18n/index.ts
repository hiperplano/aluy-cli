// EST-0989 — barrel do módulo i18n da TUI (`t()` + catálogos + idioma + contexto).
export type { Catalog, I18nKey, I18nParams, FullCatalog, PartialCatalog } from './catalog.js';
export {
  type Lang,
  type LangEntry,
  DEFAULT_LANG,
  LANGS,
  langByCode,
  resolveLang,
  detectLangFromLocale,
  resolveInitialLang,
} from './lang.js';
export { ptBR } from './pt-BR.js';
export { en } from './en.js';
export { t, i18n, interpolate, resolveText, type TFunction, type I18n } from './translate.js';
export { I18nProvider, useI18n } from './context.js';
