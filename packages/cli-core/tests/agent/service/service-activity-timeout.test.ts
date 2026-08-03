import { describe, it, expect } from 'vitest';
import { parseServiceActivityTimeout } from '@hiperplano/aluy-cli-core';

describe('parseServiceActivityTimeout', () => {
  it('undefined ⇒ undefined (sem "activity-timeout:" declarado — caller cai no default)', () => {
    expect(parseServiceActivityTimeout(undefined)).toBeUndefined();
  });

  it('"sem-teto" ⇒ \'unlimited\' (literal, nunca um número gigante)', () => {
    expect(parseServiceActivityTimeout('sem-teto')).toBe('unlimited');
  });

  it('"sem-teto" tolera maiúsculas/espaços nas bordas', () => {
    expect(parseServiceActivityTimeout('SEM-TETO')).toBe('unlimited');
    expect(parseServiceActivityTimeout('  sem-teto  ')).toBe('unlimited');
  });

  it('"45m" ⇒ 2700000 (reusa a mesma gramática de duração do /cycle)', () => {
    expect(parseServiceActivityTimeout('45m')).toBe(45 * 60_000);
  });

  it('"2h" ⇒ 7200000', () => {
    expect(parseServiceActivityTimeout('2h')).toBe(2 * 3_600_000);
  });

  it('"90" (sem sufixo) ⇒ segundos, mesma convenção de parseDuration', () => {
    expect(parseServiceActivityTimeout('90')).toBe(90_000);
  });

  it('lixo sem cara de duração nem "sem-teto" ⇒ undefined (malformado, cai no default)', () => {
    expect(parseServiceActivityTimeout('muito')).toBeUndefined();
  });

  it('zero/negativo ⇒ undefined (mesma rejeição de parseDuration)', () => {
    expect(parseServiceActivityTimeout('0')).toBeUndefined();
    expect(parseServiceActivityTimeout('-5m')).toBeUndefined();
  });
});
