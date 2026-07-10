// EST-0977 · EST-0962 · ADR-0061 · ADR-0146 · CLI-SEC-7 (GS-MD4) — `model`→`tier`.
// O `.md`/`spawn_agent`/dial só carregam PREFERÊNCIA de tier; a resolução
// tier→provider/chave é 100% do broker. SINÔNIMO amigável (haiku/sonnet/…) → chave
// Aluy; chave `aluy-*` desconhecida (tier novo do broker) PASSA ADIANTE (o broker
// valida); sentinelas de HERANÇA/BYO (`same-as-parent`/`custom`) fecham o gap BYO
// (ADR-0146 D3); `model` cru sem cara de tier ⇒ `kind:'unknown'` — candidato a ERRO
// do probe (D2), NUNCA mais herança silenciosa.

import { describe, expect, it } from 'vitest';
import {
  resolveModelTier,
  ALUY_TIER_KEYS,
  knownModelNames,
  suggestModelName,
  formatUnknownModelError,
  isCostlierTier,
  formatResolvedModelLabel,
} from '../../src/index.js';

describe('resolveModelTier (GS-MD4 · ADR-0146)', () => {
  it('vocabulário Claude Code → tier do Aluy', () => {
    expect(resolveModelTier('haiku')).toEqual({ kind: 'tier', key: 'aluy-flux' });
    expect(resolveModelTier('sonnet')).toEqual({ kind: 'tier', key: 'aluy-strata' });
    expect(resolveModelTier('opus')).toEqual({ kind: 'tier', key: 'aluy-deep' });
  });

  it('chaves nativas do Aluy passam direto', () => {
    expect(resolveModelTier('aluy-deep')).toEqual({ kind: 'tier', key: 'aluy-deep' });
    expect(resolveModelTier('strata')).toEqual({ kind: 'tier', key: 'aluy-strata' });
  });

  it('display ATUAL "cortex" e o legado "deep" → a MESMA key aluy-deep (sem chave aluy-cortex)', () => {
    // migration 0012: "Aluy Deep"→"Cortex"; a key é IMUTÁVEL. Os dois nomes resolvem
    // p/ `aluy-deep`. `aluy-cortex` NÃO é uma key — só PASSA cru (o broker recusa).
    expect(resolveModelTier('cortex')).toEqual({ kind: 'tier', key: 'aluy-deep' });
    expect(resolveModelTier('Cortex')).toEqual({ kind: 'tier', key: 'aluy-deep' });
    expect(resolveModelTier('deep')).toEqual({ kind: 'tier', key: 'aluy-deep' });
  });

  it('case-insensitive + espaços', () => {
    expect(resolveModelTier('  Sonnet ')).toEqual({ kind: 'tier', key: 'aluy-strata' });
  });

  // EST-0962 — o broker é a FONTE: um tier do broker que o CLI não tem hardcoded
  // (ex.: o `aluy-granito` do Tiago) NÃO pode ser barrado nem cair no default.
  it('aluy-granito (tier do broker) resolve via sinônimo conhecido', () => {
    expect(resolveModelTier('aluy-granito')).toEqual({ kind: 'tier', key: 'aluy-granito' });
    expect(resolveModelTier('granito')).toEqual({ kind: 'tier', key: 'aluy-granito' });
    expect(resolveModelTier(' Granito ')).toEqual({ kind: 'tier', key: 'aluy-granito' });
  });

  it('chave aluy-* DESCONHECIDA (tier novo do broker) PASSA ADIANTE — kind:"tier"', () => {
    // Um `model: aluy-quartzo` num `.md` deve ir AO BROKER (que valida), não ser
    // barrado por não estar na tabela de sinônimos nem virar erro do probe.
    expect(resolveModelTier('aluy-quartzo')).toEqual({ kind: 'tier', key: 'aluy-quartzo' });
    expect(resolveModelTier('  Aluy-Experimental ')).toEqual({
      kind: 'tier',
      key: 'aluy-experimental',
    });
  });

  it('ausência/vazio ⇒ kind:"inherit" (herança deliberada — default de hoje)', () => {
    expect(resolveModelTier(undefined)).toEqual({ kind: 'inherit' });
    expect(resolveModelTier('')).toEqual({ kind: 'inherit' });
    expect(resolveModelTier('   ')).toEqual({ kind: 'inherit' });
  });

  it('sentinelas de HERANÇA explícita (D3): same-as-parent/parent/inherit', () => {
    expect(resolveModelTier('same-as-parent')).toEqual({ kind: 'inherit' });
    expect(resolveModelTier('parent')).toEqual({ kind: 'inherit' });
    expect(resolveModelTier('inherit')).toEqual({ kind: 'inherit' });
    expect(resolveModelTier('  Same-As-Parent ')).toEqual({ kind: 'inherit' });
  });

  it('sentinela BYO/Custom (D3): "custom" sem slug', () => {
    expect(resolveModelTier('custom')).toEqual({ kind: 'custom' });
    expect(resolveModelTier(' Custom ')).toEqual({ kind: 'custom' });
  });

  it('sentinela BYO/Custom (D3): "custom:<slug>" preserva o CASE do slug', () => {
    expect(resolveModelTier('custom:meta-llama/Llama-3.3-70B')).toEqual({
      kind: 'custom',
      slug: 'meta-llama/Llama-3.3-70B',
    });
    // prefixo case-insensitive.
    expect(resolveModelTier('CUSTOM:minha-slug')).toEqual({ kind: 'custom', slug: 'minha-slug' });
    // slug vazio após o prefixo ⇒ cai no "custom" sem slug (não é erro).
    expect(resolveModelTier('custom:')).toEqual({ kind: 'custom' });
    expect(resolveModelTier('custom:   ')).toEqual({ kind: 'custom' });
  });

  it('model cru de PROVIDER (sem cara de tier/sentinela) ⇒ kind:"unknown" (candidato a erro, D2)', () => {
    const gpt = resolveModelTier('gpt-9-turbo');
    expect(gpt).toEqual({ kind: 'unknown', raw: 'gpt-9-turbo' });
    expect(resolveModelTier('claude-opus-4')).toEqual({
      kind: 'unknown',
      raw: 'claude-opus-4',
    });
  });

  it('sinônimo amigável sempre resolve p/ uma chave Aluy conhecida (nunca provider cru)', () => {
    for (const m of ['haiku', 'sonnet', 'opus', 'fast', 'premium', 'granito']) {
      const t = resolveModelTier(m);
      expect(t.kind).toBe('tier');
      expect(t.kind === 'tier' && (ALUY_TIER_KEYS as readonly string[]).includes(t.key)).toBe(
        true,
      );
    }
  });
});

describe('ADR-0146 (D2/L2) — probe de sugestão de nome de modelo', () => {
  it('suggestModelName sugere o mais próximo por distância de edição', () => {
    expect(suggestModelName('sonet', ['haiku', 'sonnet', 'opus'])).toBe('sonnet');
    expect(suggestModelName('grnito', knownModelNames())).toBe('granito');
  });

  it('suggestModelName NÃO sugere p/ string totalmente diferente (sem lixo bizarro)', () => {
    expect(suggestModelName('xxxxxxxxxxxxxxxxxxxx', ['haiku', 'sonnet', 'opus'])).toBeUndefined();
  });

  it('suggestModelName devolve undefined p/ entrada vazia ou sem candidatos', () => {
    expect(suggestModelName('', ['haiku'])).toBeUndefined();
    expect(suggestModelName('haiku', [])).toBeUndefined();
  });

  it('formatUnknownModelError inclui sugestão + lista de disponíveis (catálogo vivo)', () => {
    const msg = formatUnknownModelError('sonet', ['aluy-flux', 'aluy-strata', 'aluy-deep']);
    expect(msg).toMatch(/sonet/);
    expect(msg).toMatch(/sonnet/); // sugestão do vocabulário conhecido
    expect(msg).toMatch(/Disponíveis/);
    // NUNCA credencial/provider na mensagem.
    expect(msg).not.toMatch(/\b(provider|base_?url|api[_-]?key|token|secret|authorization)\b/i);
  });

  it('formatUnknownModelError degrada HONESTO quando o catálogo não pôde ser confirmado', () => {
    const msg = formatUnknownModelError('gpt-9-turbo', undefined);
    expect(msg).toMatch(/não deu para confirmar no catálogo/);
    expect(msg).not.toMatch(/\b(provider|base_?url|api[_-]?key|token|secret|authorization)\b/i);
  });
});

describe('ADR-0146 (Q-3) — isCostlierTier (aviso não-bloqueante de custo)', () => {
  it('detecta tier hospedado MAIS CARO que o corrente', () => {
    expect(isCostlierTier('aluy-deep', 'aluy-flux')).toBe(true);
    expect(isCostlierTier('aluy-strata', 'aluy-granito')).toBe(true);
  });

  it('NÃO acusa quando é mais barato ou igual', () => {
    expect(isCostlierTier('aluy-flux', 'aluy-deep')).toBe(false);
    expect(isCostlierTier('aluy-strata', 'aluy-strata')).toBe(false);
  });

  it('sem dado de custo (tier desconhecido/custom) ⇒ false — nunca bloqueia', () => {
    expect(isCostlierTier('aluy-quartzo', 'aluy-flux')).toBe(false);
    expect(isCostlierTier('custom', 'aluy-flux')).toBe(false);
  });
});

describe('ADR-0146 (D5) — formatResolvedModelLabel (rótulo de UI, sem credencial)', () => {
  it('kind:"tier" ⇒ a própria chave', () => {
    expect(
      formatResolvedModelLabel({ kind: 'tier', key: 'aluy-strata' }, { tier: 'aluy-flux' }),
    ).toBe('aluy-strata');
  });

  it('kind:"custom" com slug indicado ⇒ "custom · <slug>"', () => {
    expect(
      formatResolvedModelLabel(
        { kind: 'custom', slug: 'meu-slug' },
        { tier: 'custom', model: 'slug-do-pai' },
      ),
    ).toBe('custom · meu-slug');
  });

  it('kind:"custom" SEM slug ⇒ usa o slug do PAI', () => {
    expect(
      formatResolvedModelLabel({ kind: 'custom' }, { tier: 'custom', model: 'slug-do-pai' }),
    ).toBe('custom · slug-do-pai');
  });

  it('kind:"inherit" ⇒ "herdado (<tier do pai>)" / "herdado (custom · <slug>)"', () => {
    expect(formatResolvedModelLabel({ kind: 'inherit' }, { tier: 'aluy-flux' })).toBe(
      'herdado (aluy-flux)',
    );
    expect(
      formatResolvedModelLabel({ kind: 'inherit' }, { tier: 'custom', model: 'x/y' }),
    ).toBe('herdado (custom · x/y)');
  });

  it('NUNCA inclui provider/base_url/api_key/token no rótulo', () => {
    const label = formatResolvedModelLabel(
      { kind: 'inherit' },
      { tier: 'custom', model: 'meta-llama/llama-3.3-70b' },
    );
    expect(label).not.toMatch(/\b(provider|base_?url|api[_-]?key|token|secret|authorization)\b/i);
  });
});

describe('ADR-0152 (D5-bis) — formatResolvedModelLabel + parent.activeModel (precedência)', () => {
  it('kind:"inherit" + activeModel presente ⇒ "herdado (<activeModel>)" (modelo LOCAL concreto)', () => {
    expect(
      formatResolvedModelLabel(
        { kind: 'inherit' },
        { tier: 'aluy-flux', activeModel: 'deepseek-v4-pro' },
      ),
    ).toBe('herdado (deepseek-v4-pro)');
  });

  it('kind:"unknown" + activeModel presente ⇒ mesma precedência (também cai em "inherit")', () => {
    expect(
      formatResolvedModelLabel(
        { kind: 'unknown', raw: 'deepseek-v4-flash' },
        { tier: 'aluy-flux', activeModel: 'deepseek-v4-pro' },
      ),
    ).toBe('herdado (deepseek-v4-pro)');
  });

  it('activeModel AUSENTE + parent.tier="custom" ⇒ "herdado (custom · <slug>)" — INALTERADO', () => {
    expect(
      formatResolvedModelLabel({ kind: 'inherit' }, { tier: 'custom', model: 'x' }),
    ).toBe('herdado (custom · x)');
  });

  it('activeModel AUSENTE + só tier ⇒ "herdado (<tier>)" — INALTERADO', () => {
    expect(
      formatResolvedModelLabel({ kind: 'inherit' }, { tier: 'aluy-strata' }),
    ).toBe('herdado (aluy-strata)');
  });

  it('activeModel presente NÃO afeta kind:"tier"/"custom" (só o ramo inherit/unknown)', () => {
    expect(
      formatResolvedModelLabel(
        { kind: 'tier', key: 'aluy-deep' },
        { tier: 'aluy-flux', activeModel: 'deepseek-v4-pro' },
      ),
    ).toBe('aluy-deep');
    expect(
      formatResolvedModelLabel(
        { kind: 'custom', slug: 'meu-slug' },
        { tier: 'custom', model: 'slug-do-pai', activeModel: 'deepseek-v4-pro' },
      ),
    ).toBe('custom · meu-slug');
  });

  it('NUNCA inclui provider/base_url/api_key/token mesmo com activeModel', () => {
    const label = formatResolvedModelLabel(
      { kind: 'inherit' },
      { tier: 'aluy-flux', activeModel: 'deepseek-v4-pro' },
    );
    expect(label).not.toMatch(/\b(provider|base_?url|api[_-]?key|token|secret|authorization)\b/i);
  });
});
