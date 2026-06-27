// ADR-0120 / EST-1113 — seleção de backend (precedência flag>env>config>default).
import { describe, expect, it } from 'vitest';
import { parseBackend, resolveBackend, DEFAULT_BACKEND } from '../../../src/model/local/backend.js';

describe('parseBackend — normalização tolerante', () => {
  it('aceita local/broker (case-insensitive, trim)', () => {
    expect(parseBackend('local')).toBe('local');
    expect(parseBackend('  LOCAL ')).toBe('local');
    expect(parseBackend('Broker')).toBe('broker');
  });
  it('lixo/ausente ⇒ undefined (NÃO vira local por engano)', () => {
    expect(parseBackend('lokal')).toBeUndefined();
    expect(parseBackend('')).toBeUndefined();
    expect(parseBackend(undefined)).toBeUndefined();
    expect(parseBackend(null)).toBeUndefined();
  });
});

describe('resolveBackend — precedência flag>env>config>default', () => {
  it('default é local (BYO: sem nada ⇒ local)', () => {
    expect(resolveBackend({})).toBe('local');
    expect(DEFAULT_BACKEND).toBe('local');
  });
  it('flag vence env e config', () => {
    expect(resolveBackend({ flag: 'local', env: 'broker', config: 'broker' })).toBe('local');
  });
  it('env vence config quando não há flag', () => {
    expect(resolveBackend({ env: 'local', config: 'broker' })).toBe('local');
  });
  it('config vale quando não há flag nem env', () => {
    expect(resolveBackend({ config: 'local' })).toBe('local');
  });
  it('flag inválida ⇒ cai p/ env (não bloqueia)', () => {
    expect(resolveBackend({ flag: 'xxx', env: 'local' })).toBe('local');
  });
});
