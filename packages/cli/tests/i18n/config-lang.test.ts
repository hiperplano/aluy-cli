// EST-0989 (i18n) — persistência do `lang` em `~/.aluy/config.json` (ao lado de
// theme/tier). DoD: `/lang` persiste + reabre nele; código inválido/lixo é descartado
// (fail-safe, cai na auto-detecção/default); MESMA disciplina do `theme` (validação
// contra catálogo). Sobre tmpdir injetado — nunca toca o `~/.aluy/` real.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserConfigStore, configuredLang } from '../../src/io/user-config.js';

describe('UserConfigStore — preferência de IDIOMA (lang)', () => {
  let base: string;
  let aluyDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-lang-'));
    aluyDir = join(base, '.aluy');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('saveLang persiste e relê o código (round-trip)', () => {
    const store = new UserConfigStore({ baseDir: aluyDir });
    expect(store.saveLang('en')).toBe(true);
    expect(store.load().lang).toBe('en');
    expect(configuredLang(store.load())).toBe('en');
  });

  it('config AUSENTE ⇒ lang undefined (cai no auto-detect/default no caller)', () => {
    const store = new UserConfigStore({ baseDir: aluyDir });
    expect(store.load().lang).toBeUndefined();
    expect(configuredLang(store.load())).toBeUndefined();
  });

  it('preserva theme/tier ao salvar só o lang (merge, não sobrescreve)', () => {
    const store = new UserConfigStore({ baseDir: aluyDir });
    store.saveTheme('aluy-light');
    store.saveTier('aluy-granito');
    store.saveLang('en');
    const cfg = store.load();
    expect(cfg.lang).toBe('en');
    expect(cfg.theme).toBe('aluy-light');
    expect(cfg.tier).toBe('aluy-granito');
  });

  it('código de idioma DESCONHECIDO no disco é DESCARTADO (sanitize, sem crash)', () => {
    mkdirSync(aluyDir, { recursive: true });
    writeFileSync(join(aluyDir, 'config.json'), JSON.stringify({ lang: 'klingon' }), 'utf8');
    const store = new UserConfigStore({ baseDir: aluyDir });
    expect(store.load().lang).toBeUndefined();
  });

  it('lang válido sobrevive a um config com OUTROS campos inválidos (campo a campo)', () => {
    mkdirSync(aluyDir, { recursive: true });
    writeFileSync(
      join(aluyDir, 'config.json'),
      JSON.stringify({ lang: 'en', theme: 'inexistente' }),
      'utf8',
    );
    const store = new UserConfigStore({ baseDir: aluyDir });
    const cfg = store.load();
    expect(cfg.lang).toBe('en'); // válido sobrevive
    expect(cfg.theme).toBeUndefined(); // inválido descartado
  });

  it('config CORROMPIDO (JSON inválido) ⇒ defaults, sem lançar', () => {
    mkdirSync(aluyDir, { recursive: true });
    writeFileSync(join(aluyDir, 'config.json'), '{ lang: ', 'utf8');
    const store = new UserConfigStore({ baseDir: aluyDir });
    expect(() => store.load()).not.toThrow();
    expect(store.load().lang).toBeUndefined();
  });
});
