// EST-0977 · EST-0962 · ADR-0061 · CLI-SEC-7 (GS-MD4) — `model`→`tier` (mapa PURO).
// O `.md` só carrega PREFERÊNCIA de tier; a resolução tier→provider/chave é 100% do
// broker. SINÔNIMO amigável (haiku/sonnet/…) → chave Aluy; chave `aluy-*` desconhecida
// (tier novo do broker) PASSA ADIANTE (o broker valida); `model` cru de provider ⇒
// undefined (o chamador usa o tier da SESSÃO; nunca provider direto).

import { describe, expect, it } from 'vitest';
import { resolveModelTier, ALUY_TIER_KEYS } from '../../src/index.js';

describe('resolveModelTier (GS-MD4)', () => {
  it('vocabulário Claude Code → tier do Aluy', () => {
    expect(resolveModelTier('haiku')).toBe('aluy-flux');
    expect(resolveModelTier('sonnet')).toBe('aluy-strata');
    expect(resolveModelTier('opus')).toBe('aluy-deep');
  });

  it('chaves nativas do Aluy passam direto', () => {
    expect(resolveModelTier('aluy-deep')).toBe('aluy-deep');
    expect(resolveModelTier('strata')).toBe('aluy-strata');
  });

  it('display ATUAL "cortex" e o legado "deep" → a MESMA key aluy-deep (sem chave aluy-cortex)', () => {
    // migration 0012: "Aluy Deep"→"Cortex"; a key é IMUTÁVEL. Os dois nomes resolvem
    // p/ `aluy-deep`. `aluy-cortex` NÃO é uma key — só PASSA cru (o broker recusa).
    expect(resolveModelTier('cortex')).toBe('aluy-deep');
    expect(resolveModelTier('Cortex')).toBe('aluy-deep');
    expect(resolveModelTier('deep')).toBe('aluy-deep');
  });

  it('case-insensitive + espaços', () => {
    expect(resolveModelTier('  Sonnet ')).toBe('aluy-strata');
  });

  // EST-0962 — o broker é a FONTE: um tier do broker que o CLI não tem hardcoded
  // (ex.: o `aluy-granito` do Tiago) NÃO pode ser barrado nem cair no default.
  it('aluy-granito (tier do broker) resolve via sinônimo conhecido', () => {
    expect(resolveModelTier('aluy-granito')).toBe('aluy-granito');
    expect(resolveModelTier('granito')).toBe('aluy-granito');
    expect(resolveModelTier(' Granito ')).toBe('aluy-granito');
  });

  it('chave aluy-* DESCONHECIDA (tier novo do broker) PASSA ADIANTE — não vira undefined', () => {
    // Um `model: aluy-quartzo` num `.md` deve ir AO BROKER (que valida), não ser
    // barrado por não estar na tabela de sinônimos nem cair no tier da sessão.
    expect(resolveModelTier('aluy-quartzo')).toBe('aluy-quartzo');
    expect(resolveModelTier('  Aluy-Experimental ')).toBe('aluy-experimental');
  });

  it('model cru de PROVIDER ⇒ undefined (fallback ao tier da SESSÃO, nunca provider)', () => {
    // Sem cara de tier `aluy-*`: o CLI não inventa tier — usa o da sessão.
    expect(resolveModelTier('gpt-9-turbo')).toBeUndefined();
    expect(resolveModelTier('claude-opus-4')).toBeUndefined();
    expect(resolveModelTier('')).toBeUndefined();
    expect(resolveModelTier(undefined)).toBeUndefined();
  });

  it('sinônimo amigável sempre resolve p/ uma chave Aluy conhecida (nunca provider cru)', () => {
    for (const m of ['haiku', 'sonnet', 'opus', 'fast', 'premium', 'granito']) {
      const t = resolveModelTier(m);
      expect(t && (ALUY_TIER_KEYS as readonly string[]).includes(t)).toBe(true);
    }
  });
});
