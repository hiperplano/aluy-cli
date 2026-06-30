// BUG-A (task #16) — testes do FILTRO de vazamento de sequência de escape (puro, sem TTY).
//
// O bug: shift+enter via CSI-u (`\x1b[13;2u`) / modifyOtherKeys (`\x1b[27;2;13~`) sem
// negociação ⇒ o Ink engole o `\x1b` mas deixa a CAUDA (`[13;2u`/`[27;2;13~`) virar texto no
// composer. `isUnrecognizedEscapeTail` reconhece o corpo de uma sequência CSI/SS3 (com o
// `\x1b` já tirado pelo Ink) e a suprime — SEM engolir um `[`/`O` digitado normalmente.

import { describe, expect, it } from 'vitest';
import { isUnrecognizedEscapeTail } from '../../src/session/escape-leak.js';

describe('isUnrecognizedEscapeTail — BUG-A (vazamento de escape)', () => {
  it('SUPRIME a cauda do CSI-u shift+enter (kitty: `\\x1b[13;2u` ⇒ `[13;2u`)', () => {
    expect(isUnrecognizedEscapeTail('[13;2u')).toBe(true);
  });

  it('SUPRIME a cauda do modifyOtherKeys (`\\x1b[27;2;13~` ⇒ `[27;2;13~`)', () => {
    expect(isUnrecognizedEscapeTail('[27;2;13~')).toBe(true);
  });

  it('SUPRIME outras caudas CSI-u (kitty functional keys, terminador `u`)', () => {
    expect(isUnrecognizedEscapeTail('[57414u')).toBe(true);
    expect(isUnrecognizedEscapeTail('[1;5u')).toBe(true);
  });

  it('SUPRIME uma cauda SS3 não-reconhecida (`O` + final)', () => {
    expect(isUnrecognizedEscapeTail('O5R')).toBe(true);
  });

  it('NÃO suprime um `[` DIGITADO sozinho (composer normal)', () => {
    expect(isUnrecognizedEscapeTail('[')).toBe(false);
  });

  it('NÃO suprime um `O` DIGITADO sozinho', () => {
    expect(isUnrecognizedEscapeTail('O')).toBe(false);
  });

  it('NÃO suprime texto comum que começa com `[` mas não é sequência', () => {
    // sem byte FINAL no formato de sequência (params seguidos de letra/~/^/$/@).
    expect(isUnrecognizedEscapeTail('[hello')).toBe(false);
    expect(isUnrecognizedEscapeTail('[1,2,3]')).toBe(false);
    expect(isUnrecognizedEscapeTail('[]')).toBe(false);
  });

  it('NÃO suprime char vazio nem texto comum sem introdutor', () => {
    expect(isUnrecognizedEscapeTail('')).toBe(false);
    expect(isUnrecognizedEscapeTail('a')).toBe(false);
    expect(isUnrecognizedEscapeTail('AAA')).toBe(false);
    expect(isUnrecognizedEscapeTail('13;2u')).toBe(false); // sem o `[` introdutor
  });
});
