// F197 — pref `ui.suggestions` (sugestão de próximo prompt): persiste/saneia, e a
// PRECEDÊNCIA env(`ALUY_SUGGESTIONS`) > pref > default(ON). Sobre tmpdir (nunca toca o
// `~/.aluy/` real). Diferente do split/fullscreen, o DEFAULT aqui é LIGADO.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UserConfigStore,
  resolveInitialSuggestions,
  CONFIG_FILENAME,
} from '../../src/io/user-config.js';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aluy-suggest-cfg-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('ui.suggestions — persistência + saneamento', () => {
  it('saveSuggestions(false) grava e relê (desligado)', () => {
    const store = new UserConfigStore({ baseDir: base });
    expect(store.saveSuggestions(false)).toBe(true);
    expect(new UserConfigStore({ baseDir: base }).load().suggestions).toBe(false);
  });

  it('preserva tier ao salvar suggestions (merge)', () => {
    const store = new UserConfigStore({ baseDir: base });
    store.saveTier('aluy-granito');
    store.saveSuggestions(false);
    const cfg = store.load();
    expect(cfg.suggestions).toBe(false);
    expect(cfg.tier).toBe('aluy-granito');
  });

  it('valor não-boolean adulterado é DESCARTADO (fail-safe)', () => {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, CONFIG_FILENAME), JSON.stringify({ suggestions: 'sim' }));
    expect(new UserConfigStore({ baseDir: base }).load().suggestions).toBeUndefined();
  });
});

describe('resolveInitialSuggestions — precedência env > pref > default(ON)', () => {
  it('default é LIGADO (true) sem env e sem pref', () => {
    expect(resolveInitialSuggestions({}, {})).toBe(true);
  });

  it('a pref vale quando não há env', () => {
    expect(resolveInitialSuggestions({ suggestions: false }, {})).toBe(false);
    expect(resolveInitialSuggestions({ suggestions: true }, {})).toBe(true);
  });

  it('ALUY_SUGGESTIONS=0/off/false DESLIGA (vence a pref)', () => {
    for (const v of ['0', 'off', 'false', 'no']) {
      expect(resolveInitialSuggestions({ suggestions: true }, { ALUY_SUGGESTIONS: v })).toBe(false);
    }
  });

  it('ALUY_SUGGESTIONS=1/on/true LIGA (vence a pref)', () => {
    for (const v of ['1', 'on', 'true', 'yes']) {
      expect(resolveInitialSuggestions({ suggestions: false }, { ALUY_SUGGESTIONS: v })).toBe(true);
    }
  });

  it('env vazio/lixo ⇒ cai na pref/default (não força nada)', () => {
    expect(resolveInitialSuggestions({ suggestions: false }, { ALUY_SUGGESTIONS: '' })).toBe(false);
    expect(resolveInitialSuggestions({}, { ALUY_SUGGESTIONS: 'talvez' })).toBe(true);
  });
});
