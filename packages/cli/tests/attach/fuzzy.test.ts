// EST-0957 · CA-1 — fuzzy match/ordenação dos caminhos p/ o picker `@`.

import { describe, expect, it } from 'vitest';
import { fuzzyScore, filterFuzzy } from '../../src/attach/fuzzy.js';

const PATHS = [
  'packages/cli/src/auth/session.ts',
  'packages/cli/src/auth/config.ts',
  'packages/cli/src/session/controller.ts',
  'README.md',
  'packages/cli-core/src/agent/loop.ts',
];

describe('fuzzyScore — subsequência case-insensitive', () => {
  it('casa subsequência esparsa (auth/sess → .../auth/session.ts)', () => {
    const r = fuzzyScore('auth/sess', 'packages/cli/src/auth/session.ts');
    expect(r).not.toBeNull();
    expect(r!.matched.length).toBe('auth/sess'.length);
  });

  it('retorna os índices corretos dos caracteres casados (highlight)', () => {
    // packages/cli/src/auth/session.ts
    // 01234567890123456789012345678901
    //           1111111111222222222233
    const r = fuzzyScore('auth/sess', 'packages/cli/src/auth/session.ts');
    expect(r).not.toBeNull();
    // a=1 u=18 t=19 h=20 /=21 s=22 e=23 s=24 s=25
    expect(r!.matched).toEqual([1, 18, 19, 20, 21, 22, 23, 24, 25]);
  });

  it('NÃO casa quando falta um caractere', () => {
    expect(fuzzyScore('zzz', 'README.md')).toBeNull();
  });

  it('query vazia casa tudo com score neutro', () => {
    const r = fuzzyScore('', 'qualquer.ts');
    expect(r).toEqual({ score: 0, matched: [] });
  });

  it('é case-insensitive', () => {
    expect(fuzzyScore('SESSION', 'packages/cli/src/auth/session.ts')).not.toBeNull();
  });
});

describe('filterFuzzy — filtra e ORDENA (melhor primeiro)', () => {
  it('`session` rankeia o arquivo do basename no topo', () => {
    const hits = filterFuzzy('session', PATHS);
    expect(hits.length).toBeGreaterThan(0);
    // o item cujo basename é `session.ts` deve vir antes do diretório `session/`.
    expect(hits[0]!.path).toBe('packages/cli/src/auth/session.ts');
  });

  it('`auth/sess` filtra só os caminhos que casam a subsequência', () => {
    const hits = filterFuzzy('auth/sess', PATHS);
    expect(hits.map((h) => h.path)).toEqual(['packages/cli/src/auth/session.ts']);
  });

  it('query vazia devolve TODOS na ordem do índice (sem highlight)', () => {
    const hits = filterFuzzy('', PATHS);
    expect(hits.map((h) => h.path)).toEqual(PATHS);
    expect(hits.every((h) => h.matched.length === 0)).toBe(true);
  });

  it('navegação: a lista é estável (ordenação determinística)', () => {
    const a = filterFuzzy('cli', PATHS).map((h) => h.path);
    const b = filterFuzzy('cli', PATHS).map((h) => h.path);
    expect(a).toEqual(b);
  });
});
