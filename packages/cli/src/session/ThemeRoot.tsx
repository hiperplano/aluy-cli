// EST-0966 — <ThemeRoot>: raiz STATEFUL do tema, acima do <ThemeProvider>.
//
// O tema era resolvido UMA vez (run.tsx) e injetado como valor fixo do provider —
// ótimo p/ o boot, mas o `/theme` precisa TROCAR a paleta em RUNTIME. Para isso, o
// estado do tema ATIVO sobe p/ cá: ao confirmar no picker, re-resolvemos o `Theme`
// (mesmas capacidades do env — NO_COLOR/Unicode/densidade/reduced-motion preservados)
// e re-renderizamos a árvore inteira via o provider. Como TODO componente lê os 7
// papéis por `useTheme()` (nunca cor crua), a troca repinta tudo de uma vez.
//
// Persistência da escolha entre execuções = FU (estado de sessão só, por ora).

import React, { useCallback, useMemo, useState } from 'react';
import { ThemeProvider } from '../ui/theme/index.js';
import { resolveThemeByName, type ThemeName } from '../ui/theme/themes.js';
import type { Density } from '../ui/theme/theme.js';
import { I18nProvider, i18n as makeI18n, DEFAULT_LANG, type Lang } from '../i18n/index.js';
import { App, type AppProps } from './App.js';

export interface ThemeRootProps extends Omit<
  AppProps,
  'currentTheme' | 'onSelectTheme' | 'currentLang' | 'onSelectLang'
> {
  /** Tema NOMEADO inicial (resolvido no boot: auto-detecção OSC 11 ou default dark). */
  readonly initialTheme: ThemeName;
  /** Env p/ re-resolver as capacidades ao trocar (preserva NO_COLOR/Unicode/etc.). */
  readonly env?: NodeJS.ProcessEnv;
  /** Densidade compacta (`--dense`) — preservada na troca. */
  readonly density?: Density;
  /**
   * EST-0984 — perfil SEGURO de glifos (`--ascii`/ALUY_SAFE_GLYPHS): preservado
   * ao trocar de tema (a capacidade da fonte não muda com a paleta).
   */
  readonly safeGlyphs?: boolean;
  /** Notifica o wiring quando o tema muda (ex.: empurrar a nota). Opcional. */
  readonly onThemeChanged?: (theme: ThemeName) => void;
  /**
   * EST-0989 (i18n) — idioma INICIAL (resolvido no boot: flag > config > auto-detect >
   * pt-BR). Ausente ⇒ pt-BR (default, back-compat com testes que montam App direto).
   */
  readonly initialLang?: Lang;
  /** EST-0989 — notifica o wiring quando o idioma muda (empurrar a nota + persistir). */
  readonly onLangChanged?: (lang: Lang) => void;
}

export function ThemeRoot(props: ThemeRootProps): React.ReactElement {
  const {
    initialTheme,
    env,
    density,
    safeGlyphs,
    onThemeChanged,
    initialLang,
    onLangChanged,
    ...appProps
  } = props;
  const [active, setActive] = useState<ThemeName>(initialTheme);
  // EST-0989 (i18n) — idioma ATIVO sobe p/ cá (paralelo ao tema): ao confirmar no
  // /lang, re-injetamos o `I18n` no provider e re-renderizamos a árvore no novo idioma.
  const [activeLang, setActiveLang] = useState<Lang>(initialLang ?? DEFAULT_LANG);

  const theme = useMemo(
    () =>
      resolveThemeByName(active, {
        ...(env !== undefined ? { env } : {}),
        ...(density !== undefined ? { density } : {}),
        ...(safeGlyphs !== undefined ? { safeGlyphs } : {}),
      }),
    [active, env, density, safeGlyphs],
  );

  // EST-0989 — o `I18n` (lang + `t`) memo pelo idioma ativo: troca de ref só ao mudar
  // de idioma ⇒ `localizeCommands`/componentes re-renderizam só quando precisa.
  const i18nValue = useMemo(() => makeI18n(activeLang), [activeLang]);

  const onSelectTheme = useCallback(
    (name: ThemeName) => {
      setActive(name);
      onThemeChanged?.(name);
    },
    [onThemeChanged],
  );

  const onSelectLang = useCallback(
    (next: Lang) => {
      setActiveLang(next);
      onLangChanged?.(next);
    },
    [onLangChanged],
  );

  return (
    <ThemeProvider theme={theme}>
      <I18nProvider value={i18nValue}>
        <App
          {...appProps}
          currentTheme={active}
          onSelectTheme={onSelectTheme}
          currentLang={activeLang}
          onSelectLang={onSelectLang}
        />
      </I18nProvider>
    </ThemeProvider>
  );
}
