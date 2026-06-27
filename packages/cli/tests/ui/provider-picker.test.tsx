// EST-0962 · /provider — render do <ProviderPicker> (ink-testing-library): lista
// openrouter+deepseek, marcador do ativo (●) e do selecionado (›), a dica de teclas, e
// a dica "padrão" no provider default. Espelha o theme-picker. HG-2: nunca credencial.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveThemeByName } from '../../src/ui/theme/themes.js';
import { ProviderPicker } from '../../src/ui/components/ProviderPicker.js';
import { PROVIDERS } from '../../src/model/providers.js';

const TRUE_ENV = { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

function wrap(node: React.ReactElement, themeName = 'aluy-dark') {
  const theme = resolveThemeByName(themeName, { env: TRUE_ENV });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

describe('ProviderPicker — seletor de provider', () => {
  it('mostra a dica de teclas (↑↓/enter/esc) e o verbo "setar"', () => {
    const { lastFrame } = wrap(<ProviderPicker providers={PROVIDERS} selected={0} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('↑↓');
    expect(out).toContain('setar');
  });

  it('lista openrouter + deepseek com rótulo e resumo (PT-BR)', () => {
    const { lastFrame } = wrap(<ProviderPicker providers={PROVIDERS} selected={0} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('OpenRouter');
    expect(out).toContain('DeepSeek');
    expect(out).toContain('padrão'); // dica do default (openrouter)
  });

  it('marca o provider ATIVO com ● e o selecionado com › (a11y: não só cor)', () => {
    const { lastFrame } = wrap(
      <ProviderPicker providers={PROVIDERS} selected={0} currentProvider="deepseek" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('●'); // ativo (deepseek)
    expect(out).toContain('›'); // selecionado (openrouter, índice 0)
  });

  it('mostra a nota de FALLBACK honesta quando usingFallback=true (ADR-0076)', () => {
    const { lastFrame } = wrap(
      <ProviderPicker providers={PROVIDERS} selected={0} usingFallback={true} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('não foi possível listar os cadastrados');
  });

  it('NÃO mostra a nota de fallback quando veio do broker (usingFallback=false)', () => {
    const { lastFrame } = wrap(
      <ProviderPicker providers={PROVIDERS} selected={0} usingFallback={false} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('não foi possível listar');
  });

  it('NUNCA renderiza credencial/base_url (HG-2/CLI-SEC-7)', () => {
    const out = plain(
      wrap(
        <ProviderPicker providers={PROVIDERS} selected={0} currentProvider="openrouter" />,
      ).lastFrame() ?? '',
    ).toLowerCase();
    expect(out).not.toContain('api_key');
    expect(out).not.toContain('base_url');
    expect(out).not.toContain('http');
  });
});

// F88 (anti-flicker, Windows) — a lista do broker é ABERTA (pode trazer providers além do
// seed openrouter/deepseek). Sem teto, num terminal curto a lista + chrome estouraria
// `rows` ⇒ o Ink cairia no caminho full-screen (clearTerminal/frame) ⇒ flicker no Windows.
describe('ProviderPicker — janelamento (lista aberta do broker)', () => {
  const MANY = Array.from({ length: 30 }, (_, i) => ({
    name: `prov-${i}`,
    label: `Prov-num-${i}`,
    summary: `summary ${i}`,
    isDefault: false,
  }));
  const rowLines = (out: string): number =>
    out.split('\n').filter((l) => /Prov-num-\d+/.test(l)).length;

  it('JANELA a `maxRows` (não despeja 30 providers) + indicador de resto', () => {
    const { lastFrame } = wrap(<ProviderPicker providers={MANY} selected={0} maxRows={8} />);
    const out = plain(lastFrame() ?? '');
    expect(rowLines(out)).toBe(8);
    expect(out).toContain('22'); // 30 − 8 = 22 a mais.
    expect(out).toContain('a mais');
  });

  it('a janela CENTRA no selecionado (mesmo no fim da lista)', () => {
    const { lastFrame } = wrap(<ProviderPicker providers={MANY} selected={29} maxRows={8} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Prov-num-29');
    expect(rowLines(out)).toBe(8);
  });

  it('default seguro: SEM `maxRows`, ainda janela (teto interno 10)', () => {
    const { lastFrame } = wrap(<ProviderPicker providers={MANY} selected={0} />);
    const out = plain(lastFrame() ?? '');
    expect(rowLines(out)).toBeLessThanOrEqual(10);
    expect(out).toContain('a mais');
  });

  it('seed pequeno (2) ⇒ mostra tudo, sem indicador de resto', () => {
    const { lastFrame } = wrap(<ProviderPicker providers={PROVIDERS} selected={0} maxRows={10} />);
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('a mais');
  });
});
