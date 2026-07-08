// EST-0973 (fix) — parseContextWindow + contextWindowForTier: resolve a janela
// de contexto REAL do catálogo (não o hardcoded 200k). Sem estas funções, a
// auto-compactação e o display `⛁ %` usavam 200k para TODOS os tiers, fazendo
// Strata (128k real) estourar antes do trigger de 85% (170k > 128k).

import { describe, expect, it } from 'vitest';
import {
  parseContextWindow,
  contextWindowForTier,
  resolveContextWindow,
  CONTEXT_WINDOW_ENV,
  FALLBACK_TIERS,
  DEFAULT_TIER_CONTEXT_TOKENS,
} from '../../src/model/catalog.js';
import type { TierCatalogEntry } from '@hiperplano/aluy-cli-core';

describe('parseContextWindow', () => {
  it('"256k" → 256000', () => {
    expect(parseContextWindow('256k')).toBe(256000);
  });

  it('"128k" → 128000', () => {
    expect(parseContextWindow('128k')).toBe(128000);
  });

  it('"200k" → 200000', () => {
    expect(parseContextWindow('200k')).toBe(200000);
  });

  it('"1M" → 1000000', () => {
    expect(parseContextWindow('1M')).toBe(1000000);
  });

  it('"2M" → 2000000', () => {
    expect(parseContextWindow('2M')).toBe(2000000);
  });

  it('número sem sufixo → ele mesmo', () => {
    expect(parseContextWindow('32000')).toBe(32000);
  });

  it('espaços extras são ignorados', () => {
    expect(parseContextWindow(' 128k ')).toBe(128000);
    expect(parseContextWindow('1 M')).toBe(1000000);
  });

  it('vazio/undefined/inválido ⇒ 0 (desconhecida)', () => {
    expect(parseContextWindow('')).toBe(0);
    expect(parseContextWindow('abc')).toBe(0);
    expect(parseContextWindow('k')).toBe(0);
    expect(parseContextWindow('M')).toBe(0);
  });

  it('sufixo lowercase/uppercase são equivalentes', () => {
    expect(parseContextWindow('128K')).toBe(128000);
    expect(parseContextWindow('1m')).toBe(1000000);
  });
});

describe('contextWindowForTier', () => {
  it('Flui (aluy-flux) → 256k (DeepSeek V4 Flash principal)', () => {
    expect(contextWindowForTier('aluy-flux', FALLBACK_TIERS)).toBe(256000);
  });

  it('Strata (aluy-strata) → 128k (DeepSeek V4 Pro principal)', () => {
    expect(contextWindowForTier('aluy-strata', FALLBACK_TIERS)).toBe(128000);
  });

  it('Cortex (aluy-deep) → 200k (Claude Sonnet 4.5 principal)', () => {
    expect(contextWindowForTier('aluy-deep', FALLBACK_TIERS)).toBe(200000);
  });

  it('Granito (aluy-granito) → 1M (MiniMax M3 principal)', () => {
    expect(contextWindowForTier('aluy-granito', FALLBACK_TIERS)).toBe(1000000);
  });

  it('custom → 0 (inerte, janela imprevisível)', () => {
    expect(contextWindowForTier('custom')).toBe(0);
    expect(contextWindowForTier('custom', FALLBACK_TIERS)).toBe(0);
  });

  it('string vazia → 0 (sem tier, inerte)', () => {
    expect(contextWindowForTier('')).toBe(0);
  });

  it('sem catálogo → usa FALLBACK_TIERS', () => {
    // Todos os tiers canônicos devem resolver sem catálogo explícito.
    expect(contextWindowForTier('aluy-flux')).toBe(256000);
    expect(contextWindowForTier('aluy-strata')).toBe(128000);
    expect(contextWindowForTier('aluy-deep')).toBe(200000);
    expect(contextWindowForTier('aluy-granito')).toBe(1000000);
  });

  it('catálogo vazio → cai no FALLBACK', () => {
    expect(contextWindowForTier('aluy-flux', [])).toBe(256000);
  });

  // ── HUNT (fix): tier CANÔNICO/conhecido sem janela mapeada NUNCA é 0 ──────────
  // Antes, um tier que o BROKER conhece mas que ainda não está no
  // FALLBACK_CONTEXT_TOKENS (tier NOVO) resolvia 0 ⇒ a auto-compactação ficava
  // INERTE ⇒ a janela ESTOURAVA (stall em 100%, a dor do dogfood). Agora cai no
  // PADRÃO protetor (200k) — a auto-compactação segue protegendo. `custom` (acima)
  // continua 0, que é o fail-safe correto (janela genuinamente imprevisível).

  it('tier NOVO do broker (no catálogo, FORA do mapa) → PADRÃO protetor, não 0', () => {
    // Catálogo VIVO traz um tier novo (`aluy-nova`) que o broker conhece mas que o
    // FALLBACK_CONTEXT_TOKENS hardcoded ainda não tem. SEM composição utilizável (HG-2),
    // não há `context` parseável ⇒ deve cair no PADRÃO protetor, NUNCA 0.
    const catalog: readonly TierCatalogEntry[] = [
      ...FALLBACK_TIERS,
      { key: 'aluy-nova', displayName: 'Nova', costSignal: 'standard', composition: [] },
    ];
    expect(contextWindowForTier('aluy-nova', catalog)).toBe(DEFAULT_TIER_CONTEXT_TOKENS);
    expect(contextWindowForTier('aluy-nova', catalog)).toBeGreaterThan(0);
  });

  it('tier NOVO do broker COM context real no catálogo → usa o context real', () => {
    // Quando o catálogo vivo TEM o `context` do principal, ele vence (fonte da verdade).
    const catalog: readonly TierCatalogEntry[] = [
      {
        key: 'aluy-nova',
        displayName: 'Nova',
        costSignal: 'standard',
        composition: [{ name: 'X', family: 'x', role: 'principal', context: '512k' }],
      },
    ];
    expect(contextWindowForTier('aluy-nova', catalog)).toBe(512000);
  });

  it('tier CANÔNICO desconhecido offline (fora do mapa) → PADRÃO protetor, não 0', () => {
    // Sem catálogo (offline), um `aluy-*` que não está no mapa cai no padrão — a
    // auto-compactação NÃO pode ficar inerte num tier que não é `custom`.
    expect(contextWindowForTier('aluy-xyz')).toBe(DEFAULT_TIER_CONTEXT_TOKENS);
    expect(contextWindowForTier('aluy-xyz', FALLBACK_TIERS)).toBe(DEFAULT_TIER_CONTEXT_TOKENS);
  });
});

// F64 — resolveContextWindow: override de env p/ habilitar compactação em custom/local.
describe('resolveContextWindow (F64 — janela via ALUY_CONTEXT_WINDOW p/ custom)', () => {
  it('tier conhecido VENCE o env (broker é a fonte da verdade)', () => {
    // Strata=128k; o env NÃO sobrepõe um tier com janela conhecida.
    expect(resolveContextWindow('aluy-strata', { [CONTEXT_WINDOW_ENV]: '64k' })).toBe(128_000);
  });

  it('custom SEM env → 0 (inerte, sem regressão)', () => {
    expect(resolveContextWindow('custom', {})).toBe(0);
    expect(resolveContextWindow('custom', { [CONTEXT_WINDOW_ENV]: '' })).toBe(0);
  });

  it('custom COM env → habilita a janela (aceita 128k / número cru / 1M)', () => {
    expect(resolveContextWindow('custom', { [CONTEXT_WINDOW_ENV]: '128k' })).toBe(128_000);
    expect(resolveContextWindow('custom', { [CONTEXT_WINDOW_ENV]: '200000' })).toBe(200_000);
    expect(resolveContextWindow('custom', { [CONTEXT_WINDOW_ENV]: '1M' })).toBe(1_000_000);
  });

  it('custom COM env inválido → 0 (não habilita lixo)', () => {
    expect(resolveContextWindow('custom', { [CONTEXT_WINDOW_ENV]: 'abc' })).toBe(0);
    expect(resolveContextWindow('custom', { [CONTEXT_WINDOW_ENV]: '-5' })).toBe(0);
  });

  it('ADR-0150: custom usa config.context.window quando não há env (env vence config)', () => {
    expect(resolveContextWindow('custom', {}, undefined, 256000)).toBe(256_000); // só config
    // env vence config
    expect(
      resolveContextWindow('custom', { [CONTEXT_WINDOW_ENV]: '128k' }, undefined, 256000),
    ).toBe(128_000);
    // tier conhecido vence ambos
    expect(resolveContextWindow('aluy-strata', {}, undefined, 256000)).toBe(128_000);
    // config inválida (<=0/não-inteiro) ⇒ 0
    expect(resolveContextWindow('custom', {}, undefined, 0)).toBe(0);
    expect(resolveContextWindow('custom', {}, undefined, -5)).toBe(0);
  });

  it('env default vazio ({}) ⇒ custom continua 0', () => {
    expect(resolveContextWindow('')).toBe(0);
  });
});
