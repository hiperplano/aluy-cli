// EST-1000 · ADR-0076 §1 — pref `ui.fullscreen` (modo cockpit): persiste/saneia, e a
// PRECEDÊNCIA flag(`--fullscreen`) > pref > default(INLINE). Sobre tmpdir (nunca toca o
// `~/.aluy/` real). INLINE é o DEFAULT do ADR.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UserConfigStore,
  resolveInitialFullscreen,
  CONFIG_FILENAME,
} from '../../src/io/user-config.js';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aluy-cockpit-cfg-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('ui.fullscreen — persistência + saneamento', () => {
  it('saveFullscreen(true) grava e relê', () => {
    const store = new UserConfigStore({ baseDir: base });
    expect(store.saveFullscreen(true)).toBe(true);
    expect(new UserConfigStore({ baseDir: base }).load().fullscreen).toBe(true);
  });

  it('saveFullscreen(false) grava false (volta ao inline)', () => {
    const store = new UserConfigStore({ baseDir: base });
    store.saveFullscreen(true);
    store.saveFullscreen(false);
    expect(store.load().fullscreen).toBe(false);
  });

  it('preserva tema/tier ao salvar fullscreen (merge)', () => {
    const store = new UserConfigStore({ baseDir: base });
    store.saveTier('aluy-granito');
    store.saveFullscreen(true);
    const cfg = store.load();
    expect(cfg.fullscreen).toBe(true);
    expect(cfg.tier).toBe('aluy-granito');
  });

  it('valor não-boolean num arquivo adulterado é DESCARTADO (fail-safe)', () => {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, CONFIG_FILENAME), JSON.stringify({ fullscreen: 'sim' }));
    expect(new UserConfigStore({ baseDir: base }).load().fullscreen).toBeUndefined();
  });
});

describe('resolveInitialFullscreen — precedência flag > pref > default(INLINE)', () => {
  it('default é INLINE (false) sem flag e sem pref', () => {
    expect(resolveInitialFullscreen(undefined, {})).toBe(false);
  });

  it('a flag --fullscreen vence (liga)', () => {
    expect(resolveInitialFullscreen(true, { fullscreen: false })).toBe(true);
  });

  it('a pref vale quando a flag não veio', () => {
    expect(resolveInitialFullscreen(undefined, { fullscreen: true })).toBe(true);
  });
});
