// Modelo PURO do seletor de pasta do `/add-dir` (sem Ink, sem disco).
//
// A App só traduz teclas em chamadas daqui e executa o `Effect` devolvido; a listagem vem de
// `io/dir-listing.ts` (assíncrona) e entra por `withListing`. Escolher uma pasta NÃO tem caminho
// próprio de efeito: o efeito `add` vira o MESMO `/add-dir <path>` digitado (validação e
// confinamento são os do `workspace.addRoot`, nada é reimplementado aqui).
//
// Onde começa: na PASTA-MÃE da raiz do workspace. A raiz e tudo dentro dela já estão
// autorizados (adicionar um filho seria no-op), então quem roda `/add-dir` quase sempre quer um
// IRMÃO (outro repo ao lado). A raiz aparece na lista marcada `● já adicionada` e a seleção
// nasce nela. Raiz `/` (yolo) ou sem pai ⇒ começa na própria raiz.

import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import stringWidth from 'string-width';
import { filterFuzzy } from '../attach/index.js';
import type { DirEntryInfo, DirListing } from '../io/dir-listing.js';

export interface DirPickerState {
  readonly cwd: string;
  readonly entries: readonly DirEntryInfo[];
  readonly overflow: number;
  readonly error?: 'denied' | 'missing';
  readonly loading: boolean;
  readonly filter: string;
  /** Índice em `rowsOf(state)`. */
  readonly selected: number;
  /** Raízes já autorizadas (canônicas). */
  readonly roots: readonly string[];
  readonly home?: string;
  /** Aviso transitório (ex.: "não existe"). */
  readonly notice?: string;
  /** Nome a pré-selecionar quando a listagem chegar. */
  readonly pendingSelect?: string;
}

export type DirRow =
  | { readonly kind: 'add'; readonly label: string; readonly path: string }
  | {
      readonly kind: 'dir';
      readonly label: string;
      readonly hint?: string;
      readonly entry: DirEntryInfo;
    }
  | { readonly kind: 'jump'; readonly label: string; readonly input: string }
  | { readonly kind: 'info'; readonly label: string };

export type DirEffect =
  | { readonly kind: 'add'; readonly path: string }
  | { readonly kind: 'cd'; readonly path: string; readonly select?: string }
  | { readonly kind: 'jump'; readonly input: string }
  | { readonly kind: 'none' };

function omit<K extends keyof DirPickerState>(s: DirPickerState, ...keys: K[]): DirPickerState {
  const out: Record<string, unknown> = { ...s };
  for (const k of keys) delete out[k];
  return out as unknown as DirPickerState;
}

/** `~` no lugar da home, só para exibir. */
export function tildify(path: string, home: string | undefined): string {
  if (home === undefined || home === '') return path;
  if (path === home) return '~';
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

export const isPathLike = (s: string): boolean =>
  s === '~' ||
  s === '.' ||
  s === '..' ||
  s.startsWith('/') ||
  s.startsWith('~/') ||
  s.startsWith('./') ||
  s.startsWith('../');

/** Texto digitado → caminho absoluto (`~` expande; relativo parte da pasta atual). PURA. */
export function resolveTyped(input: string, cwd: string, home: string | undefined): string {
  const t = input.trim();
  if (t === '~') return home ?? cwd;
  if (t.startsWith('~/') && home !== undefined) return resolve(home, t.slice(2));
  return isAbsolute(t) ? resolve(t) : resolve(cwd, t);
}

const isUnder = (p: string, root: string): boolean =>
  p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** O caminho já está autorizado (é uma raiz ou está dentro de uma)? */
export function isAdded(path: string, roots: readonly string[]): boolean {
  return roots.some((r) => isUnder(path, r));
}

export function startDir(primaryRoot: string): string {
  const parent = dirname(primaryRoot);
  return parent === primaryRoot ? primaryRoot : parent;
}

export function openState(
  start: string,
  roots: readonly string[],
  home?: string,
  select?: string,
): DirPickerState {
  return {
    cwd: start,
    entries: [],
    overflow: 0,
    loading: true,
    filter: '',
    selected: 0,
    roots,
    ...(home !== undefined ? { home } : {}),
    ...(select !== undefined ? { pendingSelect: select } : {}),
  };
}

/** Linhas visíveis, na ordem de exibição. PURA. */
export function rowsOf(s: DirPickerState): readonly DirRow[] {
  const rows: DirRow[] = [];
  if (s.error !== 'missing') {
    rows.push({
      kind: 'add',
      label: `✓ adicionar esta pasta (${tildify(s.cwd, s.home)})`,
      path: s.cwd,
    });
  }
  const f = s.filter.trim();
  if (f !== '' && isPathLike(f)) {
    rows.push({ kind: 'jump', label: `→ ir para ${f}`, input: f });
    return rows;
  }
  if (s.loading) {
    rows.push({ kind: 'info', label: 'carregando…' });
    return rows;
  }
  if (s.error === 'denied') {
    rows.push({ kind: 'info', label: '(sem permissão)' });
    return rows;
  }
  if (s.error === 'missing') {
    rows.push({ kind: 'info', label: '(pasta inexistente — ← sobe)' });
    return rows;
  }
  const shown =
    f === ''
      ? s.entries
      : (() => {
          const hits = filterFuzzy(
            f,
            s.entries.map((e) => e.name),
          );
          const byName = new Map(s.entries.map((e) => [e.name, e]));
          return hits.flatMap((h) => {
            const e = byName.get(h.path);
            return e !== undefined ? [e] : [];
          });
        })();
  for (const e of shown) {
    const hints: string[] = [];
    if (isAdded(e.path, s.roots)) hints.push('● já adicionada');
    if (e.unreadable) hints.push('(sem permissão)');
    rows.push({
      kind: 'dir',
      label: `${e.name}/`,
      ...(hints.length > 0 ? { hint: hints.join(' ') } : {}),
      entry: e,
    });
  }
  if (shown.length === 0) {
    rows.push({
      kind: 'info',
      label: f === '' ? '(sem subpastas)' : `(nenhuma pasta combina com "${f}")`,
    });
  }
  if (f === '' && s.overflow > 0) rows.push({ kind: 'info', label: `… +${s.overflow}` });
  return rows;
}

const selectableCount = (rows: readonly DirRow[]): number =>
  rows.filter((r) => r.kind !== 'info').length;

/** A listagem chegou (ignora a de outra pasta, que ficou para trás). */
export function withListing(s: DirPickerState, l: DirListing): DirPickerState {
  if (l.path !== s.cwd) return s;
  const base: DirPickerState = {
    ...s,
    entries: l.entries,
    overflow: l.overflow,
    ...(l.error !== undefined ? { error: l.error } : {}),
    loading: false,
    filter: '',
    selected: 0,
  };
  const rest = omit(base, 'error');
  const next: DirPickerState = l.error !== undefined ? base : rest;
  const rows = rowsOf(next);
  const idx =
    s.pendingSelect !== undefined
      ? rows.findIndex((r) => r.kind === 'dir' && r.entry.name === s.pendingSelect)
      : -1;
  const clean = omit(next, 'pendingSelect');
  return {
    ...clean,
    selected: idx >= 0 ? idx : rows.length > 1 && rows[1]!.kind === 'dir' ? 1 : 0,
  };
}

/** Troca de pasta: limpa filtro/aviso e espera a listagem. */
export function enterDir(s: DirPickerState, path: string, select?: string): DirPickerState {
  const rest = omit(s, 'error', 'notice', 'pendingSelect');
  return {
    ...rest,
    cwd: path,
    entries: [],
    overflow: 0,
    loading: true,
    filter: '',
    selected: 0,
    ...(select !== undefined ? { pendingSelect: select } : {}),
  };
}

export function move(s: DirPickerState, delta: number): DirPickerState {
  const max = selectableCount(rowsOf(s)) - 1;
  if (max < 0) return s;
  return { ...s, selected: Math.min(max, Math.max(0, s.selected + delta)) };
}

/** Digitar/colar: acrescenta ao filtro e leva a seleção ao 1º resultado. */
export function typeText(s: DirPickerState, text: string): DirPickerState {
  const clean = text.replace(/[\r\n\t]+/g, '');
  if (clean === '') return s;
  const next = { ...s, filter: s.filter + clean };
  const rest = omit(next, 'notice');
  const rows = rowsOf(rest);
  return { ...rest, selected: rows.length > 1 && rows[1]!.kind !== 'info' ? 1 : 0 };
}

/** Backspace: apaga um caractere do filtro; com o filtro vazio, sobe uma pasta. */
export function backspace(s: DirPickerState): { state: DirPickerState; effect: DirEffect } {
  if (s.filter !== '') {
    const rest = omit(s, 'notice');
    const next = { ...rest, filter: [...s.filter].slice(0, -1).join('') };
    const rows = rowsOf(next);
    return {
      state: {
        ...next,
        selected: next.filter !== '' && rows.length > 1 && rows[1]!.kind !== 'info' ? 1 : 0,
      },
      effect: { kind: 'none' },
    };
  }
  return { state: s, effect: goUp(s) };
}

export function goUp(s: DirPickerState): DirEffect {
  const parent = dirname(s.cwd);
  if (parent === s.cwd) return { kind: 'none' };
  return { kind: 'cd', path: parent, select: basename(s.cwd) };
}

function effectOf(row: DirRow | undefined): DirEffect {
  if (row === undefined) return { kind: 'none' };
  switch (row.kind) {
    case 'add':
      return { kind: 'add', path: row.path };
    case 'dir':
      return { kind: 'cd', path: row.entry.path };
    case 'jump':
      return { kind: 'jump', input: row.input };
    case 'info':
      return { kind: 'none' };
  }
}

/** Enter: adiciona, entra na pasta ou salta para o caminho digitado. */
export function enter(s: DirPickerState): DirEffect {
  if (s.loading) return { kind: 'none' };
  return effectOf(rowsOf(s)[s.selected]);
}

/** → : só entra em pasta (nunca adiciona às cegas). */
export function right(s: DirPickerState): DirEffect {
  if (s.loading) return { kind: 'none' };
  const row = rowsOf(s)[s.selected];
  return row?.kind === 'dir' ? effectOf(row) : { kind: 'none' };
}

/** Corta `text` para caber em `width` colunas (uma linha só), com `…`. */
export function fitLine(text: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  let out = '';
  for (const ch of text) {
    if (stringWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** Janela de `max` linhas em torno da seleção. */
export function windowRows(
  total: number,
  selected: number,
  max: number,
): readonly [number, number] {
  if (max <= 0 || total <= max) return [0, total];
  const start = Math.min(Math.max(0, selected - Math.floor(max / 2)), total - max);
  return [start, start + max];
}
