// EST-0957 · fallback NÃO-TTY — `@path` literal no texto do objetivo.

import { describe, expect, it } from 'vitest';
import { parseAtMentions, stripMentions } from '../../src/attach/mentions.js';
import { trailingMention, stripTrailingMention } from '../../src/attach/compose.js';

describe('parseAtMentions — extrai `@path` plausíveis do objetivo', () => {
  it('casa um caminho com `/`', () => {
    const m = parseAtMentions('explique @src/auth/session.ts pra mim');
    expect(m.map((x) => x.path)).toEqual(['src/auth/session.ts']);
  });

  it('casa um caminho com extensão (sem `/`)', () => {
    const m = parseAtMentions('veja @README.md');
    expect(m.map((x) => x.path)).toEqual(['README.md']);
  });

  it('IGNORA `@` solto e tokens que não parecem caminho (@todo)', () => {
    expect(parseAtMentions('isto é @ um @todo qualquer')).toEqual([]);
  });

  // EST-1015 (fix PT-BR) — nomes de arquivo ACENTUADOS: antes `[\w./-]` (ASCII) parava
  // no acento (`@cora`/`@Jos`) e a menção sumia/quebrava. Agora casa o nome inteiro.
  it('casa nome de arquivo ACENTUADO inteiro (PT-BR: coração/configuração/José)', () => {
    expect(parseAtMentions('veja @coração.md aqui').map((x) => x.path)).toEqual(['coração.md']);
    expect(parseAtMentions('@configuração.json').map((x) => x.path)).toEqual(['configuração.json']);
    expect(parseAtMentions('abre @José.pdf').map((x) => x.path)).toEqual(['José.pdf']);
    // acento DENTRO de um caminho com `/` também (currículo, ação).
    expect(
      parseAtMentions('compara @docs/currículo.txt e @src/ação.ts').map((x) => x.path),
    ).toEqual(['docs/currículo.txt', 'src/ação.ts']);
  });

  it('e-mail acentuado/normal segue REJEITADO mesmo com o token Unicode', () => {
    expect(parseAtMentions('manda pra josé@hôst.com agora')).toEqual([]);
  });

  it('IGNORA e-mail (@ colado a uma palavra, não em borda)', () => {
    expect(parseAtMentions('mande pra user@host.com agora')).toEqual([]);
  });

  it('multi: extrai vários anexos (CA-5)', () => {
    const m = parseAtMentions('compare @a/x.ts e @b/y.ts');
    expect(m.map((x) => x.path)).toEqual(['a/x.ts', 'b/y.ts']);
  });

  it('valida start/end — menção no início da string (branch `^` do regex)', () => {
    // '@src/auth.ts' tem 12 chars → start=0, end=12
    const m = parseAtMentions('@src/auth.ts pra mim');
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual({ path: 'src/auth.ts', start: 0, end: 12 });
  });

  it('valida start/end — menção no meio da string', () => {
    // 'analise ' = 8 chars, '@src/auth.ts' = 12 chars → start=8, end=20
    const m = parseAtMentions('analise @src/auth.ts agora');
    expect(m).toHaveLength(1);
    expect(m[0]).toEqual({ path: 'src/auth.ts', start: 8, end: 20 });
  });

  it('stripMentions remove os tokens e normaliza espaços', () => {
    const text = 'compare @a/x.ts e @b/y.ts';
    const m = parseAtMentions(text);
    expect(stripMentions(text, m)).toBe('compare e');
  });

  it('stripMentions — menção na posição 0 deixa texto limpo', () => {
    const text = '@src/auth.ts pra mim';
    const m = parseAtMentions(text);
    expect(stripMentions(text, m)).toBe('pra mim');
  });

  // EST-1015 — PONTO FINAL de frase colado ao token cru. Antes, o `.` GREEDY-engolido
  // OU sumia a menção (`@config.ts.` ⇒ `looksLikePath` falha ⇒ []) OU ia ao reader como
  // path ERRADO (`@src/app.ts.` ⇒ `src/app.ts.`, arquivo inexistente). O ponto final é
  // pontuação, não parte do nome — aparado do path, mas PRESERVADO no goal.
  describe('ponto final de frase colado ao token (EST-1015)', () => {
    it('`@config.ts.` resolve `config.ts` (não some a menção)', () => {
      const m = parseAtMentions('veja @config.ts.');
      expect(m.map((x) => x.path)).toEqual(['config.ts']);
    });

    it('`@src/app.ts.` resolve `src/app.ts` (não o path ERRADO `src/app.ts.`)', () => {
      const m = parseAtMentions('olha o @src/app.ts. obrigado');
      expect(m.map((x) => x.path)).toEqual(['src/app.ts']);
    });

    it('reticências `@README.md...` resolvem `README.md`', () => {
      expect(parseAtMentions('@README.md...').map((x) => x.path)).toEqual(['README.md']);
    });

    it('o ponto final PERMANECE no goal como pontuação (não some junto)', () => {
      const text = 'veja @config.ts. obrigado';
      const m = parseAtMentions(text);
      expect(stripMentions(text, m)).toBe('veja . obrigado');
    });

    it('NÃO regride caminhos relativos `@../x.ts` e `@./x.ts` (dots à ESQUERDA)', () => {
      expect(parseAtMentions('@../fora.ts').map((x) => x.path)).toEqual(['../fora.ts']);
      expect(parseAtMentions('@./rel.ts').map((x) => x.path)).toEqual(['./rel.ts']);
    });

    it('unicode + ponto final: `@coração.md.` resolve `coração.md`', () => {
      expect(parseAtMentions('veja @coração.md.').map((x) => x.path)).toEqual(['coração.md']);
    });
  });
});

describe('parseAtMentions — caminhos COM ESPAÇO (BUG-0019)', () => {
  it('aspas DUPLAS: `@"a b.md"` resolve `a b.md`', () => {
    const m = parseAtMentions('veja @"a b.md" por favor');
    expect(m.map((x) => x.path)).toEqual(['a b.md']);
  });

  it("aspas SIMPLES: `@'c d.txt'` resolve `c d.txt`", () => {
    const m = parseAtMentions("veja @'c d.txt' por favor");
    expect(m.map((x) => x.path)).toEqual(['c d.txt']);
  });

  it('barra-espaço ESCAPADO: `@esc\\ aped.md` resolve `esc aped.md`', () => {
    const m = parseAtMentions('abra @esc\\ aped.md agora');
    expect(m.map((x) => x.path)).toEqual(['esc aped.md']);
  });

  it('caminho com `/` E espaço entre aspas: `@"Documents/My Report.md"`', () => {
    const m = parseAtMentions('leia @"Documents/My Report.md" inteiro');
    expect(m.map((x) => x.path)).toEqual(['Documents/My Report.md']);
  });

  it('NÃO regride: `@normal.ts` (sem espaço) fica IDÊNTICO', () => {
    expect(parseAtMentions('veja @normal.ts').map((x) => x.path)).toEqual(['normal.ts']);
    expect(parseAtMentions('veja @src/auth/session.ts').map((x) => x.path)).toEqual([
      'src/auth/session.ts',
    ]);
  });

  it('aspas NÃO-FECHADAS degradam — não engolem o resto da linha', () => {
    // `@"a b.md` (sem fechar): a alternativa de aspas não casa; degrada p/ o token
    // cru, que NÃO inclui o `"` nem o espaço ⇒ não casa caminho plausível ⇒ vazio.
    expect(parseAtMentions('veja @"a b.md e mais texto aqui')).toEqual([]);
  });

  it('aspas não-fechadas: o que vem depois NÃO vira path do reader', () => {
    const m = parseAtMentions('cmd @"sem fim README.md e o resto');
    // README.md está SOLTO (não colado a `@` em borda) ⇒ nenhuma menção.
    expect(m).toEqual([]);
  });

  it('stripMentions remove o token citado INTEIRO (aspas inclusas)', () => {
    const text = 'leia @"a b.md" agora';
    const m = parseAtMentions(text);
    expect(stripMentions(text, m)).toBe('leia agora');
  });

  it('stripMentions remove o token ESCAPADO inteiro (barra-espaço inclusa)', () => {
    const text = 'leia @esc\\ aped.md agora';
    const m = parseAtMentions(text);
    expect(stripMentions(text, m)).toBe('leia agora');
  });

  it('multi-anexo MISTO: citado + cru no mesmo objetivo', () => {
    const text = 'compare @"a b.md" e @c/d.ts';
    const m = parseAtMentions(text);
    expect(m.map((x) => x.path)).toEqual(['a b.md', 'c/d.ts']);
    expect(stripMentions(text, m)).toBe('compare e');
  });
});

describe('trailingMention — o `@` em digitação no fim do input (TTY)', () => {
  it('detecta `@auth/sess` no fim do input', () => {
    expect(trailingMention('explique @auth/sess')).toEqual({ at: 9, query: 'auth/sess' });
  });

  it('o `@` no começo do input dispara', () => {
    expect(trailingMention('@src')).toEqual({ at: 0, query: 'src' });
  });

  it('NÃO dispara se há espaço após a menção (ela fechou)', () => {
    expect(trailingMention('explique @auth/sess depois')).toBeNull();
  });

  it('NÃO dispara p/ `@` colado a uma palavra (email@)', () => {
    expect(trailingMention('user@host')).toBeNull();
  });

  it('stripTrailingMention remove o `@query` em digitação', () => {
    expect(stripTrailingMention('explique @auth/sess')).toBe('explique');
    expect(stripTrailingMention('@src')).toBe('');
  });
});
