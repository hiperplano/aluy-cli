// F-UP — a PONTA DE LEITURA do roteamento de upstream: do `~/.aluy/config.json` até o
// mapa que o boot entrega ao `LocalModelClient`.
//
// Dois degraus, testados juntos de propósito (é entre eles que a feature estava cortada):
//   1. `sanitize` do config (round-trip REAL em disco) — o que sobrevive à leitura;
//   2. `upstreamFromConfig` — qual mapa o provider ATIVO recebe.
//
// O casamento do slug NÃO é aqui: quem escolhe o fragmento é o `toLocalRequest`, por
// request (ver `packages/cli-core/tests/model/local/upstream-by-model.test.ts`).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserConfigStore, CONFIG_FILENAME } from '../../src/io/user-config.js';
import { upstreamFromConfig } from '../../src/model/catalog.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aluy-upstream-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Escreve um config CRU e devolve o que o `load()` sanitizado entrega. */
function loadWith(providers: unknown): ReturnType<UserConfigStore['load']> {
  writeFileSync(join(base, CONFIG_FILENAME), JSON.stringify({ providers }), 'utf8');
  return new UserConfigStore({ baseDir: base }).load();
}

const GMI = { provider: { only: ['gmicloud'], allow_fallbacks: false } };

describe('config → upstreamByModel (sanitize)', () => {
  it('sobrevive ao round-trip em disco, com o valor OPACO intacto', () => {
    const cfg = loadWith([
      {
        id: 'openrouter',
        wireFormat: 'openai-compat',
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'qwen/qwen3-27b',
        upstreamByModel: { 'qwen/qwen3-27b': GMI },
      },
    ]);
    expect(cfg.providers?.[0].upstreamByModel).toEqual({ 'qwen/qwen3-27b': GMI });
  });

  it('descarta entrada malformada (valor não-objeto) sem derrubar o resto', () => {
    const cfg = loadWith([
      {
        id: 'openrouter',
        wireFormat: 'openai-compat',
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'qwen/qwen3-27b',
        upstreamByModel: { bom: GMI, ruim: 'texto', pior: ['a'], vazio: null },
      },
    ]);
    expect(cfg.providers?.[0].upstreamByModel).toEqual({ bom: GMI });
  });

  it('mapa inteiro inválido ⇒ campo AUSENTE (nunca um objeto vazio grudado)', () => {
    const cfg = loadWith([
      {
        id: 'openrouter',
        wireFormat: 'openai-compat',
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'qwen/qwen3-27b',
        upstreamByModel: ['não é mapa'],
      },
    ]);
    expect(cfg.providers?.[0].upstreamByModel).toBeUndefined();
  });
});

describe('upstreamFromConfig — qual mapa o provider ATIVO recebe', () => {
  const providers = [
    { id: 'openrouter', label: 'OpenRouter', upstreamByModel: { 'qwen/qwen3-27b': GMI } },
    { id: 'outro', upstreamByModel: { 'x/y': { routing: { upstream: 'z' } } } },
  ];

  it('casa por id', () => {
    expect(upstreamFromConfig(providers, 'openrouter')).toEqual({ 'qwen/qwen3-27b': GMI });
  });

  it('casa por label (o config do dono usa os dois na prática)', () => {
    expect(upstreamFromConfig(providers, 'OpenRouter')).toEqual({ 'qwen/qwen3-27b': GMI });
  });

  it('provider ATIVO diferente ⇒ o mapa DELE, nunca o do vizinho', () => {
    expect(upstreamFromConfig(providers, 'outro')).toEqual({
      'x/y': { routing: { upstream: 'z' } },
    });
  });

  it('provider sem mapa declarado ⇒ undefined (nada é mandado)', () => {
    expect(upstreamFromConfig([{ id: 'openrouter' }], 'openrouter')).toBeUndefined();
  });

  it('sem providers / lista vazia ⇒ undefined', () => {
    expect(upstreamFromConfig(undefined, 'openrouter')).toBeUndefined();
    expect(upstreamFromConfig([], 'openrouter')).toBeUndefined();
  });

  it('mapa declarado VAZIO ⇒ undefined (não vira `extraBody: {}`)', () => {
    expect(upstreamFromConfig([{ id: 'openrouter', upstreamByModel: {} }], 'openrouter')).toBe(
      undefined,
    );
  });
});
