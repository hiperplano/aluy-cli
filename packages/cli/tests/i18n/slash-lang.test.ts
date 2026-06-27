// EST-0989 (i18n) — o slash `/lang`: registro do comando, buildLangEffect (lista/
// troca/inválido/já-ativo), localizeCommands (summaries no idioma ativo) e o
// runLangLinear (não-TTY). DoD: /lang troca; código inválido ⇒ nota honesta; default
// pt-BR nas listagens.

import { describe, expect, it } from 'vitest';
import { NATIVE_COMMANDS, localizeCommands, routeInput } from '../../src/slash/commands.js';
import { buildLangEffect } from '../../src/slash/handlers.js';
import { runLangLinear } from '../../src/session/linear.js';
import { i18n as makeI18n } from '../../src/i18n/translate.js';

describe('/lang — registro do comando nativo', () => {
  it('existe no catálogo de nativos, na seção sessão, com summaryKey i18n', () => {
    const lang = NATIVE_COMMANDS.find((c) => c.id === 'lang');
    expect(lang).toBeDefined();
    expect(lang?.name).toBe('lang');
    expect(lang?.section).toBe('sessão');
    expect(lang?.summaryKey).toBe('cmd.lang');
  });

  it('routeInput reconhece /lang e /lang en como comando', () => {
    const r1 = routeInput('/lang');
    expect(r1.kind).toBe('command');
    if (r1.kind === 'command') expect(r1.command.id).toBe('lang');
    const r2 = routeInput('/lang en');
    if (r2.kind === 'command') {
      expect(r2.command.id).toBe('lang');
      expect(r2.args).toBe('en');
    }
  });
});

describe('buildLangEffect — lista/troca/inválido/já-ativo', () => {
  it('sem arg ⇒ LISTA os idiomas (não troca), marca o ativo com ●', () => {
    const e = buildLangEffect('', 'pt-BR');
    expect(e.kind).toBe('lang');
    if (e.kind === 'lang') {
      expect(e.lang).toBeUndefined(); // não troca
      const text = e.note.lines.join('\n');
      expect(text).toContain('pt-BR');
      expect(text).toContain('en');
      expect(text).toContain('●'); // o ativo marcado
    }
  });

  it('arg válido (en) a partir de pt-BR ⇒ troca p/ en, confirmação NO IDIOMA NOVO', () => {
    const e = buildLangEffect('en', 'pt-BR');
    if (e.kind === 'lang') {
      expect(e.lang).toBe('en');
      // a confirmação já sai em inglês (feedback imediato no idioma escolhido)
      expect(e.note.lines.join('\n')).toContain('language changed to');
    }
  });

  it('arg = idioma JÁ ATIVO ⇒ não troca (lang undefined), nota "idioma atual"', () => {
    const e = buildLangEffect('pt-BR', 'pt-BR');
    if (e.kind === 'lang') {
      expect(e.lang).toBeUndefined();
      expect(e.note.lines.join('\n')).toContain('idioma atual');
    }
  });

  it('arg INVÁLIDO ⇒ não troca, nota honesta "idioma desconhecido"', () => {
    const e = buildLangEffect('klingon', 'pt-BR');
    if (e.kind === 'lang') {
      expect(e.lang).toBeUndefined();
      expect(e.note.lines.join('\n')).toContain('idioma desconhecido');
      expect(e.note.lines.join('\n')).toContain('klingon');
    }
  });
});

describe('localizeCommands — summaries no idioma ativo', () => {
  it('pt-BR (default) ⇒ MESMA referência (sem churn) e summaries pt-BR', () => {
    const tpt = makeI18n('pt-BR').t;
    const out = localizeCommands(NATIVE_COMMANDS, tpt);
    // pt-BR == os summaries canônicos ⇒ devolve a mesma ref (estabilidade)
    expect(out).toBe(NATIVE_COMMANDS);
    expect(out.find((c) => c.id === 'quit')?.summary).toBe('sair do aluy');
  });

  it('en ⇒ summaries traduzidos (ref nova; comandos sem summaryKey intactos)', () => {
    const ten = makeI18n('en').t;
    const out = localizeCommands(NATIVE_COMMANDS, ten);
    expect(out).not.toBe(NATIVE_COMMANDS); // mudou ⇒ ref nova
    expect(out.find((c) => c.id === 'quit')?.summary).toBe('quit aluy');
    expect(out.find((c) => c.id === 'help')?.summary).toBe('show this list');
    // `lang` aparece traduzido
    expect(out.find((c) => c.id === 'lang')?.summary).toContain('switch the language');
  });

  it('comandos sem summaryKey (Fase 2) preservam o summary pt-BR mesmo em en', () => {
    const ten = makeI18n('en').t;
    const out = localizeCommands(NATIVE_COMMANDS, ten);
    // `split`/`agents` não migraram (Fase 2) ⇒ seguem em pt-BR (fallback por omissão)
    const split = out.find((c) => c.id === 'split');
    if (split) expect(split.summary).toContain('liga/desliga');
  });

  // EST-1015 (UX redesign) — o cockpit DEIXOU de ser "experimental" (os gatilhos de
  // corrupção sob streaming foram corrigidos). O summary do `/fullscreen` no /help NÃO
  // carrega mais "(experimental)" nem "inline é o default" — é só a descrição do modo.
  it('/fullscreen NÃO se auto-deprecia no /help (sem "experimental", pt-BR e en)', () => {
    const tpt = makeI18n('pt-BR').t;
    const tEn = makeI18n('en').t;
    const pt = localizeCommands(NATIVE_COMMANDS, tpt).find((c) => c.id === 'fullscreen');
    const en = localizeCommands(NATIVE_COMMANDS, tEn).find((c) => c.id === 'fullscreen');
    expect(pt?.summary).not.toContain('experimental');
    expect(en?.summary).not.toContain('experimental');
    expect(pt?.summary).toContain('cockpit');
  });
});

describe('runLangLinear — não-TTY', () => {
  function capture(): { out: { write(s: string): void }; lines: string[] } {
    const lines: string[] = [];
    return { out: { write: (s: string) => lines.push(s) }, lines };
  }

  it('/lang (sem arg) lista os idiomas rotulados [lang]', () => {
    const { out, lines } = capture();
    const handled = runLangLinear('/lang', out, { currentLang: 'pt-BR' });
    expect(handled).toBe(true);
    const text = lines.join('');
    expect(text).toContain('[lang]');
    expect(text).toContain('pt-BR');
    expect(text).toContain('en');
  });

  it('/lang en registra a troca (confirmação em inglês)', () => {
    const { out, lines } = capture();
    const handled = runLangLinear('/lang en', out, { currentLang: 'pt-BR' });
    expect(handled).toBe(true);
    expect(lines.join('')).toContain('language changed to');
  });

  it('uma linha que NÃO é /lang ⇒ não trata (handled=false)', () => {
    const { out } = capture();
    expect(runLangLinear('faça algo', out, { currentLang: 'pt-BR' })).toBe(false);
    expect(runLangLinear('/theme', out, { currentLang: 'pt-BR' })).toBe(false);
  });
});
