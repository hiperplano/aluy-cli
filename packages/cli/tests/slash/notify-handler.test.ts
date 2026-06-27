// EST-0963 — o `/notify on|off|toggle` resolve o novo estado do sino + nota neutra.

import { describe, expect, it } from 'vitest';
import { buildNotifyEffect } from '../../src/slash/handlers.js';

describe('buildNotifyEffect — toggle do sino', () => {
  it('`on` ⇒ liga', () => {
    const e = buildNotifyEffect('on', { enabled: false, tty: true });
    expect(e.kind).toBe('notify');
    if (e.kind === 'notify') expect(e.enable).toBe(true);
  });

  it('`off` ⇒ desliga', () => {
    const e = buildNotifyEffect('off', { enabled: true, tty: true });
    if (e.kind === 'notify') expect(e.enable).toBe(false);
  });

  it('sem arg ⇒ TOGGLE (inverte o estado atual)', () => {
    const on = buildNotifyEffect('', { enabled: false, tty: true });
    const off = buildNotifyEffect('', { enabled: true, tty: true });
    if (on.kind === 'notify') expect(on.enable).toBe(true);
    if (off.kind === 'notify') expect(off.enable).toBe(false);
  });

  it('a nota é NEUTRA (status + o que faz), nunca conteúdo/segredo', () => {
    const e = buildNotifyEffect('on', { enabled: false, tty: true });
    if (e.kind === 'notify') {
      const joined = e.note.lines.join('\n').toLowerCase();
      expect(joined).toContain('ligado');
      expect(joined).toContain('aprovação');
    }
  });

  it('sem TTY ⇒ avisa que o sino não soa ali (preferência ainda registrada)', () => {
    const e = buildNotifyEffect('on', { enabled: false, tty: false });
    if (e.kind === 'notify') {
      expect(e.enable).toBe(true); // a preferência é registrada
      expect(e.note.lines.join('\n').toLowerCase()).toContain('sem tty');
    }
  });
});
