// EST-0972 (rename) — o /history mostra o RÓTULO (com o ● colorido) quando houver,
// em vez do `data · cwd · 1ª-msg`. Sem rótulo ⇒ cai no formato antigo (#86 intacto).
//
// DoD:
//   - formatHistoryEntry COM label ⇒ `<nome> · data · cwd` (o nome é o rosto);
//   - formatHistoryEntry SEM label ⇒ formato antigo (`data · cwd · 1ª-msg`);
//   - o <HistoryPicker> desenha um ● colorido (paleta do DS) na sessão com rótulo;
//   - sessão sem rótulo ⇒ sem ● (não regride o #86).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { HistoryPicker } from '../../src/ui/components/HistoryPicker.js';
import { formatHistoryEntry } from '../../src/session/history.js';
import type { SessionSummary } from '../../src/io/index.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

function wrap(
  node: React.ReactElement,
  env: NodeJS.ProcessEnv = {
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  },
) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

describe('formatHistoryEntry — rótulo vs formato antigo', () => {
  it('COM rótulo ⇒ `<nome> · data · cwd` (o nome é o rosto do item)', () => {
    const line = formatHistoryEntry(
      { cwd: '/home/dev/proj', updatedAt: 0, title: '1ª msg ignorada', label: 'projeto-x' },
      '/home/dev',
    );
    expect(line.startsWith('projeto-x · ')).toBe(true);
    expect(line).toContain('~/proj');
    // com rótulo, a 1ª mensagem NÃO é o rosto (o nome assume).
    expect(line).not.toContain('1ª msg ignorada');
  });

  it('SEM rótulo ⇒ formato antigo `data · cwd · 1ª-msg` (#86 intacto)', () => {
    const line = formatHistoryEntry(
      { cwd: '/home/dev/proj', updatedAt: 0, title: 'corrija o bug' },
      '/home/dev',
    );
    expect(line).toContain('~/proj');
    expect(line).toContain('corrija o bug');
    expect(line).not.toContain('●');
  });
});

describe('HistoryPicker — ● colorido no rótulo', () => {
  const labeled: SessionSummary = {
    id: 's-labeled',
    createdAt: 1,
    updatedAt: 2,
    cwd: '/home/dev/proj',
    tier: 't',
    label: 'projeto-x',
    labelColor: 'azul',
    blockCount: 3,
    title: '1ª msg',
  };
  const plainSess: SessionSummary = {
    id: 's-plain',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/home/dev/outro',
    tier: 't',
    blockCount: 2,
    title: 'corrija o bug',
  };

  it('sessão COM rótulo ⇒ mostra ● + nome', () => {
    const { lastFrame } = wrap(
      <HistoryPicker sessions={[labeled]} selected={0} home="/home/dev" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('●');
    expect(out).toContain('projeto-x');
  });

  it('o ● da sessão rotulada carrega SGR de cor (paleta do DS, truecolor)', () => {
    const { lastFrame } = wrap(
      <HistoryPicker sessions={[labeled]} selected={0} home="/home/dev" />,
    );
    expect(lastFrame() ?? '').toMatch(new RegExp(ESC + '\\[[0-9;]*38;2;'));
  });

  it('sessão SEM rótulo ⇒ SEM ● (formato antigo, #86)', () => {
    const { lastFrame } = wrap(
      <HistoryPicker sessions={[plainSess]} selected={0} home="/home/dev" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('●');
    expect(out).toContain('corrija o bug');
  });

  it('mista: a rotulada tem ●, a sem-rótulo não', () => {
    const { lastFrame } = wrap(
      <HistoryPicker sessions={[labeled, plainSess]} selected={0} home="/home/dev" />,
    );
    const out = plain(lastFrame() ?? '');
    // exatamente UM ● (só a rotulada).
    expect((out.match(/●/g) ?? []).length).toBe(1);
  });
});
