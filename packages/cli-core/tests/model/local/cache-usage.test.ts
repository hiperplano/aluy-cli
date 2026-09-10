// A leitura dos tokens reaproveitados do cache — três dialetos, um número.
//
// O dono perguntou em 10/09/2026 "a gente usa prompt caching?" e a resposta honesta era
// "não sei": líamos só `prompt_tokens`/`completion_tokens`. Nos providers de cache
// IMPLÍCITO o reaproveitamento quase certamente já acontecia e era cobrado mais barato,
// sem ninguém conseguir ver.
//
// Sem este número não dá para PROVAR que o `cache_control` que passamos a mandar teve
// efeito — a visibilidade é o que torna o resto verificável.

import { describe, expect, it } from 'vitest';
import { lerUsoDeCache, pctDeCache } from '../../../src/model/local/cache-usage.js';

describe('lerUsoDeCache — um número, três dialetos', () => {
  it('OpenAI/OpenRouter: aninhado em prompt_tokens_details', () => {
    expect(
      lerUsoDeCache({ prompt_tokens: 10_000, prompt_tokens_details: { cached_tokens: 8_192 } }),
    ).toEqual({ lidos: 8_192 });
  });

  it('DeepSeek: plano, no topo do usage', () => {
    expect(
      lerUsoDeCache({
        prompt_tokens: 10_000,
        prompt_cache_hit_tokens: 6_400,
        prompt_cache_miss_tokens: 3_600,
      }),
    ).toEqual({ lidos: 6_400 });
  });

  it('Anthropic: leitura E escrita são campos SEPARADOS', () => {
    // A escrita costuma ser cobrada com ágio — é ela que explica a primeira chamada sair
    // mais cara que o esperado.
    expect(
      lerUsoDeCache({ cache_read_input_tokens: 5_000, cache_creation_input_tokens: 1_200 }),
    ).toEqual({ lidos: 5_000, gravados: 1_200 });
  });

  it('provider MUDO devolve {} — que NÃO é o mesmo que zero', () => {
    // Zero = "o cache existe e não pegou". Ausente = "não dá para saber". A UI precisa
    // dizer coisas diferentes nos dois casos.
    expect(lerUsoDeCache({ prompt_tokens: 10_000, completion_tokens: 50 })).toEqual({});
    expect(lerUsoDeCache(undefined)).toEqual({});
    expect(lerUsoDeCache(null)).toEqual({});
    expect(lerUsoDeCache('nada disso')).toEqual({});
  });

  it('ZERO reportado é PRESERVADO (não vira ausente)', () => {
    expect(lerUsoDeCache({ prompt_tokens_details: { cached_tokens: 0 } })).toEqual({ lidos: 0 });
  });

  it('lixo da rede é ignorado, nunca chutado', () => {
    for (const v of ['8192', -1, Number.NaN, null, {}, []]) {
      expect(lerUsoDeCache({ prompt_tokens_details: { cached_tokens: v } })).toEqual({});
    }
  });

  it('`prompt_tokens_details` que não é objeto não quebra', () => {
    expect(lerUsoDeCache({ prompt_tokens_details: 'x' })).toEqual({});
    expect(lerUsoDeCache({ prompt_tokens_details: [1, 2] })).toEqual({});
  });
});

describe('pctDeCache — a fração é o que vale a pena mostrar', () => {
  it('calcula a porcentagem do prompt servida do cache', () => {
    expect(pctDeCache(10_000, 8_000)).toBe(80);
  });

  it('arredonda para inteiro', () => {
    expect(pctDeCache(3, 1)).toBe(33);
  });

  it('CLAMPA em 100 — no dialeto Anthropic o `lidos` não é subconjunto do `tokens_in`', () => {
    // Lá `input_tokens` já EXCLUI o que veio do cache, então a razão pode passar de 1.
    // Exibir "137% em cache" seria pior que não exibir.
    expect(pctDeCache(1_000, 2_000)).toBe(100);
  });

  it('sem dado não inventa número', () => {
    expect(pctDeCache(10_000, undefined)).toBeUndefined();
    expect(pctDeCache(undefined, 8_000)).toBeUndefined();
    expect(pctDeCache(0, 0)).toBeUndefined();
  });
});
