import { describe, expect, it } from 'vitest';
import { isPat, parsePat } from '../../src/auth/pat.js';

const HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';

describe('parsePat', () => {
  it('aceita o formato canônico pat_<hex32>_<secret>', () => {
    const parsed = parsePat(`pat_${HEX}_segredoaqui`);
    expect(parsed).not.toBeNull();
    expect(parsed?.lookupId).toBe('deadbeef-dead-beef-dead-beefdeadbeef');
    expect(parsed?.secretLength).toBe('segredoaqui'.length);
  });

  it('rejeita prefixo errado (svc_/alk_)', () => {
    expect(parsePat(`svc_${HEX}_x`)).toBeNull();
    expect(parsePat(`alk_${HEX}_x`)).toBeNull();
  });

  it('rejeita id não-hex32', () => {
    expect(parsePat('pat_xyz_secret')).toBeNull();
    expect(parsePat(`pat_${HEX.slice(0, 30)}_secret`)).toBeNull();
  });

  it('rejeita segredo vazio e string vazia', () => {
    expect(parsePat(`pat_${HEX}_`)).toBeNull();
    expect(parsePat('')).toBeNull();
    expect(parsePat('pat_')).toBeNull();
  });

  it('isPat é o predicado de parsePat', () => {
    expect(isPat(`pat_${HEX}_s`)).toBe(true);
    expect(isPat('nope')).toBe(false);
  });

  it('parsePat NÃO devolve o segredo (só o comprimento)', () => {
    const parsed = parsePat(`pat_${HEX}_topsecret`);
    // A interface não tem campo de segredo — garantia de tipo + runtime.
    expect(Object.keys(parsed ?? {})).toEqual(['lookupId', 'secretLength']);
  });
});
