// EST-0963 — a NotificationPort emite BEL/OSC nos motivos certos, é gated por TTY,
// silencia com o toggle off, e o texto é NEUTRO (sem vazar conteúdo/segredo).

import { describe, expect, it } from 'vitest';
import {
  TerminalNotificationPort,
  NOTIFY_LABELS,
  loadNotifyConfig,
} from '../../src/io/notify-port.js';

const BEL = '\x07';
const OSC9 = '\x1b]9;';

/** Sink-spy: acumula tudo que a porta escreveria no stdout. */
function spy(): { out: string[]; write: (s: string) => void } {
  const out: string[] = [];
  return { out, write: (s) => out.push(s) };
}

describe('TerminalNotificationPort — BEL/OSC em TTY', () => {
  it('TTY + ligado ⇒ emite BEL e OSC 9 com rótulo NEUTRO (attention)', () => {
    const s = spy();
    const port = new TerminalNotificationPort({ write: s.write, isTty: true, enabled: true });
    port.notify('attention');
    const all = s.out.join('');
    expect(all).toContain(BEL); // BEL emitido
    expect(all).toContain(OSC9); // OSC 9 emitido
    expect(all).toContain(NOTIFY_LABELS.attention); // rótulo fixo neutro
    // OSC 9 bem-formado: ESC ] 9 ; <texto> BEL.
    expect(all).toContain(`${OSC9}${NOTIFY_LABELS.attention}${BEL}`);
  });

  it('motivo `done` ⇒ rótulo de turno concluído (neutro)', () => {
    const s = spy();
    const port = new TerminalNotificationPort({ write: s.write, isTty: true });
    port.notify('done');
    expect(s.out.join('')).toContain(NOTIFY_LABELS.done);
  });

  it('texto NEUTRO: o rótulo nunca interpola conteúdo de sessão/segredo', () => {
    // Os rótulos são CONSTANTES — não há ponto de injeção de conteúdo. Provamos
    // que a porta só conhece os dois rótulos fixos e nada além.
    const s = spy();
    const port = new TerminalNotificationPort({ write: s.write, isTty: true });
    port.notify('attention');
    port.notify('done');
    const all = s.out.join('');
    // Tudo que saiu (fora dos bytes de controle) está no conjunto de rótulos fixos.
    const visible = all.replaceAll(BEL, '').replaceAll('\x1b]9;', '');
    const allowed = `${NOTIFY_LABELS.attention}${NOTIFY_LABELS.done}`;
    expect(visible).toBe(allowed);
  });
});

describe('TerminalNotificationPort — gates (TTY / toggle)', () => {
  it('NÃO-TTY ⇒ silêncio total (sem BEL/OSC) — não polui pipe/CI', () => {
    const s = spy();
    const port = new TerminalNotificationPort({ write: s.write, isTty: false, enabled: true });
    port.notify('attention');
    expect(s.out).toHaveLength(0);
    expect(port.enabled).toBe(false); // gate de TTY vence o toggle
  });

  it('toggle OFF (em TTY) ⇒ silêncio total', () => {
    const s = spy();
    const port = new TerminalNotificationPort({ write: s.write, isTty: true, enabled: false });
    port.notify('attention');
    expect(s.out).toHaveLength(0);
    expect(port.enabled).toBe(false);
  });

  it('setEnabled(false) em runtime ⇒ para de emitir; setEnabled(true) volta', () => {
    const s = spy();
    const port = new TerminalNotificationPort({ write: s.write, isTty: true, enabled: true });
    port.setEnabled(false);
    port.notify('attention');
    expect(s.out).toHaveLength(0);
    port.setEnabled(true);
    port.notify('attention');
    expect(s.out.join('')).toContain(BEL);
  });

  it('desktop=false ⇒ emite BEL mas NÃO o OSC 9 (NO_COLOR desliga só o escape)', () => {
    const s = spy();
    const port = new TerminalNotificationPort({
      write: s.write,
      isTty: true,
      enabled: true,
      desktop: false,
    });
    port.notify('attention');
    const all = s.out.join('');
    expect(all).toContain(BEL); // sino continua
    expect(all).not.toContain(OSC9); // OSC suprimido
  });

  it('best-effort: erro de escrita NUNCA propaga (sino não derruba a sessão)', () => {
    const port = new TerminalNotificationPort({
      write: () => {
        throw new Error('EPIPE');
      },
      isTty: true,
      enabled: true,
    });
    expect(() => port.notify('attention')).not.toThrow();
  });
});

describe('loadNotifyConfig — env', () => {
  it('sem env ⇒ ligado + desktop ligado (default sensato)', () => {
    const c = loadNotifyConfig({});
    expect(c.enabled).toBe(true);
    expect(c.desktop).toBe(true);
  });

  it('ALUY_NOTIFY=0 ⇒ desligado', () => {
    expect(loadNotifyConfig({ ALUY_NOTIFY: '0' }).enabled).toBe(false);
    expect(loadNotifyConfig({ ALUY_NOTIFY: 'false' }).enabled).toBe(false);
    expect(loadNotifyConfig({ ALUY_NOTIFY: 'off' }).enabled).toBe(false);
  });

  it('ALUY_NOTIFY=1/qualquer-truthy ⇒ ligado', () => {
    expect(loadNotifyConfig({ ALUY_NOTIFY: '1' }).enabled).toBe(true);
    expect(loadNotifyConfig({ ALUY_NOTIFY: 'on' }).enabled).toBe(true);
  });

  it('NO_COLOR (qualquer valor) ⇒ desktop=false (OSC desligado), bell intacto', () => {
    expect(loadNotifyConfig({ NO_COLOR: '1' }).desktop).toBe(false);
    expect(loadNotifyConfig({ NO_COLOR: '' }).desktop).toBe(false);
    // NO_COLOR não desliga o sino em si — só o canal de escape (desktop).
    expect(loadNotifyConfig({ NO_COLOR: '1' }).enabled).toBe(true);
  });
});
