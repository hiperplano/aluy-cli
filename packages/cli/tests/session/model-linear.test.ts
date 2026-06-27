// EST-0962 — `/model` em modo NÃO-TTY (linear): sem picker. `/model` lista os tiers;
// `/model <tier>` troca. Catálogo do broker com FALLBACK; HG-2 (nunca o provider).

import { describe, expect, it, vi } from 'vitest';
import type { TierCatalogEntry } from '@aluy/cli-core';
import { runModelLinear, type LinearOut } from '../../src/session/linear.js';

const CATALOG: readonly TierCatalogEntry[] = [
  {
    key: 'aluy-flux',
    displayName: 'Flux',
    costSignal: 'economical',
    composition: [{ name: 'GPT-4o mini', family: 'OpenAI', role: 'principal', context: '128k' }],
  },
  {
    key: 'aluy-strata',
    displayName: 'Strata',
    costSignal: 'standard',
    composition: [
      { name: 'Claude 3.5 Sonnet', family: 'Anthropic', role: 'principal', context: '200k' },
    ],
  },
];

function makeOut(): { out: LinearOut; text: () => string } {
  let buf = '';
  return { out: { write: (c) => (buf += c) }, text: () => buf };
}

const okCatalog = { list: async () => CATALOG };
const failingCatalog = {
  list: async () => {
    throw new Error('broker down');
  },
};

describe('runModelLinear — listagem (não-TTY)', () => {
  it('`/model` lista os tiers do catálogo, marcando o ativo', async () => {
    const { out, text } = makeOut();
    const handled = await runModelLinear('/model', out, {
      catalog: okCatalog,
      tier: { setTier: vi.fn() },
      currentTier: 'aluy-strata',
    });
    expect(handled).toBe(true);
    const o = text();
    expect(o).toContain('Flux · GPT-4o mini · econômico');
    expect(o).toContain('Strata · Claude 3.5 Sonnet · padrão');
    expect(o).toContain('(ativo)'); // marca o tier corrente
    // HG-2: nada de credencial/roteamento.
    expect(o).not.toMatch(/api_key|vault|base_url|bearer/i);
  });

  it('catálogo indisponível ⇒ FALLBACK de tiers conhecidos + aviso NEUTRO', async () => {
    const { out, text } = makeOut();
    await runModelLinear('/model', out, {
      catalog: failingCatalog,
      tier: { setTier: vi.fn() },
      currentTier: 'aluy-flux',
    });
    const o = text();
    // FALLBACK usa o display_name ATUAL do broker (Flui/Cortex — migrations 0012/0020).
    // HG-2: o fallback NÃO inventa o NOME do modelo (composição vazia) — só tier · custo.
    expect(o).toContain('Flui · econômico');
    expect(o).toContain('Granito · padrão');
    expect(o).toContain('Strata · padrão');
    expect(o).toContain('Cortex · premium');
    expect(o).toContain('broker indisponível');
  });
});

describe('runModelLinear — troca literal (não-TTY)', () => {
  it('`/model aluy-deep` TROCA o tier (sem rede) e confirma', async () => {
    const { out, text } = makeOut();
    const setTier = vi.fn();
    const handled = await runModelLinear('/model aluy-deep', out, {
      catalog: okCatalog,
      tier: { setTier },
      currentTier: 'aluy-flux',
    });
    expect(handled).toBe(true);
    // setTier recebe a KEY (load-bearing); a nota mostra o NOME de exibição (EST-0962).
    expect(setTier).toHaveBeenCalledWith('aluy-deep', undefined);
    expect(text()).toContain('tier trocado para: Cortex');
    expect(text()).not.toContain('tier trocado para: aluy-deep');
  });

  it('`/model deep` (nome curto) também resolve p/ a chave canônica', async () => {
    const { out } = makeOut();
    const setTier = vi.fn();
    await runModelLinear('/model deep', out, {
      catalog: okCatalog,
      tier: { setTier },
      currentTier: 'aluy-flux',
    });
    expect(setTier).toHaveBeenCalledWith('aluy-deep', undefined);
  });

  it('`/model gpt-4o` (não é tier) ⇒ trata como modelo Custom (F147)', async () => {
    const { out, text } = makeOut();
    const setTier = vi.fn();
    await runModelLinear('/model gpt-4o', out, {
      catalog: okCatalog,
      tier: { setTier },
      currentTier: 'aluy-flux',
    });
    // F147 — arg que não casa um tier conhecido vira slug de modelo Custom (warn-but-allow).
    expect(setTier).toHaveBeenCalledWith('custom', 'gpt-4o');
    expect(text()).toContain('Custom');
    expect(text()).not.toContain('desconhecido');
  });
});

describe('runModelLinear — só trata /model', () => {
  it('objetivo comum NÃO é tratado (devolve false)', async () => {
    const { out } = makeOut();
    const handled = await runModelLinear('liste os arquivos', out, {
      catalog: okCatalog,
      tier: { setTier: vi.fn() },
      currentTier: 'aluy-flux',
    });
    expect(handled).toBe(false);
  });

  it('undefined (sem objetivo) ⇒ false', async () => {
    const { out } = makeOut();
    expect(
      await runModelLinear(undefined, out, {
        catalog: okCatalog,
        tier: { setTier: vi.fn() },
        currentTier: 'aluy-flux',
      }),
    ).toBe(false);
  });
});
