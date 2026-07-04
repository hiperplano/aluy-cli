// ADR-0118 / EST-1118 — LOAD do catálogo de providers do usuário (`~/.aluy/providers.json`)
// + merge com o default embutido. Bateria do DoD:
//   - arquivo AUSENTE ⇒ só o default embutido, SILENCIOSO (sem aviso);
//   - override ESTENDE (provider novo) e SOBREPÕE (por id) o default;
//   - JSON inválido ⇒ default + 1 AVISO (fail-soft, não derruba);
//   - entrada inválida no array ⇒ descartada, demais valem;
//   - NUNCA lança.
//
// Tudo sobre um tmpdir (baseDir injetado) — a suíte NUNCA toca o `~/.aluy/` real.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadLocalProviderCatalog,
  providersConfigPath,
  migrateLegacyProvidersJson,
  addLocalProviderOverride,
  removeLocalProviderOverride,
  PROVIDERS_FILENAME,
} from '../../src/io/providers-config.js';
import { UserConfigStore } from '../../src/io/user-config.js';
import { defaultLocalCatalog, findProvider } from '@hiperplano/aluy-cli-core';

describe('loadLocalProviderCatalog — default embutido + override do usuário (EST-1118)', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-providers-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function writeProviders(content: string): void {
    writeFileSync(join(base, PROVIDERS_FILENAME), content, 'utf8');
  }

  it('arquivo AUSENTE ⇒ só o default embutido, SEM aviso', () => {
    const warnings: string[] = [];
    const cat = loadLocalProviderCatalog({ baseDir: base, warn: (m) => warnings.push(m) });
    expect(cat.entries).toEqual(defaultLocalCatalog().entries);
    expect(warnings).toHaveLength(0);
  });

  it('override ESTENDE com um provider novo', () => {
    writeProviders(
      JSON.stringify([
        {
          id: 'myvendor',
          wireFormat: 'openai-compat',
          baseUrl: 'https://my.vendor/v1',
          auth: 'apikey',
          defaultModel: 'my-model',
        },
      ]),
    );
    const cat = loadLocalProviderCatalog({ baseDir: base });
    expect(findProvider(cat, 'myvendor')?.baseUrl).toBe('https://my.vendor/v1');
    expect(findProvider(cat, 'anthropic')).toBeDefined(); // default segue
  });

  it('override SOBREPÕE (por id) uma entrada do default', () => {
    writeProviders(
      JSON.stringify({
        providers: [
          {
            id: 'openrouter',
            wireFormat: 'openai-compat',
            baseUrl: 'https://my-or-proxy/v1',
            auth: 'apikey',
            defaultModel: 'x/y',
          },
        ],
      }),
    );
    const cat = loadLocalProviderCatalog({ baseDir: base });
    expect(findProvider(cat, 'openrouter')?.baseUrl).toBe('https://my-or-proxy/v1');
    expect(findProvider(cat, 'openrouter')?.defaultModel).toBe('x/y');
  });

  it('legado JSON inválido ⇒ default embutido, fail-soft (ADR-0150: sem warn-once)', () => {
    writeProviders('{ not valid json,,,');
    const cat = loadLocalProviderCatalog({ baseDir: base });
    expect(cat.entries).toEqual(defaultLocalCatalog().entries);
  });

  it('entrada inválida no array ⇒ descartada, demais valem', () => {
    writeProviders(
      JSON.stringify([
        { id: 'bad' }, // inválida (sem campos)
        {
          id: 'good',
          wireFormat: 'openai-compat',
          baseUrl: 'https://good/v1',
          auth: 'apikey',
          defaultModel: 'g',
        },
      ]),
    );
    const cat = loadLocalProviderCatalog({ baseDir: base });
    expect(findProvider(cat, 'good')).toBeDefined();
    expect(findProvider(cat, 'bad')).toBeUndefined();
  });

  it('NUNCA lança mesmo com conteúdo bizarro', () => {
    writeProviders(JSON.stringify({ providers: [42, null, 'x', { id: {} }] }));
    expect(() => loadLocalProviderCatalog({ baseDir: base })).not.toThrow();
    const cat = loadLocalProviderCatalog({ baseDir: base });
    // nenhuma entrada do usuário sobreviveu ⇒ só o default
    expect(cat.entries).toEqual(defaultLocalCatalog().entries);
  });

  it('providersConfigPath aponta para <baseDir>/providers.json', () => {
    expect(providersConfigPath(base)).toBe(join(base, PROVIDERS_FILENAME));
  });
});

describe('config único (ADR-0150) — migração providers.json → config.json', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-cfgmig-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const entry = (id: string) => ({
    id,
    wireFormat: 'openai-compat',
    baseUrl: `https://${id}/v1`,
    auth: ['apikey'],
    defaultModel: `${id}-m`,
  });

  it('migra providers.json → config.providers e RENOMEIA p/ .migrated', () => {
    writeFileSync(join(base, PROVIDERS_FILENAME), JSON.stringify([entry('myvendor')]), 'utf8');
    const out = migrateLegacyProvidersJson(base);
    expect(out.map((e) => e.id)).toContain('myvendor');
    // config.json passou a ser a fonte de verdade…
    expect(new UserConfigStore({ baseDir: base }).load().providers?.[0]?.id).toBe('myvendor');
    // …e o legado virou rastro .migrated (não some, não fica ativo).
    expect(existsSync(join(base, PROVIDERS_FILENAME))).toBe(false);
    expect(existsSync(join(base, PROVIDERS_FILENAME + '.migrated'))).toBe(true);
  });

  it('idempotente: 2ª chamada com config já preenchido é no-op', () => {
    writeFileSync(join(base, PROVIDERS_FILENAME), JSON.stringify([entry('a')]), 'utf8');
    migrateLegacyProvidersJson(base);
    const again = migrateLegacyProvidersJson(base);
    expect(again.map((e) => e.id)).toEqual(['a']);
  });

  it('add/remove escrevem na seção providers do config (não em providers.json)', () => {
    addLocalProviderOverride(
      {
        id: 'tokenrouter',
        wireFormat: 'openai-compat',
        baseUrl: 'https://tr/v1',
        defaultModel: 'x',
      },
      base,
    );
    const store = new UserConfigStore({ baseDir: base });
    expect(store.load().providers?.map((e) => e.id)).toContain('tokenrouter');
    expect(existsSync(join(base, PROVIDERS_FILENAME))).toBe(false); // nunca cria o legado
    // e o catálogo efetivo já enxerga via config
    expect(findProvider(loadLocalProviderCatalog({ baseDir: base }), 'tokenrouter')).toBeDefined();

    removeLocalProviderOverride('tokenrouter', base);
    expect(store.load().providers?.some((e) => e.id === 'tokenrouter') ?? false).toBe(false);
  });

  it('config.providers preserva as OUTRAS preferências (não clobbera o config)', () => {
    const store = new UserConfigStore({ baseDir: base });
    store.save({ theme: 'dark', tier: 'fast' });
    addLocalProviderOverride(
      { id: 'v', wireFormat: 'anthropic', baseUrl: 'https://v/x', defaultModel: 'm' },
      base,
    );
    const cfg = store.load();
    expect(cfg.tier).toBe('fast'); // a fatia de providers não apagou o resto
    expect(cfg.providers?.[0]?.id).toBe('v');
    // sanity: o config.json é um único arquivo JSON com ambas as seções
    const raw = JSON.parse(readFileSync(store.configPath, 'utf8'));
    expect(raw.tier).toBe('fast');
    expect(raw.providers[0].id).toBe('v');
  });
});
