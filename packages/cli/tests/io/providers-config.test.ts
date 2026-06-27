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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadLocalProviderCatalog,
  providersConfigPath,
  PROVIDERS_FILENAME,
} from '../../src/io/providers-config.js';
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

  it('JSON inválido ⇒ default embutido + 1 AVISO (fail-soft)', () => {
    writeProviders('{ not valid json,,,');
    const warnings: string[] = [];
    const cat = loadLocalProviderCatalog({ baseDir: base, warn: (m) => warnings.push(m) });
    expect(cat.entries).toEqual(defaultLocalCatalog().entries);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/embutido/i);
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
