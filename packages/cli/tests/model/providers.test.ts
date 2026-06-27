// EST-0962 · ADR-0076 — buildProviderEntries (PURA): funde a lista VIVA de providers do
// broker (`GET /v1/providers`, só name+adapter) com os metadados de display do seed, com
// fallback honesto e o guard HG-2 (só name/label/summary atravessam — nunca credencial).

import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  buildProviderEntries,
  resolveProviderName,
  type BrokerProvider,
} from '../../src/model/providers.js';

describe('buildProviderEntries — lista viva do broker + fallback', () => {
  it('lista VAZIA do broker ⇒ FALLBACK estático (PROVIDERS) — nunca vazia', () => {
    expect(buildProviderEntries([])).toBe(PROVIDERS);
  });

  it('usa o display do SEED p/ providers conhecidos (label/summary/isDefault)', () => {
    const live: BrokerProvider[] = [
      { name: 'openrouter', adapter: 'openrouter' },
      { name: 'deepseek', adapter: 'deepseek' },
    ];
    const entries = buildProviderEntries(live);
    const or = entries.find((e) => e.name === 'openrouter')!;
    expect(or.label).toBe('OpenRouter');
    expect(or.isDefault).toBe(true);
    const ds = entries.find((e) => e.name === 'deepseek')!;
    expect(ds.label).toBe('DeepSeek');
  });

  it('provider FORA do seed (tokenrouter) ⇒ display humanizado, sem inventar metadado', () => {
    const entries = buildProviderEntries([{ name: 'tokenrouter', adapter: 'tokenrouter' }]);
    const tr = entries.find((e) => e.name === 'tokenrouter')!;
    expect(tr.label).toBe('Tokenrouter');
    expect(tr.isDefault).toBeUndefined();
  });

  it('DEDUP por nome (case-insensitive) e o default do seed sobe ao TOPO', () => {
    const entries = buildProviderEntries([
      { name: 'tokenrouter', adapter: 'tokenrouter' },
      { name: 'deepseek', adapter: 'deepseek' },
      { name: 'OpenRouter', adapter: 'openrouter' }, // case diferente do seed
      { name: 'openrouter', adapter: 'openrouter' }, // dup ⇒ removido
    ]);
    expect(entries.filter((e) => e.name.toLowerCase() === 'openrouter')).toHaveLength(1);
    // o default (openrouter) é o 1º; o resto ordenado por nome.
    expect(entries[0]!.name.toLowerCase()).toBe('openrouter');
    expect(entries.slice(1).map((e) => e.name)).toEqual(['deepseek', 'tokenrouter']);
  });

  it('HG-2/CLI-SEC-7 — só name/label/summary/isDefault atravessam (nada de credencial)', () => {
    // O tipo BrokerProvider nem tem api_key_ref; provamos que a ENTRADA produzida só
    // carrega os campos de display públicos (o serializado não cita credencial).
    const entries = buildProviderEntries([{ name: 'deepseek', adapter: 'deepseek' }]);
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(['label', 'name', 'summary']));
      expect(Object.keys(e)).not.toContain('adapter'); // o adapter NÃO vira campo de entrada
    }
    const raw = JSON.stringify(entries);
    for (const forbidden of ['api_key_ref', 'base_url', 'markup', 'platform-deepseek']) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

describe('resolveProviderName — resolve contra a lista dada', () => {
  it('default usa o seed estático (openrouter/deepseek)', () => {
    expect(resolveProviderName('deepseek')!.name).toBe('deepseek');
    expect(resolveProviderName('TOKENROUTER')).toBeUndefined(); // fora do seed
  });

  it('com a lista VIVA, resolve providers além do seed (tokenrouter)', () => {
    const list = buildProviderEntries([{ name: 'tokenrouter', adapter: 'tokenrouter' }]);
    expect(resolveProviderName('tokenrouter', list)!.name).toBe('tokenrouter');
    expect(resolveProviderName(' TokenRouter ', list)!.name).toBe('tokenrouter'); // trim+ci
  });
});
