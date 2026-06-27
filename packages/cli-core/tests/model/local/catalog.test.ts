// ADR-0118 / EST-1118 — testes do CATÁLOGO de providers LOCAIS (DADO PURO).
//
// Cobre: o default embutido (lista pré-carregada + forma), o merge do override do usuário
// (sobrepõe por id / estende com novos id), o sanitize fail-soft (entrada inválida some,
// JSON estranho ⇒ vazio), e a resolução provider→entry→wireFormat. Tudo PURO (sem I/O).

import { describe, expect, it } from 'vitest';
import {
  defaultLocalCatalog,
  sanitizeEntry,
  sanitizeUserEntries,
  mergeLocalCatalog,
  buildLocalCatalog,
  findProvider,
  type LocalProviderEntry,
} from '../../../src/model/local/catalog.js';

describe('catálogo default EMBUTIDO (lista pré-carregada — ADR-0118 §4)', () => {
  const cat = defaultLocalCatalog();
  const byId = (id: string) => cat.entries.find((e) => e.id === id);

  it('traz os providers onda-1/2/3 esperados', () => {
    const ids = cat.entries.map((e) => e.id);
    for (const id of [
      'anthropic',
      'openai',
      'openrouter',
      'google',
      'deepseek',
      'groq',
      'mistral',
      'xai',
      'ollama',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('preserva os DEFAULTS de hoje (não-regressão) — anthropic/openai/openrouter', () => {
    expect(byId('anthropic')).toMatchObject({
      wireFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-opus-4-8',
      auth: ['apikey', 'oauth'],
    });
    expect(byId('openai')).toMatchObject({
      wireFormat: 'openai-compat',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
    });
    expect(byId('openrouter')).toMatchObject({
      wireFormat: 'openai-compat',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'anthropic/claude-3.5-sonnet',
    });
    // o catalogHint do OpenRouter (pista de centenas) sobrevive
    expect(byId('openrouter')?.catalogHint).toMatch(/centenas/i);
  });

  it('deepseek aponta para o base_url correto e wireFormat openai-compat', () => {
    expect(byId('deepseek')).toMatchObject({
      wireFormat: 'openai-compat',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-chat',
    });
  });

  it('ollama é local (auth none, 127.0.0.1)', () => {
    expect(byId('ollama')?.auth).toEqual(['none']);
    expect(byId('ollama')?.baseUrl).toContain('127.0.0.1');
  });

  it('está ordenado por wave asc depois id asc (determinístico)', () => {
    const order = cat.entries.map((e) => `${e.wave ?? 99}:${e.id}`);
    const sorted = [...order].sort();
    // wave é 1 dígito ⇒ ordenação lexicográfica coincide com a numérica esperada
    expect(order).toEqual(sorted);
    // wave 1 vem antes de wave 2
    const i = cat.entries.findIndex((e) => e.id === 'anthropic');
    const j = cat.entries.findIndex((e) => e.id === 'deepseek');
    expect(i).toBeLessThan(j);
  });

  it('NUNCA carrega segredo (CLI-SEC-7) — só campos públicos', () => {
    const blob = JSON.stringify(cat).toLowerCase();
    for (const bad of ['api_key', 'apikey:', 'secret', 'bearer', 'sk-', 'token']) {
      expect(blob.includes(bad)).toBe(false);
    }
  });
});

describe('sanitizeEntry — DADO NÃO-confiável vira entry válida ou undefined (fail-soft)', () => {
  const valid: LocalProviderEntry = {
    id: 'custom-x',
    label: 'Custom X',
    wireFormat: 'openai-compat',
    baseUrl: 'https://api.example.com/v1',
    auth: ['apikey'],
    defaultModel: 'x-large',
    models: ['x-large', 'x-small'],
  };

  it('aceita uma entrada completa válida', () => {
    expect(sanitizeEntry(valid)).toMatchObject({ id: 'custom-x', wireFormat: 'openai-compat' });
  });

  it('label ausente ⇒ usa o id', () => {
    const noLabel: Record<string, unknown> = { ...valid };
    delete noLabel.label;
    expect(sanitizeEntry(noLabel)?.label).toBe('custom-x');
  });

  it('aceita `auth` como string única (normaliza p/ array)', () => {
    expect(sanitizeEntry({ ...valid, auth: 'apikey' })?.auth).toEqual(['apikey']);
  });

  it('descarta wireFormat desconhecido', () => {
    expect(sanitizeEntry({ ...valid, wireFormat: 'soap-1.1' })).toBeUndefined();
  });

  it('descarta entrada sem id / sem baseUrl / sem defaultModel / sem auth', () => {
    expect(sanitizeEntry({ ...valid, id: '' })).toBeUndefined();
    expect(sanitizeEntry({ ...valid, baseUrl: 123 })).toBeUndefined();
    expect(sanitizeEntry({ ...valid, defaultModel: undefined })).toBeUndefined();
    expect(sanitizeEntry({ ...valid, auth: ['bogus'] })).toBeUndefined();
  });

  it('descarta valores não-objeto', () => {
    expect(sanitizeEntry(null)).toBeUndefined();
    expect(sanitizeEntry('x')).toBeUndefined();
    expect(sanitizeEntry(42)).toBeUndefined();
  });

  it('NUNCA lança em lixo arbitrário', () => {
    expect(() =>
      sanitizeEntry({ id: { nested: true }, auth: [{}], models: [42, null] }),
    ).not.toThrow();
  });
});

describe('sanitizeUserEntries — lista do providers.json', () => {
  it('aceita um array cru de entradas', () => {
    const raw = [
      {
        id: 'a',
        wireFormat: 'openai-compat',
        baseUrl: 'https://a.com',
        auth: 'apikey',
        defaultModel: 'm',
      },
      { id: 'bad' }, // inválida ⇒ descartada
    ];
    const out = sanitizeUserEntries(raw);
    expect(out.map((e) => e.id)).toEqual(['a']);
  });

  it('aceita o formato { providers: [...] } (amigável p/ editar à mão)', () => {
    const raw = {
      providers: [
        {
          id: 'a',
          wireFormat: 'anthropic',
          baseUrl: 'https://a.com',
          auth: ['apikey'],
          defaultModel: 'm',
        },
      ],
    };
    expect(sanitizeUserEntries(raw).map((e) => e.id)).toEqual(['a']);
  });

  it('última por id vence em duplicata', () => {
    const raw = [
      {
        id: 'a',
        wireFormat: 'openai-compat',
        baseUrl: 'https://1.com',
        auth: 'apikey',
        defaultModel: 'm1',
      },
      {
        id: 'a',
        wireFormat: 'openai-compat',
        baseUrl: 'https://2.com',
        auth: 'apikey',
        defaultModel: 'm2',
      },
    ];
    const out = sanitizeUserEntries(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.baseUrl).toBe('https://2.com');
  });

  it('raw não-array/não-{providers} ⇒ vazio (fail-soft)', () => {
    expect(sanitizeUserEntries(null)).toEqual([]);
    expect(sanitizeUserEntries('garbage')).toEqual([]);
    expect(sanitizeUserEntries({ foo: 'bar' })).toEqual([]);
  });
});

describe('mergeLocalCatalog / buildLocalCatalog — override do usuário sobre o default', () => {
  it('ESTENDE com um provider novo do usuário', () => {
    const cat = buildLocalCatalog([
      {
        id: 'myvendor',
        wireFormat: 'openai-compat',
        baseUrl: 'https://my.vendor/v1',
        auth: 'apikey',
        defaultModel: 'my-model',
      },
    ]);
    expect(findProvider(cat, 'myvendor')?.baseUrl).toBe('https://my.vendor/v1');
    // os defaults embutidos seguem presentes
    expect(findProvider(cat, 'anthropic')).toBeDefined();
  });

  it('SOBREPÕE (por id) uma entrada do default — o usuário troca o base_url/modelo', () => {
    const cat = buildLocalCatalog([
      {
        id: 'deepseek',
        wireFormat: 'openai-compat',
        baseUrl: 'https://my-proxy.internal-gw/v1',
        auth: 'apikey',
        defaultModel: 'deepseek-v9',
      },
    ]);
    expect(findProvider(cat, 'deepseek')?.defaultModel).toBe('deepseek-v9');
    expect(findProvider(cat, 'deepseek')?.baseUrl).toBe('https://my-proxy.internal-gw/v1');
  });

  it('userRaw ausente/null ⇒ só o default embutido', () => {
    expect(buildLocalCatalog(undefined).entries).toEqual(defaultLocalCatalog().entries);
    expect(buildLocalCatalog(null).entries).toEqual(defaultLocalCatalog().entries);
  });

  it('JSON do usuário lixo ⇒ default embutido (fail-soft, não derruba)', () => {
    expect(buildLocalCatalog('garbage').entries).toEqual(defaultLocalCatalog().entries);
    expect(buildLocalCatalog(42).entries).toEqual(defaultLocalCatalog().entries);
  });

  it('mergeLocalCatalog é determinístico (ordenado)', () => {
    const base = defaultLocalCatalog();
    const merged = mergeLocalCatalog(base, [
      {
        id: 'aaa',
        label: 'AAA',
        wireFormat: 'openai-compat',
        baseUrl: 'https://aaa',
        auth: ['apikey'],
        defaultModel: 'm',
      },
    ]);
    const ids = merged.entries.map((e) => e.id);
    // 'aaa' sem wave ⇒ cauda (wave 99), depois id asc
    expect(ids[ids.length - 1]).toBe('aaa');
  });
});

describe('findProvider — resolução provider→entry→wireFormat', () => {
  const cat = defaultLocalCatalog();
  it('resolve por id (case-insensitive)', () => {
    expect(findProvider(cat, 'Anthropic')?.wireFormat).toBe('anthropic');
    expect(findProvider(cat, 'OPENROUTER')?.wireFormat).toBe('openai-compat');
    expect(findProvider(cat, 'gemini')).toBeUndefined(); // o id é 'google'
    expect(findProvider(cat, 'google')?.wireFormat).toBe('gemini');
  });
  it('provider desconhecido ⇒ undefined', () => {
    expect(findProvider(cat, 'nope')).toBeUndefined();
  });
});
