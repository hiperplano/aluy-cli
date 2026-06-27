import { describe, it, expect } from 'vitest';
import {
  connectorKeychainAccount,
  isPlausibleTelegramToken,
  redactTelegramToken,
} from '../../src/connector/secret-store.js';

describe('connector secret-store — naming + validadores PUROS (TC-3 / CLI-SEC-2)', () => {
  it('connectorKeychainAccount: conta por id', () => {
    expect(connectorKeychainAccount('telegram')).toBe('connector-telegram-token');
    expect(connectorKeychainAccount('slack')).toBe('connector-slack-token');
  });

  it('isPlausibleTelegramToken: forma <bot_id>:<auth> aceita; lixo rejeitado', () => {
    expect(isPlausibleTelegramToken('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345')).toBe(true);
    expect(isPlausibleTelegramToken('  123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345  ')).toBe(true);
    expect(isPlausibleTelegramToken('not-a-token')).toBe(false);
    expect(isPlausibleTelegramToken('123:short')).toBe(false); // auth curto
    expect(isPlausibleTelegramToken('abc:AAHkabcdefghijklmnopqrstuvwxyz012345')).toBe(false); // id não-numérico
    expect(isPlausibleTelegramToken('')).toBe(false);
  });

  it('redactTelegramToken: mostra bot_id, esconde o auth (CLI-SEC-6)', () => {
    const r = redactTelegramToken('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345');
    expect(r).toContain('123456789:');
    expect(r).not.toContain('AAHk');
    expect(r).toMatch(/chars/);
  });

  it('redactTelegramToken: sem `:` ⇒ só comprimento (nunca o conteúdo)', () => {
    const r = redactTelegramToken('SECRETVALUE');
    expect(r).not.toContain('SECRETVALUE');
    expect(r).toMatch(/chars/);
  });
});
