// EST-0982 (BUG P2-1) — os 4 pickers que ainda tinham strings CRUAS em pt-BR
// (ModelPicker / HistoryPicker / FilePicker / CommandPalette) renderizados nos DOIS
// idiomas. DoD: com `en` ativo cada picker mostra a chave traduzida (NÃO o pt-BR cru);
// com `pt-BR` (default) o texto atual. Espelha o approach do screens-bilingual.test.tsx
// (ThemePicker/LangPicker já cobertos lá). Também garante que as NOVAS chaves existem
// em AMBOS os catálogos (pt-BR canônico + en parcial).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { I18nProvider } from '../../src/i18n/context.js';
import { i18n as makeI18n, resolveText, type Lang } from '../../src/i18n/translate.js';
import { ptBR } from '../../src/i18n/pt-BR.js';
import { en } from '../../src/i18n/en.js';
import type { I18nKey } from '../../src/i18n/catalog.js';
import { ModelPicker } from '../../src/ui/components/ModelPicker.js';
import { HistoryPicker } from '../../src/ui/components/HistoryPicker.js';
import { FilePicker } from '../../src/ui/components/FilePicker.js';
import { CommandPalette } from '../../src/ui/components/CommandPalette.js';
import type { TierCatalogEntry } from '@aluy/cli-core';
import type { SessionSummary } from '../../src/io/index.js';
import type { FuzzyHit } from '../../src/attach/index.js';
import type { PaletteHit } from '../../src/slash/commands.js';

const ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' } as NodeJS.ProcessEnv;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');

/** Renderiza um nó sob ThemeProvider + I18nProvider no idioma dado. */
function renderInLang(node: React.ReactElement, lang: Lang): string {
  const theme = resolveTheme({ env: ENV });
  const { lastFrame } = render(
    <ThemeProvider theme={theme}>
      <I18nProvider value={makeI18n(lang)}>{node}</I18nProvider>
    </ThemeProvider>,
  );
  return plain(lastFrame());
}

// ── fixtures mínimas (só p/ disparar cada estado de texto) ────────────────────
const TIERS: readonly TierCatalogEntry[] = [
  {
    key: 'aluy-flux',
    displayName: 'Flux',
    costSignal: 'economical',
    composition: [{ name: 'GPT-4o mini', family: 'OpenAI', role: 'principal', context: '128k' }],
  },
];

const SESSIONS: readonly SessionSummary[] = [];

const HITS: readonly FuzzyHit[] = [];

const PALETTE: readonly PaletteHit[] = [];

describe('i18n · ModelPicker nos 2 idiomas (BUG P2-1)', () => {
  it('ajuda + linha CUSTOM: pt-BR (atual) e en (traduzido, sem pt cru)', () => {
    const pt = renderInLang(
      <ModelPicker tiers={TIERS} selected={0} currentTier="aluy-flux" usingFallback={false} />,
      'pt-BR',
    );
    const enOut = renderInLang(
      <ModelPicker tiers={TIERS} selected={0} currentTier="aluy-flux" usingFallback={false} />,
      'en',
    );
    expect(pt).toContain('trocar modelo');
    expect(pt).toContain('navegar/filtrar os modelos');
    expect(enOut).toContain('change model');
    expect(enOut).toContain('browse/filter the models');
    expect(enOut).not.toContain('trocar modelo');
    expect(enOut).not.toContain('navegar/filtrar');
  });

  it('estado loading: pt-BR e en', () => {
    const pt = renderInLang(
      <ModelPicker tiers={[]} selected={0} currentTier="aluy-flux" loading />,
      'pt-BR',
    );
    const enOut = renderInLang(
      <ModelPicker tiers={[]} selected={0} currentTier="aluy-flux" loading />,
      'en',
    );
    expect(pt).toContain('carregando tiers');
    expect(enOut).toContain('loading tiers');
    expect(enOut).not.toContain('carregando');
  });

  it('aviso de fallback do catálogo: pt-BR e en (NEUTRO, sem provider)', () => {
    const pt = renderInLang(
      <ModelPicker tiers={TIERS} selected={0} currentTier="aluy-flux" usingFallback={true} />,
      'pt-BR',
    );
    const enOut = renderInLang(
      <ModelPicker tiers={TIERS} selected={0} currentTier="aluy-flux" usingFallback={true} />,
      'en',
    );
    expect(pt).toContain('catálogo do broker indisponível');
    expect(enOut).toContain('broker catalog unavailable');
    expect(enOut).not.toContain('indisponível');
  });
});

describe('i18n · HistoryPicker nos 2 idiomas (BUG P2-1)', () => {
  it('ajuda + estado vazio: pt-BR e en', () => {
    const pt = renderInLang(<HistoryPicker sessions={SESSIONS} selected={0} />, 'pt-BR');
    const enOut = renderInLang(<HistoryPicker sessions={SESSIONS} selected={0} />, 'en');
    expect(pt).toContain('retomar sessão');
    expect(pt).toContain('nenhuma sessão anterior');
    expect(enOut).toContain('resume session');
    expect(enOut).toContain('no previous session');
    expect(enOut).not.toContain('retomar');
    expect(enOut).not.toContain('sessão');
  });
});

describe('i18n · FilePicker nos 2 idiomas (BUG P2-1)', () => {
  it('ajuda + estado vazio (com query interpolada): pt-BR e en', () => {
    const pt = renderInLang(<FilePicker hits={HITS} selected={0} query="zzz" />, 'pt-BR');
    const enOut = renderInLang(<FilePicker hits={HITS} selected={0} query="zzz" />, 'en');
    expect(pt).toContain('@ para anexar arquivo');
    expect(pt).toContain('nenhum arquivo casa "zzz"');
    expect(enOut).toContain('@ to attach a file');
    expect(enOut).toContain('no file matches "zzz"');
    expect(enOut).not.toContain('anexar');
    expect(enOut).not.toContain('nenhum arquivo');
  });
});

describe('i18n · CommandPalette nos 2 idiomas (BUG P2-1)', () => {
  it('ajuda + placeholder de busca: pt-BR e en', () => {
    const pt = renderInLang(<CommandPalette hits={PALETTE} selected={0} query="" />, 'pt-BR');
    const enOut = renderInLang(<CommandPalette hits={PALETTE} selected={0} query="" />, 'en');
    expect(pt).toContain('comandos');
    expect(pt).toContain('buscar comando');
    expect(enOut).toContain('commands');
    expect(enOut).toContain('search command');
    expect(enOut).not.toContain('buscar comando');
  });

  it('estado vazio (com query interpolada): pt-BR e en', () => {
    const pt = renderInLang(<CommandPalette hits={PALETTE} selected={0} query="zzz" />, 'pt-BR');
    const enOut = renderInLang(<CommandPalette hits={PALETTE} selected={0} query="zzz" />, 'en');
    expect(pt).toContain('nenhum comando casa "zzz"');
    expect(enOut).toContain('no command matches "zzz"');
    expect(enOut).not.toContain('nenhum comando');
  });
});

describe('i18n · as novas chaves picker.* existem em AMBOS os catálogos (BUG P2-1)', () => {
  const NEW_KEYS: readonly I18nKey[] = [
    'picker.model.help',
    'picker.model.loading',
    'picker.model.customLine',
    'picker.model.fallback',
    'picker.model.browseHelp',
    'picker.model.browseCount',
    'picker.model.toolsOnlySuffix',
    'picker.model.moreAbove',
    'picker.model.moreBelow',
    'picker.model.noFilterMatch',
    'picker.model.noTools',
    'picker.model.freeHelp',
    'picker.model.outOfCatalog',
    'picker.history.help',
    'picker.history.empty',
    'picker.file.help',
    'picker.file.empty',
    'picker.file.more',
    'picker.palette.help',
    'picker.palette.search',
    'picker.palette.empty',
    'picker.palette.more',
  ];

  it('cada chave resolve (não a chave crua) no pt-BR canônico E no en', () => {
    for (const key of NEW_KEYS) {
      // pt-BR é o piso de todo fallback — todas presentes (TS já garante; runtime confirma).
      expect(ptBR[key]).toBeTypeOf('string');
      expect((ptBR[key] as string).length).toBeGreaterThan(0);
      // en deve ter a tradução PRÓPRIA (não cair no fallback p/ pt-BR).
      expect(en[key]).toBeTypeOf('string');
      expect(en[key]).not.toBe(ptBR[key]);
      // e resolve em ambos (sem mostrar a string-chave nua).
      expect(resolveText('pt-BR', key)).not.toBe(key);
      expect(resolveText('en', key)).not.toBe(key);
    }
  });

  it('a interpolação {query}/{count} funciona nas chaves com params', () => {
    expect(resolveText('en', 'picker.file.empty')).toContain('{query}');
    expect(makeI18n('en').t('picker.file.empty', { query: 'foo' })).toContain('foo');
    expect(makeI18n('en').t('picker.file.more', { count: 7 })).toContain('7');
    expect(makeI18n('pt-BR').t('picker.palette.empty', { query: 'bar' })).toContain('bar');
  });
});
