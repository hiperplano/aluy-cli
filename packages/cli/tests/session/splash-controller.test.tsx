// EST-0989 — DRIVER do splash de boot: o <SplashApp> reflete o store e captura o
// SINGLE-KEY da pergunta (s/y/Enter ⇒ sim; n/Esc ⇒ não), consistente com a TUI
// (EST-0972). A pergunta vem FORMATADA na caixa; resolver ⇒ volta p/ "carregando".
//
// Provas (FRUGAL — ink-testing dirige stdin, sem modelo/rede/TTY real):
//  · caixa: setar um prompt ⇒ a CAIXA aparece (título/opções), o "carregando" some;
//  · single-key: 's'/'y'/Enter ⇒ resolve(true); 'n'/Esc ⇒ resolve(false);
//  · após resolver: o prompt some do store (volta p/ "carregando" — próximo passo);
//  · status: trocar o status do store ⇒ o verbo muda na tela;
//  · `parseBootPrompt` mapeia o texto cru (testado também em ui/splash-screen).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import {
  SplashApp,
  createSplashStore,
  parseBootPrompt,
  type SplashStore,
} from '../../src/session/splash-controller.js';
import type { BootPrompt } from '../../src/ui/components/SplashScreen.js';
import { SPLASH_QUIPS } from '../../src/ui/components/splash-quips.js';

const ENTER = '\r';
const ESC = '\x1b';

const ESC_RE = new RegExp('\\x1b' + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string | undefined): string {
  return (s ?? '').replace(ESC_RE, '');
}

function mountSplash(store: SplashStore) {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  return render(
    <ThemeProvider theme={theme}>
      <SplashApp store={store} />
    </ThemeProvider>,
  );
}

const RESUME_PROMPT: BootPrompt = {
  title: '↻ retomar sessão',
  body: ['retomar a conversa anterior (3 mensagens, há 2 min)?'],
  options: '[s] retomar · [n] nova sessão',
};

/** Seta uma pergunta no store e devolve a Promise que resolve no single-key. */
function ask(store: SplashStore, prompt: BootPrompt): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const finish = (accept: boolean): void => {
      store.set((s) => ({ ...s, prompt: undefined, resolve: null }));
      resolve(accept);
    };
    store.set((s) => ({ ...s, prompt, resolve: finish }));
  });
}

describe('SplashApp — caixa de pergunta no boot (EST-0989)', () => {
  it('sem pergunta: mostra a frase divertida de carga (EST-1015)', () => {
    const store = createSplashStore();
    const { lastFrame, unmount } = mountSplash(store);
    // o status genérico "carregando" virou uma FRASE DIVERTIDA rotativa (frame 0 ⇒ a 1ª).
    expect(plain(lastFrame())).toContain(SPLASH_QUIPS[0]);
    unmount();
  });

  it('com pergunta: a CAIXA substitui o "carregando" (título + opções)', async () => {
    const store = createSplashStore();
    const { lastFrame, unmount } = mountSplash(store);
    void ask(store, RESUME_PROMPT);
    // deixa o React refletir o store
    await new Promise((r) => setTimeout(r, 60));
    const out = plain(lastFrame());
    expect(out).toContain('retomar sessão');
    expect(out).toContain('[s] retomar');
    expect(out).not.toContain('carregando');
    unmount();
  });
});

describe('SplashApp — single-key (EST-0989/EST-0972)', () => {
  async function pressAndExpect(key: string, expected: boolean): Promise<void> {
    const store = createSplashStore();
    const { stdin, unmount } = mountSplash(store);
    const p = ask(store, RESUME_PROMPT);
    await new Promise((r) => setTimeout(r, 60)); // monta a caixa + ativa o useInput
    stdin.write(key);
    await expect(p).resolves.toBe(expected);
    // após resolver, o prompt some do store (volta p/ "carregando")
    expect(store.get().prompt).toBeUndefined();
    unmount();
  }

  it("'s' ⇒ retoma (true)", () => pressAndExpect('s', true));
  it("'y' ⇒ retoma (true)", () => pressAndExpect('y', true));
  it('Enter ⇒ retoma (true) — default da auto-oferta', () => pressAndExpect(ENTER, true));
  it("'n' ⇒ nova sessão (false)", () => pressAndExpect('n', false));
  it('Esc ⇒ nova sessão (false)', () => pressAndExpect(ESC, false));

  it('tecla irrelevante NÃO resolve (a pergunta segue na tela)', async () => {
    const store = createSplashStore();
    const { stdin, lastFrame, unmount } = mountSplash(store);
    void ask(store, RESUME_PROMPT);
    await new Promise((r) => setTimeout(r, 60));
    stdin.write('x'); // não é s/y/n/Enter/Esc
    await new Promise((r) => setTimeout(r, 60));
    expect(store.get().prompt).toBeDefined(); // ainda pendente
    expect(plain(lastFrame())).toContain('retomar sessão');
    unmount();
  });
});

describe('SplashApp — status de carga muda na tela (EST-0989)', () => {
  it('trocar o status do store ⇒ o verbo aparece', async () => {
    const store = createSplashStore();
    const { lastFrame, unmount } = mountSplash(store);
    store.set((s) => ({ ...s, status: 'descobrindo MCP' }));
    await new Promise((r) => setTimeout(r, 60));
    expect(plain(lastFrame())).toContain('descobrindo MCP');
    unmount();
  });
});

describe('parseBootPrompt — integração com o single-key (EST-0989)', () => {
  it('o texto cru de retomada vira uma caixa decidível por single-key', async () => {
    const store = createSplashStore();
    const { stdin, unmount } = mountSplash(store);
    const prompt = parseBootPrompt('↻ retomar a conversa anterior (1 mensagem, há 1 min)? [S/n] ');
    const p = ask(store, prompt);
    await new Promise((r) => setTimeout(r, 60));
    stdin.write('s');
    await expect(p).resolves.toBe(true);
    unmount();
  });
});
