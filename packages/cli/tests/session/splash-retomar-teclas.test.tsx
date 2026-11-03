// Auditoria — teclas da oferta de retomada no splash: sim/não por todas as teclas anunciadas
// (s, y, Enter / n, Esc, Ctrl-C), `l` só com mais de uma sessão, limites do cursor da lista,
// Ctrl-C na lista volta à oferta, e o rascunho digitado durante o splash não responde à oferta.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import {
  BootSplash,
  SplashApp,
  createSplashStore,
  type SplashStore,
} from '../../src/session/splash-controller.js';
import type { ResumeChoice, ResumeOfferInfo } from '../../src/session/resume.js';

const ESC = '\x1b';
const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ANSI = new RegExp('\\x1b' + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');
const wait = (ms = 70): Promise<void> => new Promise((r) => setTimeout(r, ms));

const sess = (id: string) => ({
  id,
  createdAt: 0,
  updatedAt: 1_700_000_000_000,
  cwd: '/p',
  tier: 't',
  blockCount: 2,
  title: `fala ${id}`,
});
const tres: ResumeOfferInfo = {
  messageCount: 3,
  ageMs: 60_000,
  sessions: [sess('s1'), sess('s2'), sess('s3')],
};
const uma: ResumeOfferInfo = { messageCount: 3, ageMs: 60_000, sessions: [sess('s1')] };

function montar(info: ResumeOfferInfo) {
  const store: SplashStore = createSplashStore();
  const m = render(
    <ThemeProvider theme={resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } })}>
      <SplashApp store={store} />
    </ThemeProvider>,
  );
  const splash = new BootSplash(store, {} as never, {} as never, Promise.resolve());
  const escolha: Promise<ResumeChoice> = splash.promptResume(info);
  return { store, m, escolha };
}

describe('oferta de retomada · responder', () => {
  it.each([
    ['s', 's', { kind: 'resume' }],
    ['y', 'y', { kind: 'resume' }],
    ['Enter', '\r', { kind: 'resume' }],
    ['n', 'n', { kind: 'new' }],
    ['Esc', ESC, { kind: 'new' }],
    ['Ctrl-C', '\x03', { kind: 'new' }],
  ])('%s', async (_nome, tecla, esperado) => {
    const { m, escolha } = montar(tres);
    await wait();
    m.stdin.write(tecla);
    await expect(escolha).resolves.toEqual(esperado);
    m.unmount();
  });

  it('maiúsculas valem (S, N)', async () => {
    const a = montar(tres);
    await wait();
    a.m.stdin.write('S');
    await expect(a.escolha).resolves.toEqual({ kind: 'resume' });
    a.m.unmount();
    const b = montar(tres);
    await wait();
    b.m.stdin.write('N');
    await expect(b.escolha).resolves.toEqual({ kind: 'new' });
    b.m.unmount();
  });
});

describe('oferta de retomada · lista de outras sessões', () => {
  it('com UMA só sessão a tecla `l` não abre a lista (e a dica não a anuncia)', async () => {
    const { m, store, escolha } = montar(uma);
    await wait();
    expect(plain(m.lastFrame())).not.toContain('l outras sessões');
    m.stdin.write('l');
    await wait();
    expect(store.get().resume?.view).toBe('offer');
    m.stdin.write('n');
    await expect(escolha).resolves.toEqual({ kind: 'new' });
    m.unmount();
  });

  it('o cursor para nos limites (não passa do 1º nem do último) e Enter escolhe o realçado', async () => {
    const { m, store, escolha } = montar(tres);
    await wait();
    m.stdin.write('l');
    await wait();
    m.stdin.write(UP); // já no topo
    await wait();
    expect(store.get().resume?.selected).toBe(0);
    for (let i = 0; i < 5; i++) {
      m.stdin.write(DOWN);
      await wait(40);
    }
    expect(store.get().resume?.selected).toBe(2); // trava no último
    m.stdin.write('\r');
    await expect(escolha).resolves.toEqual({ kind: 'pick', id: 's3' });
    m.unmount();
  });

  it('Ctrl-C na lista volta à oferta (não fecha nem escolhe)', async () => {
    const { m, store, escolha } = montar(tres);
    await wait();
    m.stdin.write('l');
    await wait();
    expect(store.get().resume?.view).toBe('list');
    m.stdin.write('\x03');
    await wait();
    expect(store.get().resume?.view).toBe('offer');
    m.stdin.write('\r');
    await expect(escolha).resolves.toEqual({ kind: 'resume' });
    m.unmount();
  });
});

describe('oferta de retomada · digitação antecipada', () => {
  it('com rascunho em curso o Enter NÃO responde à oferta; Esc limpa o rascunho antes de qualquer coisa', async () => {
    const { m, store, escolha } = montar(tres);
    await wait();
    m.stdin.write('oi');
    await wait();
    expect(store.get().typed).toBe('oi');
    m.stdin.write('\r');
    await wait();
    expect(store.get().resume).toBeDefined(); // a oferta segue pendente
    m.stdin.write(ESC);
    await wait();
    expect(store.get().typed).toBe('');
    expect(store.get().resume).toBeDefined(); // o 1º Esc só limpou o rascunho
    m.stdin.write('n');
    await expect(escolha).resolves.toEqual({ kind: 'new' });
    m.unmount();
  });

  it('s/y/n/l como PRIMEIRA tecla são resposta; depois de começar a digitar viram texto', async () => {
    const { m, store, escolha } = montar(tres);
    await wait();
    m.stdin.write('x'); // começa um rascunho
    await wait();
    m.stdin.write('s'); // agora é texto, não "sim"
    await wait();
    expect(store.get().typed).toBe('xs');
    expect(store.get().resume).toBeDefined();
    m.stdin.write('\x7f');
    m.stdin.write('\x7f');
    await wait();
    expect(store.get().typed).toBe('');
    m.stdin.write('s');
    await expect(escolha).resolves.toEqual({ kind: 'resume' });
    m.unmount();
  });
});
