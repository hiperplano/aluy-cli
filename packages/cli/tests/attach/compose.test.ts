// EST-0957 — testes dedicados de `trailingMention` e `stripTrailingMention`.
//
// Funções puras de composição do `@` no input do composer. Cobrem edge cases
// de borda, whitespace e caracteres especiais que `mentions.test.ts` não cobre.

import { describe, expect, it } from 'vitest';
import { trailingMention, stripTrailingMention } from '../../src/attach/compose.js';

// ---------------------------------------------------------------------------
// trailingMention
// ---------------------------------------------------------------------------
describe('trailingMention', () => {
  it('input vazio → null', () => {
    expect(trailingMention('')).toBeNull();
  });

  it('arroba solta com query vazia → detecta', () => {
    expect(trailingMention('@')).toEqual({ at: 0, query: '' });
  });

  it('arroba no começo com query alfanumérica', () => {
    expect(trailingMention('@alice')).toEqual({ at: 0, query: 'alice' });
  });

  it('arroba após espaço', () => {
    expect(trailingMention('oi @bob')).toEqual({ at: 3, query: 'bob' });
  });

  it('arroba após tab', () => {
    expect(trailingMention('oi\t@bob')).toEqual({ at: 3, query: 'bob' });
  });

  it('arroba após newline', () => {
    expect(trailingMention('\n@alice')).toEqual({ at: 1, query: 'alice' });
  });

  it('query com / . - _ (caracteres de caminho)', () => {
    expect(trailingMention('@auth/session.config-file')).toEqual({
      at: 0,
      query: 'auth/session.config-file',
    });
  });

  it('NÃO dispara para e-mail (arroba colada a palavra)', () => {
    expect(trailingMention('user@host.com')).toBeNull();
  });

  it('NÃO dispara para e-mail com hífen antes (e-mail@host)', () => {
    expect(trailingMention('e-mail@host')).toBeNull();
  });

  it('NÃO dispara se há espaço na query (menção fechou)', () => {
    expect(trailingMention('oi @alice depois')).toBeNull();
  });

  it('último @ válido vence quando há vários', () => {
    // O primeiro @ está colado a "user" (inválido), o segundo é válido.
    expect(trailingMention('user@host @alice')).toEqual({ at: 10, query: 'alice' });
  });

  it('arrobas múltiplas @@alice — último @ não está em borda', () => {
    // lastIndexOf encontra o @ em idx 1; before = input[0] = '@' ≠ whitespace → null.
    expect(trailingMention('@@alice')).toBeNull();
  });

  it('query fechada por newline', () => {
    expect(trailingMention('oi @alice\n')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stripTrailingMention
// ---------------------------------------------------------------------------
describe('stripTrailingMention', () => {
  it('input vazio → inalterado', () => {
    expect(stripTrailingMention('')).toBe('');
  });

  it('sem menção → inalterado', () => {
    expect(stripTrailingMention('hello world')).toBe('hello world');
  });

  it('remove @query no fim e trima espaços trailing', () => {
    expect(stripTrailingMention('explique @auth/sess')).toBe('explique');
  });

  it('remove @query e espaços à direita do texto antes', () => {
    expect(stripTrailingMention('explique   @alice')).toBe('explique');
  });

  it('arroba no começo → string vazia', () => {
    expect(stripTrailingMention('@src')).toBe('');
  });

  it('preserva espaços leading do input', () => {
    expect(stripTrailingMention('  hello  @alice')).toBe('  hello');
  });

  it('input com apenas espaços e @query → string vazia', () => {
    expect(stripTrailingMention('   @alice')).toBe('');
  });

  it('não mexe quando menção está no meio (espaço depois)', () => {
    expect(stripTrailingMention('oi @alice depois')).toBe('oi @alice depois');
  });
});
