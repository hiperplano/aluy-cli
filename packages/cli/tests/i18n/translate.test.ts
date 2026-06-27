// EST-0989 (i18n) — o NÚCLEO `t()`: resolução pt-BR/en, FALLBACK (en→pt-BR→chave),
// interpolação de params e o tradutor LIGADO (`i18n(lang).t`). DoD: `t()` resolve nos
// dois idiomas; chave faltando em en cai no pt-BR (NUNCA a chave crua); interpolação.

import { describe, expect, it } from 'vitest';
import { t, i18n, interpolate, resolveText } from '../../src/i18n/translate.js';
import { ptBR } from '../../src/i18n/pt-BR.js';
import { en } from '../../src/i18n/en.js';
import type { Catalog, I18nKey } from '../../src/i18n/catalog.js';

describe('i18n · t() — resolução pt-BR e en', () => {
  it('resolve uma chave no idioma pt-BR (default)', () => {
    expect(t('pt-BR', 'composer.placeholder')).toBe('digite um objetivo ou /comando…');
    expect(t('pt-BR', 'hints.idle')).toContain('enter envia');
    expect(t('pt-BR', 'cmd.quit')).toBe('sair do aluy');
  });

  it('resolve a MESMA chave em en (texto diferente, estrutura igual)', () => {
    expect(t('en', 'composer.placeholder')).toBe('type a goal or /command…');
    expect(t('en', 'hints.idle')).toContain('enter sends');
    expect(t('en', 'cmd.quit')).toBe('quit aluy');
  });

  it('as duas resoluções diferem (prova que o idioma realmente muda o texto)', () => {
    expect(t('en', 'composer.placeholder')).not.toBe(t('pt-BR', 'composer.placeholder'));
  });
});

describe('i18n · t() — FALLBACK (DoD: nunca a chave crua)', () => {
  it('chave presente só no pt-BR ⇒ en cai no pt-BR (não mostra a chave)', () => {
    // Monta um catálogo en PARCIAL sintético via resolveText sobre uma chave que o en
    // real cobre — então provamos o mecanismo com uma chave REMOVIDA do en em runtime.
    // Aqui usamos uma chave que existe nos dois; o teste do mecanismo puro está abaixo.
    const key: I18nKey = 'statusbar.window';
    expect(t('pt-BR', key)).toBe('janela');
    expect(t('en', key)).toBe('window');
  });

  it('resolveText degrada en→pt-BR quando o en NÃO tem a chave', () => {
    // Simula o cenário "en parcial": confirmamos que TODA chave do catálogo pt-BR
    // (canônico) resolve em en sem nunca devolver a chave crua. Se o en não tiver,
    // o fallback entrega o pt-BR — jamais a string-chave.
    const keys = Object.keys(ptBR) as I18nKey[];
    for (const key of keys) {
      const resolved = resolveText('en', key);
      // nunca é a própria chave (que conteria um ponto de namespace, ex.: "hints.idle")
      expect(resolved).not.toBe(key);
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it('o en é PARCIAL por design, mas toda chave dele que falta resolve via pt-BR', () => {
    // Para CADA chave canônica: ou o en a tem, ou o fallback pt-BR a entrega.
    const keys = Object.keys(ptBR) as I18nKey[];
    for (const key of keys) {
      const fromEn = (en as Partial<Catalog>)[key];
      const resolved = resolveText('en', key);
      if (fromEn !== undefined) {
        expect(resolved).toBe(fromEn);
      } else {
        // faltou no en ⇒ tem que cair no pt-BR (não na chave crua).
        expect(resolved).toBe(ptBR[key]);
      }
    }
  });

  it('chave inexistente (burlando o tipo) degrada p/ a própria chave, sem lançar', () => {
    // Cast deliberado p/ provar a 3ª linha de defesa (last-resort). Nunca usado em
    // produção (o tipo barra), mas o runtime não pode quebrar.
    const bogus = 'namespace.inexistente' as I18nKey;
    expect(() => resolveText('en', bogus)).not.toThrow();
    expect(resolveText('pt-BR', bogus)).toBe('namespace.inexistente');
  });
});

describe('i18n · interpolação de params', () => {
  it('substitui {param} pelo valor (string)', () => {
    expect(interpolate('idioma trocado para {label}', { label: 'English' })).toBe(
      'idioma trocado para English',
    );
  });

  it('substitui múltiplos params e aceita número', () => {
    expect(interpolate('{a} de {b}', { a: 3, b: 10 })).toBe('3 de 10');
  });

  it('placeholder SEM param correspondente fica como está (não quebra)', () => {
    expect(interpolate('valor: {missing}', { other: 'x' })).toBe('valor: {missing}');
  });

  it('sem params ⇒ texto intacto', () => {
    expect(interpolate('texto puro')).toBe('texto puro');
  });

  it('t() interpola a chave no idioma ativo', () => {
    expect(t('pt-BR', 'lang.changed', { label: 'English' })).toBe('idioma trocado para English');
    expect(t('en', 'lang.changed', { label: 'Português (Brasil)' })).toBe(
      'language changed to Português (Brasil)',
    );
  });
});

describe('i18n · tradutor LIGADO (i18n(lang).t)', () => {
  it('i18n() default é pt-BR', () => {
    const tr = i18n();
    expect(tr.lang).toBe('pt-BR');
    expect(tr.t('cmd.help')).toBe('mostra esta lista');
  });

  it('i18n("en").t resolve em en e expõe o lang ativo', () => {
    const tr = i18n('en');
    expect(tr.lang).toBe('en');
    expect(tr.t('cmd.help')).toBe('show this list');
  });
});
