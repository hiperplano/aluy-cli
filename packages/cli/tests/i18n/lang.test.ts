// EST-0989 (i18n) — o EIXO de idioma: catálogo listável, resolução de string do
// usuário, auto-detecção do locale do SO e a PRECEDÊNCIA (flag > config > auto-detect
// > pt-BR). DoD: auto-detect; default pt-BR; flag/config vencem o auto-detect.

import { describe, expect, it } from 'vitest';
import {
  LANGS,
  DEFAULT_LANG,
  langByCode,
  resolveLang,
  detectLangFromLocale,
  resolveInitialLang,
  type Lang,
} from '../../src/i18n/lang.js';

describe('i18n · catálogo de idiomas', () => {
  it('o default é pt-BR e é o PRIMEIRO do catálogo (pt-BR-first)', () => {
    expect(DEFAULT_LANG).toBe('pt-BR');
    expect(LANGS[0]?.code).toBe('pt-BR');
  });

  it('tem exatamente pt-BR e en na Fase 1, com rótulo auto-glota', () => {
    expect(LANGS.map((l) => l.code)).toEqual(['pt-BR', 'en']);
    expect(langByCode('pt-BR')?.label).toBe('Português (Brasil)');
    expect(langByCode('en')?.label).toBe('English');
  });

  it('langByCode rejeita código desconhecido', () => {
    expect(langByCode('fr')).toBeUndefined();
    expect(langByCode('')).toBeUndefined();
  });
});

describe('i18n · resolveLang (string do usuário → idioma)', () => {
  it('aceita o código canônico (case-insensitive)', () => {
    expect(resolveLang('pt-BR')?.code).toBe('pt-BR');
    expect(resolveLang('PT-BR')?.code).toBe('pt-BR');
    expect(resolveLang('en')?.code).toBe('en');
    expect(resolveLang('EN')?.code).toBe('en');
  });

  it('aceita apelidos legíveis e subtags', () => {
    expect(resolveLang('pt')?.code).toBe('pt-BR');
    expect(resolveLang('português')?.code).toBe('pt-BR');
    expect(resolveLang('portugues')?.code).toBe('pt-BR');
    expect(resolveLang('english')?.code).toBe('en');
    expect(resolveLang('inglês')?.code).toBe('en');
  });

  it('rejeita lixo / vazio (undefined ⇒ o caller dá nota honesta)', () => {
    expect(resolveLang('klingon')).toBeUndefined();
    expect(resolveLang('  ')).toBeUndefined();
    expect(resolveLang('')).toBeUndefined();
  });
});

describe('i18n · detectLangFromLocale (pt-BR-first; só en quando claramente inglês)', () => {
  const detect = (env: Record<string, string | undefined>): Lang =>
    detectLangFromLocale(env as NodeJS.ProcessEnv);

  it('LANG en_US.UTF-8 ⇒ en', () => {
    expect(detect({ LANG: 'en_US.UTF-8' })).toBe('en');
  });

  it('LANG en-GB ⇒ en (com região, separador `-`)', () => {
    expect(detect({ LANG: 'en-GB' })).toBe('en');
  });

  it('LANG pt_BR.UTF-8 ⇒ pt-BR', () => {
    expect(detect({ LANG: 'pt_BR.UTF-8' })).toBe('pt-BR');
  });

  it('locale NÃO-inglês (es/fr/de) ⇒ pt-BR (pt-BR-first; só en é promovido)', () => {
    expect(detect({ LANG: 'es_ES.UTF-8' })).toBe('pt-BR');
    expect(detect({ LANG: 'fr_FR.UTF-8' })).toBe('pt-BR');
    expect(detect({ LANG: 'de_DE.UTF-8' })).toBe('pt-BR');
  });

  it('sem locale / vazio / C / POSIX ⇒ pt-BR (default)', () => {
    expect(detect({})).toBe('pt-BR');
    expect(detect({ LANG: '' })).toBe('pt-BR');
    expect(detect({ LANG: 'C' })).toBe('pt-BR');
    expect(detect({ LC_ALL: 'POSIX' })).toBe('pt-BR');
  });

  it('respeita a precedência POSIX LC_ALL > LC_MESSAGES > LANG', () => {
    // LC_ALL=en vence o LANG=pt
    expect(detect({ LC_ALL: 'en_US.UTF-8', LANG: 'pt_BR.UTF-8' })).toBe('en');
    // LC_MESSAGES=en vence o LANG=pt (sem LC_ALL)
    expect(detect({ LC_MESSAGES: 'en_US.UTF-8', LANG: 'pt_BR.UTF-8' })).toBe('en');
    // LC_ALL=pt vence o LANG=en
    expect(detect({ LC_ALL: 'pt_BR.UTF-8', LANG: 'en_US.UTF-8' })).toBe('pt-BR');
  });

  it('um "en" embutido em outra tag (ex.: token) NÃO promove en por engano', () => {
    // `token` não é `en` nem `en-*` ⇒ pt-BR.
    expect(detect({ LANG: 'token_TK.UTF-8' })).toBe('pt-BR');
  });
});

describe('i18n · resolveInitialLang (PRECEDÊNCIA flag > config > auto-detect > pt-BR)', () => {
  const enLocale = { LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv;
  const ptLocale = { LANG: 'pt_BR.UTF-8' } as NodeJS.ProcessEnv;
  const noLocale = {} as NodeJS.ProcessEnv;

  it('flag VENCE tudo (config + auto-detect)', () => {
    expect(resolveInitialLang('en', 'pt-BR', ptLocale)).toBe('en');
    expect(resolveInitialLang('pt-BR', 'en', enLocale)).toBe('pt-BR');
  });

  it('flag inválida cai p/ o próximo nível (config)', () => {
    expect(resolveInitialLang('klingon', 'en', ptLocale)).toBe('en');
  });

  it('sem flag ⇒ config VENCE o auto-detect', () => {
    expect(resolveInitialLang(undefined, 'en', ptLocale)).toBe('en');
    expect(resolveInitialLang(undefined, 'pt-BR', enLocale)).toBe('pt-BR');
  });

  it('sem flag e sem config ⇒ auto-detect do locale', () => {
    expect(resolveInitialLang(undefined, undefined, enLocale)).toBe('en');
    expect(resolveInitialLang(undefined, undefined, ptLocale)).toBe('pt-BR');
  });

  it('nada (sem flag/config, locale neutro) ⇒ pt-BR default', () => {
    expect(resolveInitialLang(undefined, undefined, noLocale)).toBe('pt-BR');
  });
});
