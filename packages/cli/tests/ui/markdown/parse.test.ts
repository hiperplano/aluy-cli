// EST · acabamento TUI — testes do PARSER de markdown (puro, sem Ink).

import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../../../src/ui/markdown/parse.js';

describe('parseInline — spans', () => {
  it('negrito **x** e __x__', () => {
    expect(parseInline('a **b** c')).toEqual([
      { kind: 'plain', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'plain', text: ' c' },
    ]);
    expect(parseInline('__b__')).toEqual([{ kind: 'bold', text: 'b' }]);
  });

  it('itálico *x* e _x_', () => {
    expect(parseInline('um *it* dois')).toEqual([
      { kind: 'plain', text: 'um ' },
      { kind: 'italic', text: 'it' },
      { kind: 'plain', text: ' dois' },
    ]);
  });

  // EST-1015 (fix) — `***x***`/`___x___` (bold+itálico) deixava os `*` EXTERNOS soltos na
  // tela (`*𝐱*`): a regex de bold é `[^*]+`, então casava o `**x**` INTERNO. O grupo TRIPLO
  // (antes do bold) consome os 3 delimitadores ⇒ BOLD limpo (sem tipo combinado).
  it('triplo ***x*** / ___x___ ⇒ BOLD limpo (sem asterisco solto)', () => {
    expect(parseInline('***forte***')).toEqual([{ kind: 'bold', text: 'forte' }]);
    expect(parseInline('___forte___')).toEqual([{ kind: 'bold', text: 'forte' }]);
    expect(parseInline('texto ***importante*** aqui')).toEqual([
      { kind: 'plain', text: 'texto ' },
      { kind: 'bold', text: 'importante' },
      { kind: 'plain', text: ' aqui' },
    ]);
    // não regride o **bold** / *itálico* normais (mistos numa linha).
    expect(parseInline('a **b** c *d* e')).toEqual([
      { kind: 'plain', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'plain', text: ' c ' },
      { kind: 'italic', text: 'd' },
      { kind: 'plain', text: ' e' },
    ]);
  });

  // EST-1015 (fix) — o `_` NÃO é ênfase NO MEIO de palavra (CommonMark): snake_case na
  // prosa técnica do modelo virava itálico espúrio (`some_variable_name` → "…_variable_…").
  it('underscore INTRAWORD não vira ênfase (snake_case fica PLAIN)', () => {
    expect(parseInline('use some_variable_name aqui')).toEqual([
      { kind: 'plain', text: 'use some_variable_name aqui' },
    ]);
    expect(parseInline('a func get_user_by_id() retorna')).toEqual([
      { kind: 'plain', text: 'a func get_user_by_id() retorna' },
    ]);
    // double-underscore intraword também NÃO vira bold nem vaza itálico.
    expect(parseInline('o my__double__under name')).toEqual([
      { kind: 'plain', text: 'o my__double__under name' },
    ]);
  });

  it('underscore com BORDA segue sendo ênfase (legítimo)', () => {
    expect(parseInline('a _word_ b')).toEqual([
      { kind: 'plain', text: 'a ' },
      { kind: 'italic', text: 'word' },
      { kind: 'plain', text: ' b' },
    ]);
    expect(parseInline('isto é __forte__ aqui')).toEqual([
      { kind: 'plain', text: 'isto é ' },
      { kind: 'bold', text: 'forte' },
      { kind: 'plain', text: ' aqui' },
    ]);
  });

  it('asterisco intraword PERMANECE ênfase (CommonMark permite `*`)', () => {
    expect(parseInline('2*3*4')).toEqual([
      { kind: 'plain', text: '2' },
      { kind: 'italic', text: '3' },
      { kind: 'plain', text: '4' },
    ]);
  });

  it('código inline `x`', () => {
    expect(parseInline('use `config.ts` aqui')).toEqual([
      { kind: 'plain', text: 'use ' },
      { kind: 'code', text: 'config.ts' },
      { kind: 'plain', text: ' aqui' },
    ]);
  });

  it('link [texto](url) preserva texto e URL', () => {
    expect(parseInline('veja [ADR](https://a.dev/41)!')).toEqual([
      { kind: 'plain', text: 'veja ' },
      { kind: 'link', text: 'ADR', url: 'https://a.dev/41' },
      { kind: 'plain', text: '!' },
    ]);
  });

  it('texto puro é um único span plano', () => {
    expect(parseInline('sem marcação')).toEqual([{ kind: 'plain', text: 'sem marcação' }]);
  });
});

describe('parseMarkdown — blocos', () => {
  it('títulos por nível', () => {
    const b = parseMarkdown('# T1\n## T2');
    expect(b[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(b[1]).toMatchObject({ kind: 'heading', level: 2 });
  });

  it('lista não-ordenada e ordenada', () => {
    const b = parseMarkdown('- a\n- b\n1. c');
    expect(b[0]).toMatchObject({ kind: 'list-item', ordered: false, marker: '-' });
    expect(b[2]).toMatchObject({ kind: 'list-item', ordered: true, marker: '1.' });
  });

  it('citação >', () => {
    const b = parseMarkdown('> cuidado');
    expect(b[0]).toMatchObject({ kind: 'quote' });
  });

  it('cerca ```lang fechada vira bloco de código com lang e closed:true', () => {
    const b = parseMarkdown('```ts\nconst x = 1;\n```');
    expect(b[0]).toEqual({ kind: 'code', lang: 'ts', code: 'const x = 1;', closed: true });
  });

  it('cerca ABERTA (stream no meio) ⇒ closed:false, sem markdown vazando', () => {
    const b = parseMarkdown('texto\n```ts\nconst x = 1\nconst **y** = 2');
    expect(b[0]).toMatchObject({ kind: 'paragraph' });
    expect(b[1]).toMatchObject({
      kind: 'code',
      lang: 'ts',
      closed: false,
      code: 'const x = 1\nconst **y** = 2', // inline NÃO é interpretado dentro do código
    });
  });

  it('parágrafos separados por linha em branco', () => {
    const b = parseMarkdown('um\n\ndois');
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ kind: 'paragraph' });
    expect(b[1]).toMatchObject({ kind: 'paragraph' });
  });

  it('cerca sem linguagem ⇒ lang undefined', () => {
    const b = parseMarkdown('```\nplain\n```');
    expect(b[0]).toEqual({ kind: 'code', lang: undefined, code: 'plain', closed: true });
  });
});
