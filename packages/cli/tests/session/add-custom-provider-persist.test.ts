// F-PROV (gap 3 do dogfooding: "não tenho a opção de adicionar um provedor custom") —
// prova a INTEGRAÇÃO ponta a ponta entre as duas peças que o `/provider` → "+ adicionar
// provider custom" liga em `run.tsx` (`onAddCustomProvider`):
//
//   1. `useProviderPicker` (ui/hooks) produz o `AddCustomProviderInput` (id/baseUrl/
//      defaultModel) ao final do formulário de 3 passos — já coberto isoladamente em
//      `tests/ui/use-provider-picker-local.test.tsx`.
//   2. `addLocalProviderOverride` (io/providers-config, a MESMA escrita que `aluy
//      onboard`/`aluy provider add` usam — run.tsx NÃO inventa um 2º caminho de
//      persistência) grava esse INPUT em `config.json`.
//
// Aqui: pega EXATAMENTE o shape que o passo 1 devolve, persiste com o passo 2 num
// tmpdir (nunca o `~/.aluy/` real) e confirma que `loadLocalProviderCatalog` +
// `buildLocalProviderEntries` (a MESMA função que alimenta a lista do picker) o
// re-listam — fechando o ciclo "adicionei → aparece no /provider".

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addLocalProviderOverride, loadLocalProviderCatalog } from '../../src/io/providers-config.js';
import { findProvider } from '@hiperplano/aluy-cli-core';
import { buildLocalProviderEntries } from '../../src/model/providers.js';

let base: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe('F-PROV — "+ adicionar provider custom" persiste via addLocalProviderOverride', () => {
  it('o input do formulário (id/baseUrl/defaultModel) persiste e reaparece no catálogo', () => {
    base = mkdtempSync(join(tmpdir(), 'aluy-add-provider-'));
    // EXATAMENTE o shape que `useProviderPicker().confirmAddCustom()` devolve.
    const input = {
      id: 'meuprovider',
      baseUrl: 'https://api.meuprovider.com/v1',
      defaultModel: 'meuprovider',
    };

    addLocalProviderOverride(
      { id: input.id, wireFormat: 'openai-compat', baseUrl: input.baseUrl, defaultModel: input.defaultModel },
      base,
    );

    const catalog = loadLocalProviderCatalog({ baseDir: base });
    const entry = findProvider(catalog, 'meuprovider');
    expect(entry).toBeDefined();
    expect(entry?.baseUrl).toBe('https://api.meuprovider.com/v1');
    expect(entry?.wireFormat).toBe('openai-compat');
    expect(entry?.defaultModel).toBe('meuprovider');
    // CLI-SEC-7 — o catálogo NUNCA carrega credencial (só o que `sanitizeEntry` aceita).
    expect(entry).not.toHaveProperty('apiKey');

    // A MESMA função que alimenta o picker lista a entrada persistida.
    const pickerEntries = buildLocalProviderEntries(catalog.entries);
    expect(pickerEntries.map((e) => e.name)).toContain('meuprovider');
  });

  it('modelo default explícito (diferente do id) também persiste', () => {
    base = mkdtempSync(join(tmpdir(), 'aluy-add-provider-'));
    addLocalProviderOverride(
      {
        id: 'outroprovider',
        wireFormat: 'openai-compat',
        baseUrl: 'https://x.example/v1',
        defaultModel: 'meu-modelo-especifico',
      },
      base,
    );
    const entry = findProvider(loadLocalProviderCatalog({ baseDir: base }), 'outroprovider');
    expect(entry?.defaultModel).toBe('meu-modelo-especifico');
  });

  it('built-ins seguem presentes junto do custom (merge, não substituição)', () => {
    base = mkdtempSync(join(tmpdir(), 'aluy-add-provider-'));
    addLocalProviderOverride(
      { id: 'meuprovider', wireFormat: 'openai-compat', baseUrl: 'https://x.example/v1', defaultModel: 'x' },
      base,
    );
    const catalog = loadLocalProviderCatalog({ baseDir: base });
    expect(findProvider(catalog, 'anthropic')).toBeDefined(); // built-in, intocado
    expect(findProvider(catalog, 'meuprovider')).toBeDefined(); // custom, ADICIONADO
  });
});
