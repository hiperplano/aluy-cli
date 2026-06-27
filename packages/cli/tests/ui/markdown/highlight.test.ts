// EST · acabamento TUI — testes do SYNTAX HIGHLIGHT (puro). Prova-chave (DoD): o
// realce SÓ emite PAPÉIS do DS — nunca cor crua nem classe externa.

import { describe, expect, it } from 'vitest';
import {
  highlightToSegments,
  resolveLanguage,
  type HlSegment,
} from '../../../src/ui/markdown/highlight.js';

// Os 7 papéis válidos do tema (palette.ts). Nada fora disto pode escapar.
const DS_ROLES = new Set(['fg', 'fgDim', 'accent', 'accentDim', 'danger', 'success', 'depth']);

function rolesOf(segs: readonly HlSegment[]): string[] {
  return [...new Set(segs.map((s) => s.role))];
}

describe('resolveLanguage — aliases e desconhecidos', () => {
  it('resolve aliases comuns', () => {
    expect(resolveLanguage('ts')).toBe('typescript');
    expect(resolveLanguage('TS')).toBe('typescript');
    expect(resolveLanguage('sh')).toBe('bash');
    expect(resolveLanguage('py')).toBe('python');
    expect(resolveLanguage('yml')).toBe('yaml');
  });
  it('linguagem desconhecida ⇒ null', () => {
    expect(resolveLanguage('brainfuck')).toBeNull();
    expect(resolveLanguage('')).toBeNull();
    expect(resolveLanguage(undefined)).toBeNull();
  });
});

describe('highlightToSegments — só papéis do DS', () => {
  it('TS: keywords/strings/comments caem em papéis válidos', () => {
    const segs = highlightToSegments('const s = "hi"; // c', 'ts');
    for (const s of segs) expect(DS_ROLES.has(s.role)).toBe(true);
    // keyword `const` → accent ; string → success ; comment → fgDim
    expect(rolesOf(segs)).toEqual(expect.arrayContaining(['accent', 'success', 'fgDim']));
  });

  it('reconstrói o texto original byte-a-byte (sem perda)', () => {
    const code = 'export function f(x: number): string { return `v${x}`; }';
    const segs = highlightToSegments(code, 'ts');
    expect(segs.map((s) => s.text).join('')).toBe(code);
  });

  it('JAMAIS emite cor crua nem classe hljs — só TermRole', () => {
    const samples: Array<[string, string]> = [
      ['typescript', 'type T = { a: number }'],
      ['bash', 'echo "hi" | grep x # comentário'],
      ['json', '{"a": 1, "b": "x"}'],
      ['python', 'def f(x):\n    return x + 1  # c'],
      ['diff', '-removida\n+adicionada'],
    ];
    for (const [lang, code] of samples) {
      const segs = highlightToSegments(code, lang);
      for (const s of segs) {
        expect(DS_ROLES.has(s.role)).toBe(true);
        expect(s.role).not.toMatch(/^#|hljs|^\d/); // nem hex, nem classe, nem cor ANSI
      }
    }
  });

  it('linguagem desconhecida ⇒ um único segmento fg (texto cru, fallback)', () => {
    const segs = highlightToSegments('algo qualquer', 'naoexiste');
    expect(segs).toEqual([{ text: 'algo qualquer', role: 'fg' }]);
  });

  it('string vazia ⇒ nenhum segmento', () => {
    expect(highlightToSegments('', 'ts')).toEqual([]);
    expect(highlightToSegments('', 'naoexiste')).toEqual([]);
  });

  it('mapeamento: número→accentDim, string→success, comment→fgDim', () => {
    const segs = highlightToSegments('x = 42', 'python');
    const numSeg = segs.find((s) => s.text.includes('42'));
    expect(numSeg?.role).toBe('accentDim');
  });
});
