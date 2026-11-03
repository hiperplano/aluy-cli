// Modos de notificação (all | attention | off): porta, env > config > default e
// persistência em ~/.aluy/config.json.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TerminalNotificationPort,
  loadNotifyConfig,
  modeAllows,
  parseNotifyMode,
} from '../../src/io/notify-port.js';
import { UserConfigStore, CONFIG_FILENAME } from '../../src/io/user-config.js';

function emitted(mode: 'all' | 'attention' | 'off') {
  const out: string[] = [];
  const port = new TerminalNotificationPort({ write: (s) => out.push(s), isTty: true, mode });
  port.notify('attention');
  const attention = out.length > 0;
  out.length = 0;
  port.notify('done');
  return { attention, done: out.length > 0 };
}

describe('porta — modos', () => {
  it('all ⇒ attention + done', () => {
    expect(emitted('all')).toEqual({ attention: true, done: true });
  });
  it('attention ⇒ só attention', () => {
    expect(emitted('attention')).toEqual({ attention: true, done: false });
  });
  it('off ⇒ nenhum', () => {
    expect(emitted('off')).toEqual({ attention: false, done: false });
  });
  it('setMode em runtime; setEnabled legado mapeia tudo/off', () => {
    const port = new TerminalNotificationPort({ write: () => {}, isTty: true });
    port.setMode('attention');
    expect(port.mode).toBe('attention');
    port.setEnabled(false);
    expect(port.mode).toBe('off');
    port.setEnabled(true);
    expect(port.mode).toBe('all');
  });
  it('enabled:false legado ⇒ off', () => {
    const port = new TerminalNotificationPort({ write: () => {}, isTty: true, enabled: false });
    expect(port.mode).toBe('off');
  });
});

describe('loadNotifyConfig — env > config > default', () => {
  it('default tudo; config vale sem env', () => {
    expect(loadNotifyConfig({}).mode).toBe('all');
    expect(loadNotifyConfig({}, 'attention').mode).toBe('attention');
  });
  it('env vence a config; aceita 3 modos e legados', () => {
    expect(loadNotifyConfig({ ALUY_NOTIFY: 'off' }, 'all').mode).toBe('off');
    expect(loadNotifyConfig({ ALUY_NOTIFY: 'attention' }, 'all').mode).toBe('attention');
    expect(loadNotifyConfig({ ALUY_NOTIFY: 'off' }, 'all').mode).toBe('off');
    expect(loadNotifyConfig({ ALUY_NOTIFY: '1' }, 'off').mode).toBe('all');
  });
  it('env inválido cai na config', () => {
    expect(loadNotifyConfig({ ALUY_NOTIFY: 'xx' }, 'attention').mode).toBe('attention');
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
    for (const m of ['all', 'attention', 'off'] as const) {
      expect(new UserConfigStore({ baseDir: base }).saveNotify(m)).toBe(true);
      expect(new UserConfigStore({ baseDir: base }).load().notify).toBe(m);
    }
  });
  it('preserva outras prefs (merge)', () => {
    const s = new UserConfigStore({ baseDir: base });
    s.saveSuggestions(false);
    s.saveNotify('off');
    const c = new UserConfigStore({ baseDir: base }).load();
    expect(c.suggestions).toBe(false);
    expect(c.notify).toBe('off');
  });
  it('config legada em PT (tudo|atencao|nada) é lida como all|attention|off', () => {
    for (const [antigo, novo] of [
      ['tudo', 'all'],
      ['atencao', 'attention'],
      ['nada', 'off'],
    ] as const) {
      writeFileSync(join(base, CONFIG_FILENAME), JSON.stringify({ notify: antigo }));
      expect(new UserConfigStore({ baseDir: base }).load().notify).toBe(novo);
    }
  });
  it('lixo é descartado', () => {
    writeFileSync(join(base, CONFIG_FILENAME), JSON.stringify({ notify: 42 }));
    expect(new UserConfigStore({ baseDir: base }).load().notify).toBeUndefined();
    writeFileSync(join(base, CONFIG_FILENAME), JSON.stringify({ notify: 'xyz' }));
    expect(new UserConfigStore({ baseDir: base }).load().notify).toBeUndefined();
  });
});

describe('modeAllows — motivo × modo', () => {
  it('all: attention + done; attention: só attention; off: nenhum', () => {
    expect(modeAllows('all', 'attention')).toBe(true);
    expect(modeAllows('all', 'done')).toBe(true);
    expect(modeAllows('attention', 'attention')).toBe(true);
    expect(modeAllows('attention', 'done')).toBe(false);
    expect(modeAllows('off', 'attention')).toBe(false);
    expect(modeAllows('off', 'done')).toBe(false);
  });
});

describe('parseNotifyMode — inglês, legados truthy/falsey e PT antigo', () => {
  it('mapeia tudo', () => {
    const casos: Array<[string, string | undefined]> = [
      ['all', 'all'],
      ['attention', 'attention'],
      ['off', 'off'],
      ['on', 'all'],
      ['1', 'all'],
      ['true', 'all'],
      ['0', 'off'],
      ['false', 'off'],
      ['no', 'off'],
      ['tudo', 'all'],
      ['atencao', 'attention'],
      ['atenção', 'attention'],
      ['nada', 'off'],
      ['xx', undefined],
      ['', undefined],
    ];
    for (const [i, o] of casos) expect(parseNotifyMode(i)).toBe(o);
    expect(parseNotifyMode(undefined)).toBeUndefined();
  });
});
