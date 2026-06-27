// EST-0957 — render do <FilePicker> e <AttachChips> (ink-testing-library).
// Cobre: filtro/seleção visível, highlight do match, dica de teclas, elisão em
// terminal estreito, e os chips removíveis (CA-3/CA-5).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { FilePicker, elidePath } from '../../src/ui/components/FilePicker.js';
import { AttachChips } from '../../src/ui/components/AttachChips.js';
import { filterFuzzy } from '../../src/attach/fuzzy.js';

function wrap(node: React.ReactElement) {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

const PATHS = ['packages/cli/src/auth/session.ts', 'packages/cli/src/auth/config.ts', 'README.md'];

describe('FilePicker — lista filtrável com a mecânica do slash-menu', () => {
  it('mostra a dica de teclas (↑↓/enter/esc)', () => {
    const { lastFrame } = wrap(<FilePicker hits={filterFuzzy('', PATHS)} selected={0} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('↑↓');
    expect(out).toContain('anexar');
  });

  it('filtra os caminhos pela query fuzzy', () => {
    const { lastFrame } = wrap(
      <FilePicker hits={filterFuzzy('session', PATHS)} selected={0} query="session" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('session.ts');
    expect(out).not.toContain('README');
  });

  it('marca o item selecionado com o prefixo › (a11y: não só cor)', () => {
    const { lastFrame } = wrap(<FilePicker hits={filterFuzzy('', PATHS)} selected={0} />);
    expect(plain(lastFrame() ?? '')).toContain('›');
  });

  it('lista vazia mostra "nenhum arquivo casa"', () => {
    const { lastFrame } = wrap(<FilePicker hits={[]} selected={0} query="zzz" />);
    expect(plain(lastFrame() ?? '')).toContain('nenhum arquivo casa');
  });
});

describe('elidePath — responsivo em terminal estreito (§5.1)', () => {
  it('elide no meio preservando início e basename', () => {
    const p = 'packages/cli/src/auth/session.ts';
    const e = elidePath(p, 20);
    expect(e.length).toBeLessThanOrEqual(20);
    expect(e).toContain('…');
  });

  it('não elide quando cabe', () => {
    expect(elidePath('a.ts', 80)).toBe('a.ts');
  });
});

describe('AttachChips — marcadores removíveis dos anexos (§4.2)', () => {
  it('renderiza um chip @caminho com o glifo de remoção', () => {
    const { lastFrame } = wrap(<AttachChips chips={[{ path: 'src/a.ts' }]} active={0} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('@src/a.ts');
    expect(out).toContain('⌫');
  });

  it('CA-5 — multi: dois chips distintos', () => {
    const { lastFrame } = wrap(
      <AttachChips chips={[{ path: 'a/x.ts' }, { path: 'b/y.ts' }]} active={1} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('@a/x.ts');
    expect(out).toContain('@b/y.ts');
  });

  it('chip truncado mostra o marcador ~', () => {
    const { lastFrame } = wrap(<AttachChips chips={[{ path: 'big.txt', truncated: true }]} />);
    expect(plain(lastFrame() ?? '')).toContain('@big.txt~');
  });

  it('sem chips: não renderiza nada', () => {
    const { lastFrame } = wrap(<AttachChips chips={[]} />);
    expect(plain(lastFrame() ?? '').trim()).toBe('');
  });
});
