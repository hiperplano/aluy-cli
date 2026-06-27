// EST-0989 · i18n — contexto React do idioma + hook de consumo.
//
// Espelha o `theme/context.tsx`: o componente raiz resolve o idioma UMA vez
// (resolveInitialLang) e injeta um `I18n` (lang + `t`) aqui; os componentes leem via
// `useI18n()` e chamam `t('chave', params?)` — NUNCA string hardcoded de UI. Trocar de
// idioma em sessão (`/lang`) re-injeta um `I18n` novo ⇒ re-render da árvore (mesma
// mecânica do `/theme` re-resolvendo o `Theme`).

import React, { createContext, useContext } from 'react';
import { i18n as makeI18n, type I18n } from './translate.js';
import { DEFAULT_LANG } from './lang.js';

const I18nContext = createContext<I18n>(makeI18n(DEFAULT_LANG));

export function I18nProvider(props: {
  readonly value: I18n;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return <I18nContext.Provider value={props.value}>{props.children}</I18nContext.Provider>;
}

/** O `I18n` ativo (lang + `t`). Componentes chamam `useI18n().t('chave')`. */
export function useI18n(): I18n {
  return useContext(I18nContext);
}
