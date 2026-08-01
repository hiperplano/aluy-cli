import { describe, it, expect } from 'vitest';
import { parseServiceBudget } from '@hiperplano/aluy-cli-core';

describe('parseServiceBudget', () => {
  it('undefined ⇒ undefined (sem budget declarado)', () => {
    expect(parseServiceBudget(undefined)).toBeUndefined();
  });

  it('"200k/turno" ⇒ 200000', () => {
    expect(parseServiceBudget('200k/turno')).toBe(200_000);
  });

  it('"1.5m" ⇒ 1500000', () => {
    expect(parseServiceBudget('1.5m')).toBe(1_500_000);
  });

  it('inteiro cru sem sufixo', () => {
    expect(parseServiceBudget('50000')).toBe(50_000);
  });

  it('sufixo maiúsculo', () => {
    expect(parseServiceBudget('10K')).toBe(10_000);
  });

  it('lixo sem cara de número ⇒ undefined', () => {
    expect(parseServiceBudget('muito')).toBeUndefined();
  });

  it('zero/negativo ⇒ undefined', () => {
    expect(parseServiceBudget('0')).toBeUndefined();
    expect(parseServiceBudget('-5k')).toBeUndefined();
  });
});
