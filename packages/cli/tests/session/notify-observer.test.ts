// EST-0963 — o gancho ESTREITO (notify-observer) dispara o sino nas transições
// certas: (a) ask-pendente (entra em `asking`) e (b) done APÓS turno longo. Turno
// curto não notifica. Não toca o controller — só lê o stream de estado.

import { describe, expect, it } from 'vitest';
import { attachNotifyObserver } from '../../src/session/notify-observer.js';
import type { SessionState } from '../../src/session/model.js';
import type { NotificationPort, NotifyReason } from '../../src/io/notify-port.js';

/** Porta-spy: registra os motivos notificados, sempre "habilitada". */
function spyPort(): { reasons: NotifyReason[]; port: NotificationPort } {
  const reasons: NotifyReason[] = [];
  const port: NotificationPort = {
    notify: (r) => reasons.push(r),
    enabled: true,
    setEnabled: () => {},
  };
  return { reasons, port };
}

/** Um `subscribe` falso controlável: devolve um `emit` p/ empurrar estados. */
function fakeController(initial: SessionState) {
  let observer: ((s: SessionState) => void) | null = null;
  const subscribe = (o: (s: SessionState) => void): (() => void) => {
    observer = o;
    o(initial); // o subscribe real emite o estado atual na hora (base, sem sino).
    return () => {
      observer = null;
    };
  };
  const emit = (phase: SessionState['phase']): void => {
    observer?.({ ...initial, phase });
  };
  return { subscribe, emit };
}

const BASE: SessionState = {
  blocks: [],
  meta: { cwd: '~/p', tier: 't', tokens: 0, windowPct: 0 },
  phase: 'idle',
  mode: 'normal',
};

describe('attachNotifyObserver — ask-pendente (atenção)', () => {
  it('idle → thinking → asking ⇒ notifica `attention` (turno espera o usuário)', () => {
    const { reasons, port } = spyPort();
    const c = fakeController(BASE);
    attachNotifyObserver(c.subscribe, { port, now: () => 0 });
    c.emit('thinking');
    c.emit('asking');
    expect(reasons).toEqual(['attention']);
  });

  it('estado inicial (subscribe imediato) NÃO dispara sino', () => {
    const { reasons, port } = spyPort();
    const c = fakeController({ ...BASE, phase: 'asking' });
    attachNotifyObserver(c.subscribe, { port, now: () => 0 });
    // só o emit imediato do subscribe (base) — sem transição ⇒ sem sino.
    expect(reasons).toEqual([]);
  });

  it('asking → streaming → asking ⇒ notifica de novo a cada nova espera', () => {
    const { reasons, port } = spyPort();
    const c = fakeController(BASE);
    attachNotifyObserver(c.subscribe, { port, now: () => 0 });
    c.emit('thinking');
    c.emit('asking');
    c.emit('streaming'); // ask resolvido
    c.emit('asking'); // nova aprovação pendente
    expect(reasons).toEqual(['attention', 'attention']);
  });
});

describe('attachNotifyObserver — done após turno longo', () => {
  it('turno LONGO (≥ limiar) ⇒ notifica `done` ao concluir', () => {
    const { reasons, port } = spyPort();
    let t = 0;
    const c = fakeController(BASE);
    attachNotifyObserver(c.subscribe, { port, longTurnMs: 1000, now: () => t });
    t = 0;
    c.emit('thinking'); // arma o cronômetro em t=0
    t = 5000; // passou 5s
    c.emit('done');
    expect(reasons).toEqual(['done']);
  });

  it('turno CURTO (< limiar) ⇒ NÃO notifica ao concluir (anti-ruído)', () => {
    const { reasons, port } = spyPort();
    let t = 0;
    const c = fakeController(BASE);
    attachNotifyObserver(c.subscribe, { port, longTurnMs: 5000, now: () => t });
    t = 0;
    c.emit('thinking');
    t = 200; // 200ms — relâmpago
    c.emit('done');
    expect(reasons).toEqual([]);
  });

  it('budget (teto) após turno longo ⇒ também notifica `done`', () => {
    const { reasons, port } = spyPort();
    let t = 0;
    const c = fakeController(BASE);
    attachNotifyObserver(c.subscribe, { port, longTurnMs: 1000, now: () => t });
    t = 0;
    c.emit('streaming');
    t = 9000;
    c.emit('budget');
    expect(reasons).toEqual(['done']);
  });

  it('turno que parou p/ ask e depois concluiu (longo) ⇒ atenção + done', () => {
    const { reasons, port } = spyPort();
    let t = 0;
    const c = fakeController(BASE);
    attachNotifyObserver(c.subscribe, { port, longTurnMs: 1000, now: () => t });
    t = 0;
    c.emit('thinking'); // arma em 0
    t = 100;
    c.emit('asking'); // atenção (espera)
    t = 200;
    c.emit('streaming'); // resolveu
    t = 4000;
    c.emit('done'); // longo (4s) ⇒ done
    expect(reasons).toEqual(['attention', 'done']);
  });

  it('error após turno longo ⇒ NÃO emite `done` (só conclusão limpa notifica)', () => {
    const { reasons, port } = spyPort();
    let t = 0;
    const c = fakeController(BASE);
    attachNotifyObserver(c.subscribe, { port, longTurnMs: 1000, now: () => t });
    t = 0;
    c.emit('streaming');
    t = 9000;
    c.emit('error');
    expect(reasons).toEqual([]);
  });

  it('unsubscribe ⇒ para de observar (sem sino após soltar)', () => {
    const { reasons, port } = spyPort();
    const c = fakeController(BASE);
    const detach = attachNotifyObserver(c.subscribe, { port, now: () => 0 });
    detach();
    c.emit('asking'); // observer solto ⇒ nada
    expect(reasons).toEqual([]);
  });
});
