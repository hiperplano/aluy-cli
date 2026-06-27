// EST-0962 — render do <ModelPicker> (ink-testing-library). Cobre: lista de tiers
// com nome amigável + sinal de custo, marcador do tier ATIVO (●) e do selecionado
// (›), dica de teclas, aviso de fallback, e o INVARIANTE HG-2 (nunca vaza credencial/
// roteamento — só nome PÚBLICO do catálogo).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { ModelPicker } from '../../src/ui/components/ModelPicker.js';
import type { CustomBrowseRow } from '../../src/ui/hooks/useModelPicker.js';
import type { TierCatalogEntry } from '@aluy/cli-core';
import { effortOptions } from '@aluy/cli-core';

function wrap(node: React.ReactElement) {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

const TIERS: readonly TierCatalogEntry[] = [
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

describe('ModelPicker — seletor de tiers', () => {
  it('mostra a dica de teclas (↑↓/enter/esc) e o verbo "trocar"', () => {
    const { lastFrame } = wrap(
      <ModelPicker tiers={TIERS} selected={0} currentTier="aluy-flux" usingFallback={false} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('↑↓');
    expect(out).toContain('troca');
  });

  it('lista cada tier com nome amigável do modelo + sinal de custo (PT-BR)', () => {
    const { lastFrame } = wrap(
      <ModelPicker tiers={TIERS} selected={0} currentTier="aluy-flux" usingFallback={false} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Strata');
    expect(out).toContain('Claude 3.5 Sonnet');
    expect(out).toContain('padrão'); // standard → padrão
    expect(out).toContain('econômico'); // economical → econômico
  });

  it('marca o tier ATIVO com ● e o selecionado com › (a11y: não só cor)', () => {
    const { lastFrame } = wrap(
      <ModelPicker tiers={TIERS} selected={1} currentTier="aluy-flux" usingFallback={false} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('●'); // ativo (flux)
    expect(out).toContain('›'); // selecionado (strata)
  });

  it('mostra o aviso NEUTRO de fallback (HG-2: "broker", nunca o provider)', () => {
    const fallback: readonly TierCatalogEntry[] = [
      { key: 'aluy-flux', displayName: 'Flux', costSignal: 'economical', composition: [] },
    ];
    const { lastFrame } = wrap(
      <ModelPicker tiers={fallback} selected={0} currentTier="aluy-flux" usingFallback={true} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('broker');
    expect(out).toContain('Flux');
    // sem composição ⇒ não mostra modelo concreto, mas mostra o custo.
    expect(out).toContain('econômico');
  });

  it('HG-2: NUNCA vaza provider de credencial/roteamento — só nome público', () => {
    const { lastFrame } = wrap(
      <ModelPicker tiers={TIERS} selected={0} currentTier="aluy-flux" usingFallback={false} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toMatch(/api_key|api[_-]?key|vault|base_url|bearer|sk-/i);
  });

  it('estado de carregamento mostra a dica neutra', () => {
    const { lastFrame } = wrap(
      <ModelPicker tiers={[]} selected={0} currentTier="aluy-flux" loading />,
    );
    expect(plain(lastFrame() ?? '')).toContain('carregando');
  });
});

describe('ModelPicker — via CUSTOM (ADR-0030 §3 / ADR-0065)', () => {
  it('mostra a linha CUSTOM como a ÚLTIMA opção da lista', () => {
    const { lastFrame } = wrap(
      <ModelPicker tiers={TIERS} selected={0} currentTier="aluy-flux" usingFallback={false} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Custom');
    // EST-0962 — a linha Custom agora convida a NAVEGAR/filtrar (não só "digitar slug").
    expect(out).toContain('navegar');
  });

  it('seleciona a linha Custom (selected === tiers.length) ⇒ marca › nela', () => {
    const { lastFrame } = wrap(
      <ModelPicker
        tiers={TIERS}
        selected={TIERS.length} // a linha Custom
        currentTier="aluy-flux"
        usingFallback={false}
        customSelected
      />,
    );
    const out = plain(lastFrame() ?? '');
    // o › aparece (na linha Custom) e a palavra Custom segue presente.
    expect(out).toContain('›');
    expect(out).toContain('Custom');
  });

  it('modo INPUT: mostra o campo de slug digitado + a dica de texto-livre', () => {
    const { lastFrame } = wrap(
      <ModelPicker
        tiers={TIERS}
        selected={TIERS.length}
        currentTier="aluy-flux"
        usingFallback={false}
        customInputOpen
        customInput="meta-llama/llama-3.1-8b"
        customSuggestions={[]}
        customWarnOutOfCatalog={false}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Custom');
    expect(out).toContain('meta-llama/llama-3.1-8b');
    expect(out).toContain('slug');
    // texto-livre puro (sem catálogo) ⇒ sem aviso de fora-do-catálogo.
    expect(out).not.toContain('fora do catálogo');
  });

  it('modo INPUT: catálogo carregado ⇒ SUGESTÕES + AVISO warn-but-allow visível', () => {
    const { lastFrame } = wrap(
      <ModelPicker
        tiers={TIERS}
        selected={TIERS.length}
        currentTier="aluy-flux"
        usingFallback={false}
        customInputOpen
        customInput="Claude"
        customSuggestions={['Claude 3.5 Sonnet', 'Claude Opus']}
        customWarnOutOfCatalog
      />,
    );
    const out = plain(lastFrame() ?? '');
    // sugestões aparecem (nomes públicos do catálogo).
    expect(out).toContain('Claude 3.5 Sonnet');
    expect(out).toContain('Claude Opus');
    // aviso warn-but-allow: visível MAS deixa usar.
    expect(out).toContain('⚠');
    expect(out).toContain('fora do catálogo');
  });

  it('modo INPUT: sugestão MOSTRA o slug (id) + dica name/family (EST-0962 — /v1/models/custom)', () => {
    // A fonte do Custom agora é a lista DEDICADA por slug: a linha de sugestão traz o
    // `id` (o que se ENVIA) com a dica name/family — o que o `suggestionLine` formata.
    const { lastFrame } = wrap(
      <ModelPicker
        tiers={TIERS}
        selected={TIERS.length}
        currentTier="aluy-flux"
        usingFallback={false}
        customInputOpen
        customInput="llama"
        customSuggestions={[
          'meta-llama/llama-3.1-8b-instruct · Llama 3.1 8B Instruct · Meta',
          'meta-llama/llama-3.3-70b-instruct · Llama 3.3 70B Instruct · Meta',
        ]}
        customWarnOutOfCatalog
      />,
    );
    const out = plain(lastFrame() ?? '');
    // o SLUG (id) aparece — é o que vira `model` na chamada.
    expect(out).toContain('meta-llama/llama-3.1-8b-instruct');
    // a dica name/family acompanha.
    expect(out).toContain('Llama 3.1 8B Instruct');
    expect(out).toContain('Meta');
    // warn-but-allow visível (digitou só "llama", não um id exato).
    expect(out).toContain('⚠');
  });

  it('modo INPUT HG-2: NUNCA vaza credencial/roteamento — só nome do modelo', () => {
    const { lastFrame } = wrap(
      <ModelPicker
        tiers={TIERS}
        selected={TIERS.length}
        currentTier="aluy-flux"
        customInputOpen
        customInput="openrouter/some-model"
        customSuggestions={['Claude 3.5 Sonnet']}
        customWarnOutOfCatalog
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toMatch(/api_key|api[_-]?key|vault|base_url|bearer|sk-/i);
  });
});

// EST-0962 — render do BROWSER navegável (modo Custom com a lista carregada): janela
// de linhas com id/família/contexto/badge-tools, contador "N de M", scroll, toggle e
// o aviso warn-but-allow de não-suporte a tools. NO_COLOR: o badge degrada p/ texto
// (glifo + palavra) — por isso `plain()` (ANSI removido) ainda lê o estado.
describe('ModelPicker — BROWSER do Custom (EST-0962)', () => {
  const ROWS: readonly CustomBrowseRow[] = [
    {
      model: {
        id: 'meta-llama/llama-3.1-8b-instruct',
        name: 'Llama 3.1 8B',
        family: 'Meta',
        context: '128k',
        supportsTools: true,
      },
      highlighted: true,
    },
    {
      model: {
        id: 'ai21/jamba-large-1.7',
        name: 'Jamba',
        family: 'Ai21',
        context: '256k',
        supportsTools: false,
      },
      highlighted: false,
    },
    {
      // neutro: supportsTools ausente ⇒ badge neutro (não inventa true/false).
      model: { id: 'vendor/neutro', name: 'Neutro', family: 'Vendor', context: '' },
      highlighted: false,
    },
  ];

  function browser(extra: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
    return wrap(
      <ModelPicker
        tiers={TIERS}
        selected={TIERS.length}
        currentTier="aluy-flux"
        customInputOpen
        customBrowserAvailable
        customInput=""
        customRows={ROWS}
        customFilteredCount={3}
        customTotalCount={20}
        customHasMoreAbove={false}
        customHasMoreBelow
        customToolsOnly={false}
        customNoToolsWarning={null}
        {...extra}
      />,
    );
  }

  it('lista os modelos com id, família, contexto e BADGE de tools por linha', () => {
    const out = plain(browser().lastFrame() ?? '');
    // o id (load-bearing) aparece.
    expect(out).toContain('meta-llama/llama-3.1-8b-instruct');
    // família e contexto como dica.
    expect(out).toContain('Meta');
    expect(out).toContain('128k');
    // badge: com tools (✓ tools), sem tools (— tools), neutro (· tools?).
    expect(out).toContain('✓ tools');
    expect(out).toContain('— tools');
    expect(out).toContain('tools?');
  });

  it('mostra o contador "N de M" e a dica de teclas (↑↓/t/enter/esc)', () => {
    const out = plain(browser().lastFrame() ?? '');
    expect(out).toContain('3 de 20');
    expect(out).toContain('↑↓');
    expect(out).toContain('só-tools');
    expect(out).toContain('enter');
  });

  it('marca a linha REALÇADA com › (a11y: não só cor)', () => {
    const out = plain(browser().lastFrame() ?? '');
    expect(out).toContain('›');
  });

  it('indica SCROLL (↓ mais abaixo) quando há itens fora da janela', () => {
    const out = plain(browser({ customHasMoreAbove: true }).lastFrame() ?? '');
    expect(out).toContain('mais abaixo');
    expect(out).toContain('mais acima');
  });

  it('toggle "só com tools" LIGADO aparece no contador', () => {
    const out = plain(browser({ customToolsOnly: true }).lastFrame() ?? '');
    expect(out).toContain('só com tools');
  });

  it('AVISO warn-but-allow de não-suporte a tools quando o realce não suporta', () => {
    const out = plain(browser({ customNoToolsWarning: 'ai21/jamba-large-1.7' }).lastFrame() ?? '');
    expect(out).toContain('⚠');
    expect(out).toContain('não suporta ferramentas');
  });

  it('filtro SEM casamento (rows vazio) ⇒ dica de texto-livre, não trava', () => {
    const out = plain(
      browser({ customRows: [], customFilteredCount: 0, customHasMoreBelow: false }).lastFrame() ??
        '',
    );
    expect(out).toContain('nenhum modelo casa o filtro');
    expect(out).toContain('slug livre');
  });

  it('HG-2: o browser NUNCA vaza credencial/roteamento — só campos públicos', () => {
    const out = plain(browser().lastFrame() ?? '');
    expect(out).not.toMatch(/api_key|api[_-]?key|vault|base_url|bearer|sk-/i);
  });

  it('SNAPSHOT do browser (janela densa, estável)', () => {
    expect(plain(browser().lastFrame() ?? '')).toMatchSnapshot();
  });
});

describe('ModelPicker — passo de EFFORT conjugado (EST-1117)', () => {
  const OPTS = effortOptions();

  function effortStep(over?: Partial<React.ComponentProps<typeof ModelPicker>>) {
    return wrap(
      <ModelPicker
        tiers={TIERS}
        selected={0}
        currentTier="aluy-flux"
        effortStepOpen
        effortOptions={OPTS}
        effortSelected={0}
        {...over}
      />,
    );
  }

  it('renderiza a dica de teclas e todas as opções (manter/low/medium/high/custom)', () => {
    const out = plain(effortStep().lastFrame() ?? '');
    expect(out).toContain('esforço'); // help PT-BR
    expect(out).toContain('manter');
    expect(out).toContain('low');
    expect(out).toContain('medium');
    expect(out).toContain('high');
    expect(out).toContain('custom');
  });

  it('marca a opção SELECIONADA com › e o effort ATIVO com ●', () => {
    // currentEffort=high ⇒ a opção "high" (índice 3) leva ●; selected=1 (low) leva ›.
    const out = plain(effortStep({ effortSelected: 1, currentEffort: 'high' }).lastFrame() ?? '');
    expect(out).toContain('› '); // o selecionado
    expect(out).toContain('● '); // o ativo
  });

  it('sem effort setado ⇒ "manter" é o ATIVO (●)', () => {
    const lines = plain(effortStep({ currentEffort: undefined }).lastFrame() ?? '').split('\n');
    const keepLine = lines.find((l) => l.includes('manter')) ?? '';
    expect(keepLine).toContain('●');
  });

  it('modo CUSTOM: mostra o valor digitado e o aviso quando inválido', () => {
    const out = plain(
      effortStep({
        effortCustomOpen: true,
        effortCustomInput: 'x'.repeat(33),
        effortCustomWarn: 'too-long',
      }).lastFrame() ?? '',
    );
    expect(out).toContain('xxxx'); // o texto digitado
    expect(out).toContain('32 caracteres'); // o aviso too-long PT-BR
  });

  it('HG-2: o passo de effort NUNCA vaza credencial — só valores públicos', () => {
    const out = plain(
      effortStep({ effortCustomOpen: true, effortCustomInput: 'medium' }).lastFrame() ?? '',
    );
    expect(out).not.toMatch(/api_key|vault|base_url|bearer|sk-/i);
  });
});
