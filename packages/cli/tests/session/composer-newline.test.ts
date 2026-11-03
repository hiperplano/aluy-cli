// F2/F5 — nova linha no composer e lote com várias linhas (funções puras).

import { describe, expect, it } from 'vitest';
import {
  backslashNewline,
  drainTypedChunk,
  isNewlineKey,
} from '../../src/session/composer-edit.js';

describe('F2 — isNewlineKey', () => {
  it('Alt+Enter (ESC CR) chega como char "\\r" sem key.return ⇒ nova linha', () => {
    expect(isNewlineKey('\r', { return: false })).toBe(true);
  });
  it('Ctrl+J (LF) ⇒ nova linha', () => {
    expect(isNewlineKey('\n', {})).toBe(true);
  });
  it('Shift+Enter / meta+return ⇒ nova linha', () => {
    expect(isNewlineKey('\r', { return: true, shift: true })).toBe(true);
    expect(isNewlineKey('\r', { return: true, meta: true })).toBe(true);
  });
  it('Enter puro NÃO é nova linha (envia)', () => {
    expect(isNewlineKey('\r', { return: true })).toBe(false);
  });
  it('Ctrl+Enter (CSI-u) segue sendo ENCAIXAR, não nova linha', () => {
    expect(isNewlineKey('\r', { return: true, ctrl: true })).toBe(false);
  });
  it('lote "abc\\r" NÃO é nova linha', () => {
    expect(isNewlineKey('abc\r', { return: false })).toBe(false);
  });
});

describe('F2 — backslashNewline', () => {
  it('barra antes do cursor vira \\n e o cursor fica depois', () => {
    expect(backslashNewline({ text: 'abc\\', cursor: 4 })).toEqual({ text: 'abc\n', cursor: 4 });
  });
  it('barra no meio (cursor logo após) também converte', () => {
    expect(backslashNewline({ text: 'ab\\cd', cursor: 3 })).toEqual({ text: 'ab\ncd', cursor: 3 });
  });
  it('sem barra antes do cursor ⇒ undefined (Enter envia)', () => {
    expect(backslashNewline({ text: 'abc', cursor: 3 })).toBeUndefined();
    expect(backslashNewline({ text: '\\', cursor: 0 })).toBeUndefined();
  });
});

describe('F5 — drainTypedChunk', () => {
  it('devolve TODAS as linhas e o resto', () => {
    const r = drainTypedChunk({ text: '', cursor: 0 }, 'um\rdois\rtres');
    expect(r.lines.map((l) => l.text)).toEqual(['um', 'dois']);
    expect(r.rest).toEqual({ text: 'tres', cursor: 4 });
  });
  it('junta o texto já no composer à 1ª linha', () => {
    const r = drainTypedChunk({ text: 'ab', cursor: 2 }, 'c\rd\r');
    expect(r.lines.map((l) => l.text)).toEqual(['abc', 'd']);
    expect(r.rest.text).toBe('');
  });
  it('distingue \\r e \\n e trata \\r\\n como uma quebra só', () => {
    const r = drainTypedChunk({ text: '', cursor: 0 }, 'a\r\nb\nc');
    expect(r.lines).toEqual([
      { text: 'a', term: '\r' },
      { text: 'b', term: '\n' },
    ]);
    expect(r.rest.text).toBe('c');
  });
  it('sem quebra ⇒ nenhuma linha, estado editado', () => {
    const r = drainTypedChunk({ text: '', cursor: 0 }, 'abc\x7f');
    expect(r.lines).toEqual([]);
    expect(r.rest.text).toBe('ab');
  });
});
