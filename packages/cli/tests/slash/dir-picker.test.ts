// Modelo puro do seletor de pasta do `/add-dir`: navegação, filtro, caminho digitado, marcação
// de pastas já adicionadas e ajuste de linha.
import { describe, expect, it } from 'vitest';
import {
  backspace,
  enter,
  enterDir,
  fitLine,
  goUp,
  isAdded,
  move,
  openState,
  resolveTyped,
  right,
  rowsOf,
  startDir,
  tildify,
  typeText,
  windowRows,
  withListing,
  type DirPickerState,
} from '../../src/slash/dir-picker.js';
import type { DirEntryInfo } from '../../src/io/dir-listing.js';

const E = (name: string, base = '/w', unreadable = false): DirEntryInfo => ({
  name,
  path: `${base}/${name}`,
  unreadable,
});
const loaded = (
  entries: DirEntryInfo[],
  extra: Partial<DirPickerState> = {},
  roots: string[] = ['/w/app'],
): DirPickerState => {
  const s = openState('/w', roots, '/home/u');
  return { ...withListing(s, { path: '/w', entries, overflow: 0 }), ...extra };
};
const labels = (s: DirPickerState): string[] => rowsOf(s).map((r) => r.label);

describe('ponto de partida', () => {
  it('começa na pasta-mãe da raiz; raiz do disco começa nela mesma', () => {
    expect(startDir('/home/u/projetos/app')).toBe('/home/u/projetos');
    expect(startDir('/')).toBe('/');
  });
  it('a seleção nasce na raiz (pendingSelect)', () => {
    const s = withListing(openState('/w', ['/w/app'], undefined, 'app'), {
      path: '/w',
      entries: [E('api'), E('app'), E('web')],
      overflow: 0,
    });
    const r = rowsOf(s)[s.selected]!;
    expect(r.kind === 'dir' && r.entry.name).toBe('app');
  });
});

describe('linhas', () => {
  it('1ª linha adiciona a pasta atual com ~ na home; depois as subpastas', () => {
    const s = withListing(openState('/home/u/x', [], '/home/u'), {
      path: '/home/u/x',
      entries: [E('a', '/home/u/x')],
      overflow: 0,
    });
    expect(labels(s)).toEqual(['✓ adicionar esta pasta (~/x)', 'a/']);
  });

  it('marca ● já adicionada (raiz e filhos de raiz); a seleção nasce na 1ª pasta', () => {
    const s = loaded([E('app'), E('outra')], {}, ['/w/app']);
    const rows = rowsOf(s);
    expect(rows[1]).toMatchObject({ kind: 'dir', hint: '● já adicionada' });
    expect(rows[2]).not.toHaveProperty('hint');
    expect(isAdded('/w/app/sub', ['/w/app'])).toBe(true);
    expect(isAdded('/w/appx', ['/w/app'])).toBe(false);
    expect(s.selected).toBe(1);
  });

  it('pasta ilegível mostra (sem permissão); listagem negada mostra a linha de aviso', () => {
    expect(rowsOf(loaded([E('x', '/w', true)]))[1]).toMatchObject({ hint: '(sem permissão)' });
    const denied = withListing(openState('/w', []), {
      path: '/w',
      entries: [],
      overflow: 0,
      error: 'denied',
    });
    expect(labels(denied)).toEqual(['✓ adicionar esta pasta (/w)', '(sem permissão)']);
  });

  it('pasta vazia, carregando e excedente `… +N`', () => {
    expect(labels(loaded([]))).toContain('(sem subpastas)');
    expect(labels(openState('/w', []))).toContain('carregando…');
    const over = withListing(openState('/w', []), { path: '/w', entries: [E('a')], overflow: 12 });
    expect(labels(over).at(-1)).toBe('… +12');
  });

  it('pasta inexistente não oferece adicionar', () => {
    const s = withListing(openState('/w', []), {
      path: '/w',
      entries: [],
      overflow: 0,
      error: 'missing',
    });
    expect(rowsOf(s).some((r) => r.kind === 'add')).toBe(false);
  });

  it('listagem de outra pasta (atrasada) é ignorada', () => {
    const s = openState('/w', []);
    expect(withListing(s, { path: '/outra', entries: [E('a')], overflow: 0 })).toBe(s);
  });
});

describe('navegação', () => {
  it('move clampa nas linhas selecionáveis (info não é alvo)', () => {
    let s = loaded([E('a'), E('b')]);
    expect(s.selected).toBe(1);
    s = move(s, -5);
    expect(s.selected).toBe(0);
    s = move(s, 99);
    expect(s.selected).toBe(2);
    const vazio = loaded([]);
    expect(move(vazio, 5).selected).toBe(0);
  });

  it('enter na 1ª linha adiciona a pasta atual; numa pasta, entra', () => {
    let s = loaded([E('a')]);
    s = move(s, -1);
    expect(enter(s)).toEqual({ kind: 'add', path: '/w' });
    s = move(s, 1);
    expect(enter(s)).toEqual({ kind: 'cd', path: '/w/a' });
  });

  it('→ entra em pasta mas nunca adiciona; ← sobe e pré-seleciona a pasta de onde veio', () => {
    let s = loaded([E('a')]);
    expect(right(s)).toEqual({ kind: 'cd', path: '/w/a' });
    s = move(s, -1);
    expect(right(s)).toEqual({ kind: 'none' });
    expect(goUp(loaded([]))).toEqual({ kind: 'cd', path: '/', select: 'w' });
    expect(goUp({ ...loaded([]), cwd: '/' })).toEqual({ kind: 'none' });
  });

  it('enterDir limpa filtro e espera a listagem', () => {
    const s = enterDir(typeText(loaded([E('a')]), 'a'), '/w/a');
    expect(s).toMatchObject({ cwd: '/w/a', filter: '', loading: true });
    expect(enter(s)).toEqual({ kind: 'none' });
  });
});

describe('filtro e caminho digitado', () => {
  const base = (): DirPickerState => loaded([E('alpha'), E('beta'), E('gamma')]);

  it('digitar filtra como o menu de busca e leva a seleção ao 1º resultado', () => {
    const s = typeText(base(), 'bet');
    expect(labels(s)).toEqual(['✓ adicionar esta pasta (/w)', 'beta/']);
    expect(s.selected).toBe(1);
    expect(enter(s)).toEqual({ kind: 'cd', path: '/w/beta' });
  });

  it('sem resultado mostra aviso; backspace apaga o filtro e só então sobe', () => {
    let s = typeText(base(), 'zzz');
    expect(labels(s)).toContain('(nenhuma pasta combina com "zzz")');
    let r = backspace(s);
    expect(r.state.filter).toBe('zz');
    expect(r.effect).toEqual({ kind: 'none' });
    s = { ...base() };
    r = backspace(s);
    expect(r.effect).toEqual({ kind: 'cd', path: '/', select: 'w' });
  });

  it('texto colado perde quebras de linha', () => {
    expect(typeText(base(), 'a\nb').filter).toBe('ab');
  });

  it('caminho absoluto/relativo/~ vira linha "ir para" e Enter salta', () => {
    for (const t of ['/srv/x', '~/proj', '../irmao', './sub', '..', '~']) {
      const s = typeText(base(), t);
      expect(rowsOf(s).map((r) => r.kind)).toEqual(['add', 'jump']);
      expect(enter(s)).toEqual({ kind: 'jump', input: t });
    }
  });

  it('resolveTyped expande ~ e resolve relativo contra a pasta atual', () => {
    expect(resolveTyped('/srv/x', '/w', '/home/u')).toBe('/srv/x');
    expect(resolveTyped('~', '/w', '/home/u')).toBe('/home/u');
    expect(resolveTyped('~/p', '/w', '/home/u')).toBe('/home/u/p');
    expect(resolveTyped('../o', '/w/a', '/home/u')).toBe('/w/o');
    expect(resolveTyped('./s', '/w', undefined)).toBe('/w/s');
  });
});

describe('texto', () => {
  it('tildify', () => {
    expect(tildify('/home/u', '/home/u')).toBe('~');
    expect(tildify('/home/ux', '/home/u')).toBe('/home/ux');
  });
  it('fitLine corta em UMA linha com …, respeitando largura', () => {
    expect(fitLine('abcdef', 10)).toBe('abcdef');
    expect(fitLine('abcdefghij', 5)).toBe('abcd…');
    expect(fitLine('日本語日本語', 7)).toBe('日本語…');
    expect(fitLine('x', 0)).toBe('');
  });
  it('windowRows rola em torno da seleção', () => {
    expect(windowRows(5, 0, 10)).toEqual([0, 5]);
    expect(windowRows(100, 0, 8)).toEqual([0, 8]);
    expect(windowRows(100, 50, 8)).toEqual([46, 54]);
    expect(windowRows(100, 99, 8)).toEqual([92, 100]);
  });
});
