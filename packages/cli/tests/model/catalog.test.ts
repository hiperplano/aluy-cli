// EST-0962 — testes do fallback de catálogo + helpers de display do seletor `/model`.

import { describe, it, expect, vi } from 'vitest';
import type { TierCatalogEntry } from '@aluy/cli-core';
import {
  FALLBACK_TIERS,
  costLabel,
  principalModel,
  tierLine,
  tierDisplayName,
  resolveTierKey,
  applyTierLiteral,
} from '../../src/model/catalog.js';

const strata: TierCatalogEntry = {
  key: 'aluy-strata',
  displayName: 'Strata',
  costSignal: 'standard',
  composition: [
    { name: 'GPT-4o', family: 'OpenAI', role: 'reserva', context: '128k' },
    { name: 'Claude 3.5 Sonnet', family: 'Anthropic', role: 'principal', context: '200k' },
  ],
};

describe('FALLBACK_TIERS', () => {
  it('cobre os tiers conhecidos (flux/granito/strata/deep) na ordem de RANK do broker', () => {
    // EST-0962 — paridade com o broker (rank flux < granito < strata < deep).
    expect(FALLBACK_TIERS.map((t) => t.key)).toEqual([
      'aluy-flux',
      'aluy-granito',
      'aluy-strata',
      'aluy-deep',
    ]);
    expect(FALLBACK_TIERS.map((t) => t.costSignal)).toEqual([
      'economical',
      'standard', // granito (profile balanced)
      'standard',
      'premium',
    ]);
    // HG-2: o fallback NÃO inventa modelo concreto (composição vazia — só o broker sabe).
    expect(FALLBACK_TIERS.every((t) => t.composition.length === 0)).toBe(true);
  });

  it('usa os display_name ATUAIS do broker (Flui/Granito/Strata/Cortex — migrations 0002/0012/0020)', () => {
    // EST-0991/EST-0162 — a `key` é IMUTÁVEL; só o display_name mudou no broker
    // ("Aluy Flux"→"Flui", "Aluy Deep"→"Cortex"). O fallback espelha o display ATUAL.
    expect(FALLBACK_TIERS.map((t) => t.displayName)).toEqual([
      'Flui',
      'Granito',
      'Strata',
      'Cortex',
    ]);
  });

  it('Cortex é o display de `aluy-deep` — NÃO existe chave `aluy-cortex` (rename = DADO, não key)', () => {
    const cortex = FALLBACK_TIERS.find((t) => t.displayName === 'Cortex');
    expect(cortex).toBeDefined();
    expect(cortex!.key).toBe('aluy-deep');
    // A key renomeada NÃO existe (renomear tier não muda a key/código — ADR-0030).
    expect(FALLBACK_TIERS.some((t) => t.key === 'aluy-cortex')).toBe(false);
  });

  it('inclui o Granito (tier do broker) com display PT-BR — aparece no /model offline', () => {
    const granito = FALLBACK_TIERS.find((t) => t.key === 'aluy-granito');
    expect(granito).toBeDefined();
    expect(granito!.displayName).toBe('Granito');
  });
});

describe('costLabel', () => {
  it('mapeia o sinal de custo p/ PT-BR', () => {
    expect(costLabel('economical')).toBe('econômico');
    expect(costLabel('standard')).toBe('padrão');
    expect(costLabel('premium')).toBe('premium');
    expect(costLabel('weird')).toBe('weird');
  });
});

describe('principalModel / tierLine', () => {
  it('pega o modelo PRINCIPAL (role) mesmo fora de ordem', () => {
    expect(principalModel(strata)).toBe('Claude 3.5 Sonnet');
  });
  it('monta a linha tier · modelo · custo', () => {
    expect(tierLine(strata)).toBe('Strata · Claude 3.5 Sonnet · padrão');
  });
  it('sem composição (fallback) elide o modelo: tier · custo', () => {
    expect(tierLine(FALLBACK_TIERS[0]!)).toBe('Flui · econômico');
  });
  it('o tier premium exibe o display ATUAL do broker (Cortex), não o antigo (Deep)', () => {
    const cortex = FALLBACK_TIERS.find((t) => t.key === 'aluy-deep')!;
    expect(tierLine(cortex)).toBe('Cortex · premium');
  });
});

describe('tierDisplayName (EST-0962 — KEY interna → NOME de exibição)', () => {
  it('o MAPA LOCAL (FALLBACK_TIERS) resolve a key quando não há catálogo (401/ausente)', () => {
    // O bug: o footer/header/picker mostravam `aluy-granito`; agora mostram `Granito`.
    expect(tierDisplayName('aluy-granito')).toBe('Granito');
    expect(tierDisplayName('aluy-flux')).toBe('Flui');
    expect(tierDisplayName('aluy-strata')).toBe('Strata');
    expect(tierDisplayName('aluy-deep')).toBe('Cortex');
  });
  it('o CATÁLOGO do broker VENCE o mapa local (renome/tier novo sem tocar no código)', () => {
    const fromBroker: readonly TierCatalogEntry[] = [
      { key: 'aluy-granito', displayName: 'Granito Pro', costSignal: 'standard', composition: [] },
      { key: 'aluy-novo', displayName: 'Quartzo', costSignal: 'premium', composition: [] },
    ];
    // catálogo presente ⇒ o display_name dele vence o fallback local.
    expect(tierDisplayName('aluy-granito', fromBroker)).toBe('Granito Pro');
    // tier NOVO que só o broker conhece ⇒ usa o display do catálogo.
    expect(tierDisplayName('aluy-novo', fromBroker)).toBe('Quartzo');
    // key fora do catálogo mas no mapa local ⇒ cai no fallback local.
    expect(tierDisplayName('aluy-flux', fromBroker)).toBe('Flui');
  });
  it('catálogo VAZIO (401/provisionamento) ⇒ usa só o mapa local', () => {
    expect(tierDisplayName('aluy-deep', [])).toBe('Cortex');
  });
  it('tier DESCONHECIDO (sem mapa nem catálogo) ⇒ a própria key (último recurso, não quebra)', () => {
    expect(tierDisplayName('aluy-quartzo')).toBe('aluy-quartzo');
    expect(tierDisplayName('aluy-quartzo', [])).toBe('aluy-quartzo');
  });
  it('a via CUSTOM mantém a key `custom` (o slug vai separado — não entra no mapa)', () => {
    // O footer mostra `custom · <slug>`: o tier é `custom` (sem mapa), o slug é o `model`.
    expect(tierDisplayName('custom')).toBe('custom');
  });
});

describe('resolveTierKey', () => {
  it('aceita chave plena, nome curto e display name ATUAL (case-insensitive)', () => {
    expect(resolveTierKey('aluy-deep')).toBe('aluy-deep');
    expect(resolveTierKey('STRATA')).toBe('aluy-strata');
    // display ATUAL do broker (Cortex/Flui) casa pela varredura de displayName.
    expect(resolveTierKey('cortex')).toBe('aluy-deep');
    expect(resolveTierKey('Cortex')).toBe('aluy-deep');
    expect(resolveTierKey('flui')).toBe('aluy-flux');
  });
  it('mantém o alias LEGADO "deep" (display antigo) → aluy-deep (compat, não regride)', () => {
    expect(resolveTierKey('deep')).toBe('aluy-deep');
    expect(resolveTierKey('Deep')).toBe('aluy-deep');
  });
  it('resolve o Granito por chave/nome curto/display (tier do broker no fallback)', () => {
    expect(resolveTierKey('aluy-granito')).toBe('aluy-granito');
    expect(resolveTierKey('granito')).toBe('aluy-granito');
    expect(resolveTierKey('Granito')).toBe('aluy-granito');
  });
  it('aceita chave aluy-* bem-formada desconhecida (o broker valida na chamada)', () => {
    expect(resolveTierKey('aluy-experimental')).toBe('aluy-experimental');
  });
  it('rejeita lixo', () => {
    expect(resolveTierKey('gpt-4o')).toBeUndefined();
    expect(resolveTierKey('')).toBeUndefined();
    expect(resolveTierKey('   ')).toBeUndefined();
  });
});

describe('applyTierLiteral', () => {
  it('troca pela KEY mas a nota mostra o NOME DE EXIBIÇÃO (EST-0962: Cortex, não aluy-deep)', () => {
    const setTier = vi.fn();
    const note = applyTierLiteral(setTier, 'deep');
    // setTier recebe a KEY (load-bearing — o broker resolve por key).
    expect(setTier).toHaveBeenCalledWith('aluy-deep');
    // A nota mostra o display amigável, NÃO a key crua (o que o usuário lê).
    expect(note.lines.join(' ')).toContain('Cortex');
    expect(note.lines.join(' ')).not.toContain('aluy-deep');
    expect(note.lines.join(' ')).not.toMatch(/openai|anthropic|api_key|vault/i);
  });
  it('--tier aluy-granito ⇒ troca pela KEY, nota mostra "Granito" (tier do Tiago, EST-0962)', () => {
    const setTier = vi.fn();
    const note = applyTierLiteral(setTier, 'aluy-granito');
    expect(setTier).toHaveBeenCalledWith('aluy-granito');
    expect(note.lines.join(' ')).toContain('Granito');
    expect(note.lines.join(' ')).not.toContain('aluy-granito');
  });
  it('--tier de um tier aluy-* DESCONHECIDO ⇒ vai ao broker; nota cai na key crua (último recurso)', () => {
    const setTier = vi.fn();
    const note = applyTierLiteral(setTier, 'aluy-quartzo');
    expect(setTier).toHaveBeenCalledWith('aluy-quartzo');
    // Sem mapa local nem catálogo ⇒ a nota mostra a própria key (não inventa nome, não quebra).
    expect(note.lines.join(' ')).toContain('aluy-quartzo');
  });
  it('tier desconhecido (sem cara de tier) ⇒ trata como slug Custom', () => {
    // F147 fix: `/model gpt-4o` com arg que NÃO é tier conhecido ⇒ setTier('custom', 'gpt-4o').
    const setTier = vi.fn();
    const note = applyTierLiteral(setTier, 'gpt-4o');
    expect(setTier).toHaveBeenCalledWith('custom', 'gpt-4o');
    expect(note.lines.join(' ')).toContain('Custom');
    expect(note.lines.join(' ')).toContain('gpt-4o');
    // NÃO lista tiers conhecidos — é uma troca efetiva (não é erro).
    expect(note.lines.join(' ')).not.toContain('desconhecido');
  });
});
