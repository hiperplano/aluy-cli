// Modos de notificação (tudo | atencao | nada): porta, env > config > default e
// persistência em ~/.aluy/config.json.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalNotificationPort, loadNotifyConfig } from '../../src/io/notify-port.js';
import { UserConfigStore, CONFIG_FILENAME } from '../../src/io/user-config.js';

function emitted(mode: 'tudo' | 'atencao' | 'nada') {
  const out: string[] = [];
  const port = new TerminalNotificationPort({ write: (s) => out.push(s), isTty: true, mode });
  port.notify('attention');
  const attention = out.length > 0;
  out.length = 0;
  port.notify('done');
  return { attention, done: out.length > 0 };
}

describe('porta — modos', () => {
  it('tudo ⇒ attention + done', () => {
    expect(emitted('tudo')).toEqual({ attention: true, done: true });
  });
  it('atencao ⇒ só attention', () => {
    expect(emitted('atencao')).toEqual({ attention: true, done: false });
  });
  it('nada ⇒ nenhum', () => {
    expect(emitted('nada')).toEqual({ attention: false, done: false });
  });
  it('setMode em runtime; setEnabled legado mapeia tudo/nada', () => {
    const port = new TerminalNotificationPort({ write: () => {}, isTty: true });
    port.setMode('atencao');
    expect(port.mode).toBe('atencao');
    port.setEnabled(false);
    expect(port.mode).toBe('nada');
    port.setEnabled(true);
    expect(port.mode).toBe('tudo');
  });
  it('enabled:false legado ⇒ nada', () => {
    const port = new TerminalNotificationPort({ write: () => {}, isTty: true, enabled: false });
    expect(port.mode).toBe('nada');
  });
});

describe('loadNotifyConfig — env > config > default', () => {
  it('default tudo; config vale sem env', () => {
    expect(loadNotifyConfig({}).mode).toBe('tudo');
    expect(loadNotifyConfig({}, 'atencao').mode).toBe('atencao');
  });
  it('env vence a config; aceita 3 modos e legados', () => {
    expect(loadNotifyConfig({ ALUY_NOTIFY: 'nada' }, 'tudo').mode).toBe('nada');
    expect(loadNotifyConfig({ ALUY_NOTIFY: 'atencao' }, 'tudo').mode).toBe('atencao');
    expect(loadNotifyConfig({ ALUY_NOTIFY: 'off' }, 'tudo').mode).toBe('nada');
    expect(loadNotifyConfig({ ALUY_NOTIFY: '1' }, 'nada').mode).toBe('tudo');
  });
  it('env inválido cai na config', () => {
    expect(loadNotifyConfig({ ALUY_NOTIFY: 'xx' }, 'atencao').mode).toBe('atencao');
  });
});

describe('config.notify — persistência', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-notify-cfg-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('round-trip dos 3 modos', () => {
    for (const m of ['tudo', 'atencao', 'nada'] as const) {
      expect(new UserConfigStore({ baseDir: base }).saveNotify(m)).toBe(true);
      expect(new UserConfigStore({ baseDir: base }).load().notify).toBe(m);
    }
  });
  it('preserva outras prefs (merge)', () => {
    const s = new UserConfigStore({ baseDir: base });
    s.saveSuggestions(false);
    s.saveNotify('nada');
    const c = new UserConfigStore({ baseDir: base }).load();
    expect(c.suggestions).toBe(false);
    expect(c.notify).toBe('nada');
  });
  it('lixo é descartado', () => {
    writeFileSync(join(base, CONFIG_FILENAME), JSON.stringify({ notify: 42 }));
    expect(new UserConfigStore({ baseDir: base }).load().notify).toBeUndefined();
    writeFileSync(join(base, CONFIG_FILENAME), JSON.stringify({ notify: 'xyz' }));
    expect(new UserConfigStore({ baseDir: base }).load().notify).toBeUndefined();
  });
});
