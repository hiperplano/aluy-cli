import { describe, it, expect } from 'vitest';
import { parseHHMM, todayAt, msUntilDeadline } from '@hiperplano/aluy-cli-core';

describe('parseHHMM', () => {
  it('parseia HH:MM válido', () => {
    expect(parseHHMM('17:30')).toEqual({ hour: 17, minute: 30 });
  });
  it('rejeita forma errada', () => {
    expect(parseHHMM('17h30')).toBeUndefined();
    expect(parseHHMM('25:00')).toBeUndefined();
    expect(parseHHMM('10:70')).toBeUndefined();
  });
});

describe('todayAt', () => {
  it('monta a data-hora de hoje no HH:MM', () => {
    const now = new Date('2026-08-01T09:00:00');
    expect(todayAt(now, '17:30')).toEqual(new Date('2026-08-01T17:30:00'));
  });
  it('malformado ⇒ undefined', () => {
    expect(todayAt(new Date(), 'xx:yy')).toBeUndefined();
  });
});

describe('msUntilDeadline', () => {
  it('sem until ⇒ undefined (sem teto de expediente)', () => {
    expect(msUntilDeadline(new Date(), undefined)).toBeUndefined();
  });
  it('positivo quando o until ainda não chegou', () => {
    const now = new Date('2026-08-01T09:00:00');
    expect(msUntilDeadline(now, '17:30')).toBe(8.5 * 60 * 60 * 1000);
  });
  it('negativo quando o until já passou (expediente encerrado)', () => {
    const now = new Date('2026-08-01T18:00:00');
    expect(msUntilDeadline(now, '17:30')).toBeLessThan(0);
  });
});
