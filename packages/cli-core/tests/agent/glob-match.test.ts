// EST-0944 — matcher de GLOB→REGEX PURO (anti-ReDoS). Testa a tradução de cada token
// glob, a expansão de `{}`, o confinamento de `*`/`?` a um segmento, o `**` cruzando
// `/`, classes `[...]`, escapes, e a REJEIÇÃO de padrões inválidos (erro VISÍVEL).

import { describe, expect, it } from 'vitest';
import {
  compileGlob,
  expandBraces,
  GlobSyntaxError,
  MAX_GLOB_ALTERNATIVES,
  MAX_GLOB_PATTERN_CHARS,
} from '../../src/agent/tools/glob-match.js';

/** Helper: compila e testa um caminho. */
function m(pattern: string, path: string): boolean {
  return compileGlob(pattern)(path);
}

describe('compileGlob — `*` (um segmento, não cruza `/`)', () => {
  it('`*.ts` casa arquivo .ts NA RAIZ, não em subdir', () => {
    expect(m('*.ts', 'a.ts')).toBe(true);
    expect(m('*.ts', 'index.ts')).toBe(true);
    // `*` não cruza `/` ⇒ não casa um caminho com diretório.
    expect(m('*.ts', 'src/a.ts')).toBe(false);
  });

  it('`*` não casa string com `/` (mutação: se virasse `.*` casaria)', () => {
    expect(m('src/*.ts', 'src/a.ts')).toBe(true);
    expect(m('src/*.ts', 'src/deep/a.ts')).toBe(false);
  });

  it('`*` NÃO casa a extensão errada (ancorado no fim)', () => {
    expect(m('*.ts', 'a.tsx')).toBe(false);
    expect(m('*.ts', 'a.ts.bak')).toBe(false);
  });

  it('ancorado no INÍCIO: `a*` não casa `ba`', () => {
    expect(m('a*', 'abc')).toBe(true);
    expect(m('a*', 'bac')).toBe(false);
  });
});

describe('compileGlob — `**` (cruza `/`, qualquer profundidade)', () => {
  it('`**/*.ts` casa em qualquer profundidade', () => {
    expect(m('**/*.ts', 'a.ts')).toBe(true); // raiz (o `/` após `**` é opcional)
    expect(m('**/*.ts', 'src/a.ts')).toBe(true);
    expect(m('**/*.ts', 'src/deep/nested/a.ts')).toBe(true);
    expect(m('**/*.ts', 'src/a.tsx')).toBe(false);
  });

  it('`src/**` casa tudo SOB src (e nada fora)', () => {
    expect(m('src/**', 'src/a.ts')).toBe(true);
    expect(m('src/**', 'src/deep/b.py')).toBe(true);
    expect(m('src/**', 'lib/a.ts')).toBe(false);
  });

  it('`src/**/test_*.py` — `**` no meio + prefixo de segmento', () => {
    expect(m('src/**/test_*.py', 'src/test_a.py')).toBe(true);
    expect(m('src/**/test_*.py', 'src/deep/test_unit.py')).toBe(true);
    expect(m('src/**/test_*.py', 'src/deep/unit.py')).toBe(false); // sem prefixo test_
    expect(m('src/**/test_*.py', 'lib/test_a.py')).toBe(false); // fora de src
  });

  it('`**` é DIFERENTE de `*` (mutação): `**/x` casa `x` na raiz, `*/x` NÃO', () => {
    expect(m('**/x', 'x')).toBe(true);
    expect(m('*/x', 'x')).toBe(false); // `*/` exige um segmento antes
    expect(m('*/x', 'a/x')).toBe(true);
  });
});

describe('compileGlob — `?` (1 char, não `/`)', () => {
  it('casa exatamente 1 char', () => {
    expect(m('a?.ts', 'ab.ts')).toBe(true);
    expect(m('a?.ts', 'a.ts')).toBe(false); // 0 chars
    expect(m('a?.ts', 'abc.ts')).toBe(false); // 2 chars
  });
  it('`?` NÃO casa `/`', () => {
    expect(m('a?b', 'a/b')).toBe(false);
  });
});

describe('compileGlob — classes `[...]`', () => {
  it('`[abc]` casa um dos chars', () => {
    expect(m('file[123].ts', 'file1.ts')).toBe(true);
    expect(m('file[123].ts', 'file2.ts')).toBe(true);
    expect(m('file[123].ts', 'file4.ts')).toBe(false);
  });
  it('range `[a-z]`', () => {
    expect(m('[a-z].md', 'q.md')).toBe(true);
    expect(m('[a-z].md', 'Q.md')).toBe(false);
  });
  it('negação `[!...]` (e `[^...]`) — e NUNCA casa `/`', () => {
    expect(m('x[!0-9].ts', 'xa.ts')).toBe(true);
    expect(m('x[!0-9].ts', 'x5.ts')).toBe(false);
    // negação não cruza `/` (uma classe é dentro de um segmento).
    expect(m('a[!z]b', 'a/b')).toBe(false);
  });
});

describe('compileGlob — `{a,b}` alternância', () => {
  it('casa qualquer das opções', () => {
    expect(m('*.{ts,tsx}', 'a.ts')).toBe(true);
    expect(m('*.{ts,tsx}', 'a.tsx')).toBe(true);
    expect(m('*.{ts,tsx}', 'a.js')).toBe(false);
  });
  it('combina com `**`', () => {
    expect(m('src/**/*.{test,spec}.ts', 'src/a.test.ts')).toBe(true);
    expect(m('src/**/*.{test,spec}.ts', 'src/deep/a.spec.ts')).toBe(true);
    expect(m('src/**/*.{test,spec}.ts', 'src/a.unit.ts')).toBe(false);
  });
  it('expandBraces faz o produto cartesiano de 2 grupos', () => {
    const out = expandBraces('{a,b}/{c,d}');
    expect(out.sort()).toEqual(['a/c', 'a/d', 'b/c', 'b/d']);
  });
  it('grupo único = todas as opções', () => {
    expect(expandBraces('x.{js,ts,py}').sort()).toEqual(['x.js', 'x.py', 'x.ts']);
  });
  it('sem chaves ⇒ a própria string', () => {
    expect(expandBraces('a/b.ts')).toEqual(['a/b.ts']);
  });
});

describe('compileGlob — literais e escapes (anti-falso-metacaractere)', () => {
  it('`.` é LITERAL (mutação: se virasse regex `.` casaria qualquer char)', () => {
    expect(m('a.ts', 'a.ts')).toBe(true);
    expect(m('a.ts', 'axts')).toBe(false); // o `.` não casa `x`
  });
  it('chars de regex no nome são literais (`+`, `(`, `$`)', () => {
    expect(m('a+b.ts', 'a+b.ts')).toBe(true);
    expect(m('a+b.ts', 'aaab.ts')).toBe(false); // `+` não é quantificador
    expect(m('f(1).js', 'f(1).js')).toBe(true);
  });
  it('escape `\\*` casa um `*` literal', () => {
    expect(m('a\\*b', 'a*b')).toBe(true);
    expect(m('a\\*b', 'axb')).toBe(false);
  });
});

describe('compileGlob — padrões INVÁLIDOS ⇒ GlobSyntaxError (erro VISÍVEL)', () => {
  it('padrão vazio', () => {
    expect(() => compileGlob('')).toThrow(GlobSyntaxError);
  });
  it('classe `[` não fechada', () => {
    expect(() => compileGlob('a[bc.ts')).toThrow(GlobSyntaxError);
  });
  it('`{` sem `}`', () => {
    expect(() => compileGlob('*.{ts,tsx')).toThrow(GlobSyntaxError);
  });
  it('escape `\\` pendente no fim', () => {
    expect(() => compileGlob('abc\\')).toThrow(GlobSyntaxError);
  });
  it('padrão longo demais (anti-abuso)', () => {
    const huge = 'a'.repeat(MAX_GLOB_PATTERN_CHARS + 1);
    expect(() => compileGlob(huge)).toThrow(GlobSyntaxError);
  });
  it('aninhamento de `{}` além do teto', () => {
    // 6 níveis aninhados > MAX_BRACE_DEPTH (5).
    expect(() => compileGlob('{a,{b,{c,{d,{e,{f,g}}}}}}')).toThrow(GlobSyntaxError);
  });
  it('explosão combinatória de grupos SEQUENCIAIS ⇒ throw RÁPIDO (não pendura)', () => {
    // BUG-HUNT: `MAX_BRACE_DEPTH` só freia o ANINHAMENTO. Grupos sequenciais
    // `{k}{k}{k}{k}{k}` (sob MAX_GLOB_PATTERN_CHARS e MAX_BRACE_DEPTH) multiplicam o
    // produto cartesiano. Em produção, 5 grupos de 40 opções = 40^5 = 102M strings
    // (~31s + OOM, travando o event-loop). O teto MAX_GLOB_ALTERNATIVES corta ANTES
    // de materializar. Aqui usamos 5×8 = 32768 (>1024, throw imediato COM o fix; sem
    // o fix expande o array todo, falhando o orçamento de tempo) — blast radius
    // contido p/ o revert FALHAR rápido em vez de pendurar o runner.
    const grp = (k: number): string => `{${Array.from({ length: k }, () => 'a').join(',')}}`;
    const pattern = grp(8).repeat(5); // 8^5 = 32768 > MAX_GLOB_ALTERNATIVES (1024)
    expect(pattern.length).toBeLessThanOrEqual(MAX_GLOB_PATTERN_CHARS); // forma é "legítima"
    const start = Date.now();
    expect(() => compileGlob(pattern)).toThrow(GlobSyntaxError);
    // COM o teto: throw após ~1024 expansões (instantâneo). SEM o teto: expande as
    // 32768 (e em produção 102M) ⇒ estoura este orçamento.
    expect(Date.now() - start).toBeLessThan(500);
  });
  it('expandBraces respeita MAX_GLOB_ALTERNATIVES (anti-OOM)', () => {
    // Um único grupo com mais opções que o teto também é cortado.
    const huge = `{${Array.from({ length: MAX_GLOB_ALTERNATIVES + 5 }, () => 'a').join(',')}}`;
    expect(() => expandBraces(huge)).toThrow(GlobSyntaxError);
    // E um padrão dentro do teto NÃO é afetado.
    expect(expandBraces('x.{js,ts,py}').sort()).toEqual(['x.js', 'x.py', 'x.ts']);
  });
});

describe('compileGlob — ANTI-ReDoS (padrão adversarial não trava)', () => {
  it('padrão com muitos `*` casa em tempo linear (não backtrack catastrófico)', () => {
    // Clássico gatilho de ReDoS num motor ingênuo: muitos coringas + entrada longa
    // que NÃO casa. Aqui é linear (classes simples) — termina instantâneo.
    const pattern = '*'.repeat(50) + 'X';
    const input = 'a'.repeat(5000); // não contém 'X' ⇒ não casa
    const start = Date.now();
    expect(m(pattern, input)).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  });
  it('`**` repetido + entrada profunda não trava', () => {
    const pattern = '**/'.repeat(20) + '*.zzz';
    const input = 'a/'.repeat(100) + 'b.ts'; // não termina em .zzz
    const start = Date.now();
    expect(m(pattern, input)).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('compileGlob — normalização de separador', () => {
  it('caminho com `\\` (Windows) é normalizado p/ `/` antes de testar', () => {
    expect(m('src/*.ts', 'src\\a.ts')).toBe(true);
  });
});
