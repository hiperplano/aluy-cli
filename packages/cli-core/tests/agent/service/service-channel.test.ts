import { describe, it, expect } from 'vitest';
import { parseServiceTelegramChatId } from '@hiperplano/aluy-cli-core';

describe('parseServiceTelegramChatId', () => {
  it('extrai o chat-id de "telegram:<id>"', () => {
    expect(parseServiceTelegramChatId('telegram:123456')).toBe(123456);
  });

  it('aceita chat-id negativo (grupo/canal — a forma é válida, mesmo que v1 só use DM)', () => {
    expect(parseServiceTelegramChatId('telegram:-100200300')).toBe(-100200300);
  });

  it('canal ausente ⇒ undefined', () => {
    expect(parseServiceTelegramChatId(undefined)).toBeUndefined();
  });

  it('conector diferente de telegram ⇒ undefined (v1 só suporta telegram)', () => {
    expect(parseServiceTelegramChatId('slack:C0123')).toBeUndefined();
    expect(parseServiceTelegramChatId('email:dono@example.com')).toBeUndefined();
  });

  it('alvo não-numérico ⇒ undefined', () => {
    expect(parseServiceTelegramChatId('telegram:abc')).toBeUndefined();
    expect(parseServiceTelegramChatId('telegram:123abc')).toBeUndefined();
  });

  it('tolera espaço nas bordas', () => {
    expect(parseServiceTelegramChatId('  telegram:42  ')).toBe(42);
  });
});
