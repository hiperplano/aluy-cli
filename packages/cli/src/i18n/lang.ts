// EST-0989 · i18n — IDIOMAS suportados pela TUI + auto-detecção do locale do SO.
//
// A TUI nasceu só pt-BR; o app web já tem i18n e o Tiago quer o mesmo no terminal.
// Começamos com pt-BR (DEFAULT, projeto pt-BR-first) + en (opt-in). Aqui mora o
// EIXO de idioma (puro, testável): o tipo `Lang`, o catálogo LISTÁVEL p/ o `/lang`
// (espelha o `THEMES` do `/theme`), a auto-detecção do locale e a resolução de
// precedência (flag > config > auto-detect > pt-BR).
//
// Espelha a mecânica do `/theme` (EST-0966) e do tier (EST-0962/0969): DADO
// listável + resolução de precedência PURA (sem I/O), p/ a App apenas aplicar.

/** Os idiomas suportados (o que o usuário digita em `/lang <code>` / `--lang`). */
export type Lang = 'pt-BR' | 'en';

/** O idioma DEFAULT quando nada o sobrepõe (projeto pt-BR-first). */
export const DEFAULT_LANG: Lang = 'pt-BR';

/** Uma entrada do catálogo de idiomas (DADO p/ o picker — nunca hardcode por tela). */
export interface LangEntry {
  /** Código canônico (BCP-47 curto). */
  readonly code: Lang;
  /** Rótulo no idioma NATIVO (auto-glota — sempre legível p/ quem fala aquele idioma). */
  readonly label: string;
  /** Uma linha de descrição (a11y / discoverability no picker). */
  readonly summary: string;
}

/** O catálogo de idiomas (ordem = ordem no picker). pt-BR (default) primeiro. */
export const LANGS: readonly LangEntry[] = [
  {
    code: 'pt-BR',
    label: 'Português (Brasil)',
    summary: 'idioma padrão da TUI',
  },
  {
    code: 'en',
    label: 'English',
    summary: 'English interface (opt-in)',
  },
];

/** Busca uma entrada pelo código canônico (exato). */
export function langByCode(code: string): LangEntry | undefined {
  return LANGS.find((l) => l.code === code);
}

/**
 * Resolve uma string do usuário (`/lang <code>` / `--lang`) p/ um idioma do
 * catálogo. Aceita o código canônico (`pt-BR`/`en`), variações de caixa (`PT-BR`,
 * `EN`), o subtag de língua só (`pt` ⇒ pt-BR, `pt-br`, `português`/`portugues`,
 * `english`/`inglês`/`ingles`). Devolve `undefined` se não casar (o caller avisa).
 */
export function resolveLang(input: string): LangEntry | undefined {
  const q = input.trim().toLowerCase();
  if (q === '') return undefined;
  // código canônico, case-insensitive (`pt-br`, `PT-BR`).
  const byCode = LANGS.find((l) => l.code.toLowerCase() === q);
  if (byCode) return byCode;
  // subtag de língua / apelidos legíveis.
  if (q === 'pt' || q === 'pt_br' || q === 'br' || q === 'português' || q === 'portugues') {
    return langByCode('pt-BR');
  }
  if (q === 'en' || q === 'en_us' || q === 'english' || q === 'inglês' || q === 'ingles') {
    return langByCode('en');
  }
  return undefined;
}

/**
 * AUTO-DETECÇÃO do idioma a partir do LOCALE do SO. pt-BR-first: só PROMOVE `en`
 * quando o locale é CLARAMENTE inglês (`en`/`en_US`/`en-GB`…); qualquer outra coisa
 * (incl. ausência de locale, pt, es, fr, …) cai no DEFAULT pt-BR. Lê `LC_ALL` >
 * `LC_MESSAGES` > `LANG` (a ordem de precedência POSIX). Puro: recebe o `env`.
 *
 * Decisão de produto (ADR de i18n, sinalizada ao arquiteto): o terminal é pt-BR-
 * first como o resto da Aluy; en é opt-in. Por isso NÃO mapeamos "qualquer não-pt
 * ⇒ en" — só o que é inequivocamente inglês vira en; o universo restante segue
 * pt-BR (o usuário troca explícito por `/lang en` / `--lang en` se quiser).
 */
export function detectLangFromLocale(env: NodeJS.ProcessEnv): Lang {
  const raw = (env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? '').trim().toLowerCase();
  if (raw === '') return DEFAULT_LANG;
  // descarta `.encoding`/`@modifier` (`en_us.utf-8`, `pt_br.utf-8@euro`) e normaliza
  // o separador `_`→`-` p/ pegar só a tag de língua/região.
  const tag = raw.split('.')[0]!.split('@')[0]!.replace('_', '-');
  // `C`/`POSIX` = locale "neutro" ⇒ não é inglês explícito ⇒ pt-BR (default).
  if (tag === 'c' || tag === 'posix') return DEFAULT_LANG;
  // só o subtag de língua `en` (com ou sem região) PROMOVE en.
  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  return DEFAULT_LANG;
}

/**
 * Resolve o idioma INICIAL combinando as fontes por PRECEDÊNCIA (puro, testável):
 *   flag (`--lang`) > config salva (`~/.aluy/config.json`) > auto-detect do locale
 *   > DEFAULT pt-BR.
 * `flag`/`config` inválidos ou ausentes caem p/ o próximo nível (nunca quebram).
 * Espelha o `resolveInitialTier`/`configuredTheme` (EST-0969) — a mesma cadeia de
 * preferência do usuário > auto > default, agora p/ o eixo de idioma.
 */
export function resolveInitialLang(
  flag: string | undefined,
  configLang: Lang | undefined,
  env: NodeJS.ProcessEnv,
): Lang {
  // (1) flag explícita vence tudo (mas só se for um código válido; lixo cai adiante).
  if (flag !== undefined && flag.trim() !== '') {
    const entry = resolveLang(flag);
    if (entry) return entry.code;
  }
  // (2) config salva (já validada no load do UserConfigStore).
  if (configLang !== undefined) return configLang;
  // (3) auto-detect do locale (pt-BR-first: só en quando claramente inglês).
  return detectLangFromLocale(env);
}
