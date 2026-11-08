// <DirPicker> (altura/largura) e useDirPicker (fluxo assíncrono: entrar, subir, saltar, adicionar).
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { DirPicker } from '../../src/ui/components/DirPicker.js';
import {
  useDirPicker,
  type DirPickerController,
  type DirPickerPorts,
} from '../../src/ui/hooks/useDirPicker.js';
import { openState, withListing } from '../../src/slash/dir-picker.js';
import type { DirListing } from '../../src/io/dir-listing.js';
import type { SlashCommand } from '../../src/slash/commands.js';

const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' } });
const strip = (s: string): string =>
  s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('<DirPicker>', () => {
  it('cabe no orçamento: altura limitada, cada linha numa linha só, rola com a seleção', () => {
    const entries = Array.from({ length: 80 }, (_, i) => ({
      name: `pasta-com-nome-bem-comprido-${i}`,
      path: `/w/pasta-com-nome-bem-comprido-${i}`,
      unreadable: false,
    }));
    let state = withListing(openState('/w', []), { path: '/w', entries, overflow: 30 });
    state = { ...state, selected: 40 };
    const cols = 40;
    const { lastFrame } = render(
      <ThemeProvider theme={theme}>
        <DirPicker state={state} columns={cols} maxRows={8} />
      </ThemeProvider>,
    );
    const lines = strip(lastFrame() ?? '').split('\n');
    // borda 2 + título + filtro + 2 marcadores + (maxRows-1) itens
    expect(lines.length).toBeLessThanOrEqual(2 + 1 + 1 + 2 + 7);
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(cols - 1);
    const text = lines.join('\n');
    expect(text).toContain('pasta-com-nome-bem-comprido-40'.slice(0, 20));
    expect(text).toMatch(/↑ \d+ acima/);
    expect(text).toMatch(/↓ \d+ mais/);
    expect(text).toContain('›');
  });

  it('mostra o aviso de sem permissão', () => {
    const state = withListing(openState('/w', []), {
      path: '/w',
      entries: [],
      overflow: 0,
      error: 'denied',
    });
    const { lastFrame } = render(
      <ThemeProvider theme={theme}>
        <DirPicker state={state} columns={80} maxRows={8} />
      </ThemeProvider>,
    );
    expect(strip(lastFrame() ?? '')).toContain('(sem permissão)');
  });
});

describe('useDirPicker', () => {
  const tree: Record<string, string[]> = { '/': ['w'], '/w': ['app', 'lib'], '/w/lib': ['x'] };
  const calls: string[] = [];
  const ports: DirPickerPorts = {
    list: async (dir): Promise<DirListing> => {
      calls.push(dir);
      const kids = tree[dir];
      if (kids === undefined) return { path: dir, entries: [], overflow: 0, error: 'missing' };
      return {
        path: dir,
        overflow: 0,
        entries: kids.map((n) => ({
          name: n,
          path: `${dir === '/' ? '' : dir}/${n}`,
          unreadable: false,
        })),
      };
    },
    resolve: async (t) => (tree[t] !== undefined ? t : null),
  };
  const cmd = { id: 'add-dir', name: 'add-dir' } as unknown as SlashCommand;

  function mount(): { ctl: () => DirPickerController } {
    let c!: DirPickerController;
    function H(): null {
      c = useDirPicker(ports);
      return null;
    }
    render(<H />);
    return { ctl: () => c };
  }

  it('abre na pasta-mãe da raiz com a raiz selecionada; navega, sobe, filtra, salta e adiciona', async () => {
    const { ctl } = mount();
    ctl().openFor(cmd, ['/w/app'], '/home/u');
    await tick();
    expect(ctl().state?.cwd).toBe('/w');
    expect(ctl().state?.selected).toBe(1); // app
    ctl().move(1); // lib
    ctl().right();
    await tick();
    expect(ctl().state?.cwd).toBe('/w/lib');
    ctl().left();
    await tick();
    expect(ctl().state?.cwd).toBe('/w');
    expect(ctl().state?.selected).toBe(2); // voltou em lib
    ctl().type('ap');
    expect(ctl().state?.filter).toBe('ap');
    ctl().backspace();
    ctl().backspace();
    ctl().type('/w/lib');
    expect(ctl().enter()).toBeNull();
    await tick();
    expect(ctl().state?.cwd).toBe('/w/lib');
    ctl().type('/nao/existe');
    ctl().enter();
    await tick();
    expect(ctl().state?.notice).toBe('não existe: /nao/existe');
    expect(ctl().state?.cwd).toBe('/w/lib');
    // adiciona a pasta atual
    for (let i = 0; i < '/nao/existe'.length; i++) ctl().backspace();
    expect(ctl().state?.filter).toBe('');
    expect(ctl().state?.cwd).toBe('/w/lib');
    ctl().move(-9);
    const pick = ctl().enter();
    expect(pick?.path).toBe('/w/lib');
    expect(pick?.command).toBe(cmd);
    expect(ctl().open).toBe(false);
  });

  it('esc fecha e uma listagem atrasada não reabre', async () => {
    const { ctl } = mount();
    ctl().openFor(cmd, ['/w/app']);
    ctl().close();
    await tick();
    expect(ctl().open).toBe(false);
  });
});
