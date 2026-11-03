// Retomar sessão restaura NOME + COR; a oferta do splash os mostra e permite escolher
// OUTRA sessão do projeto (lista = <HistoryPicker> reaproveitado).

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/io/session-store.js';
import {
  decideBootResume,
  type ResumeChoice,
  type ResumeOfferInfo,
} from '../../src/session/resume.js';
import type { SessionBlock } from '../../src/session/model.js';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import {
  BootSplash,
  SplashApp,
  buildResumeOfferPrompt,
  createSplashStore,
  type SplashStore,
} from '../../src/session/splash-controller.js';

const you: SessionBlock = { kind: 'you', text: 'oi' };
const aluy: SessionBlock = { kind: 'aluy', text: 'olá', streaming: false };
const ENTER = '\r';
const ESC = '\x1b';
const DOWN = '\x1b[B';
const ANSI = new RegExp('\\x1b' + '\\[[0-9;]*[A-Za-z]', 'g');
const COLOR_SGR = new RegExp('\\x1b' + '\\[(3[0-7]|9[0-7]|38;)');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');
const wait = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('decideBootResume com promptResume — nome/cor e escolha de outra sessão', () => {
  let base: string;
  let store: SessionStore;
  let clock: number;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-resume-nome-'));
    clock = 100_000;
    store = new SessionStore({ baseDir: join(base, '.aluy'), now: () => clock });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const yes = async (): Promise<boolean> => true;
  const run = (promptResume: (i: ResumeOfferInfo) => Promise<ResumeChoice>) =>
    decideBootResume({
      request: undefined,
      fresh: false,
      isTty: true,
      store,
      cwd: '/p',
      promptYesNo: yes,
      promptResume,
      now: clock + 60_000,
    });

  it('a oferta carrega nome+cor; aceitar devolve o record COM nome e cor', async () => {
    store.save({
      id: 'a',
      cwd: '/p',
      tier: 't',
      label: 'api',
      labelColor: 'verde',
      blocks: [you, aluy],
    });
    let seen: ResumeOfferInfo | undefined;
    const r = await run(async (info) => {
      seen = info;
      return { kind: 'resume' };
    });
    expect(seen?.label).toBe('api');
    expect(seen?.labelColor).toBe('verde');
    expect(r.kind).toBe('resumed');
    if (r.kind === 'resumed') {
      expect(r.record.label).toBe('api');
      expect(r.record.labelColor).toBe('verde');
    }
  });

  it('sessão antiga SEM nome: oferta sem label e retoma normalmente', async () => {
    store.save({ id: 'old', cwd: '/p', tier: 't', blocks: [you, aluy] });
    let seen: ResumeOfferInfo | undefined;
    const r = await run(async (info) => {
      seen = info;
      return { kind: 'resume' };
    });
    expect(seen?.label).toBeUndefined();
    expect(r.kind).toBe('resumed');
    if (r.kind === 'resumed') expect(r.record.label).toBeUndefined();
  });

  it('escolher OUTRA sessão: devolve a escolhida (com nome/cor); lista só do cwd', async () => {
    clock = 1_000;
    store.save({
      id: 'velha',
      cwd: '/p',
      tier: 't',
      label: 'blog',
      labelColor: 'azul',
      blocks: [you, aluy],
    });
    store.save({ id: 'outro-dir', cwd: '/q', tier: 't', blocks: [you, aluy] });
    clock = 100_000;
    store.save({ id: 'nova', cwd: '/p', tier: 't', blocks: [you, aluy] });
    let seen: ResumeOfferInfo | undefined;
    const r = await run(async (info) => {
      seen = info;
      return { kind: 'pick', id: 'velha' };
    });
    expect(seen?.sessions.map((s) => s.id).sort()).toEqual(['nova', 'velha']);
    expect(r.kind).toBe('resumed');
    if (r.kind === 'resumed') {
      expect(r.record.id).toBe('velha');
      expect(r.record.label).toBe('blog');
      expect(r.record.labelColor).toBe('azul');
    }
  });

  it('nova ⇒ none; pick de id inexistente ⇒ none; prompt que lança ⇒ none', async () => {
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you, aluy] });
    expect(await run(async () => ({ kind: 'new' }))).toEqual({ kind: 'none' });
    expect(await run(async () => ({ kind: 'pick', id: 'nao-existe' }))).toEqual({ kind: 'none' });
    expect(
      await run(async () => {
        throw new Error('boom');
      }),
    ).toEqual({ kind: 'none' });
  });

  it('sem promptResume: o texto do prompt textual já traz o nome', async () => {
    store.save({ id: 'a', cwd: '/p', tier: 't', label: 'api', blocks: [you, aluy] });
    let asked = '';
    await decideBootResume({
      request: undefined,
      fresh: false,
      isTty: true,
      store,
      cwd: '/p',
      promptYesNo: async (p) => {
        asked = p;
        return true;
      },
      now: clock + 60_000,
    });
    expect(asked).toContain('«api»');
  });
});

describe('splash — oferta com nome na cor + lista de outras sessões', () => {
  const sess = (id: string, label?: string, color?: string) => ({
    id,
    createdAt: 0,
    updatedAt: 1_700_000_000_000,
    cwd: '/p',
    tier: 't',
    blockCount: 2,
    title: `fala ${id}`,
    ...(label ? { label } : {}),
    ...(color ? { labelColor: color } : {}),
  });
  const info: ResumeOfferInfo = {
    messageCount: 4,
    ageMs: 120_000,
    label: 'minha-api',
    labelColor: 'verde',
    sessions: [sess('s1', 'minha-api', 'verde'), sess('s2', 'blog', 'azul')],
  };

  function mount(store: SplashStore, env: Record<string, string>) {
    const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', ...env } });
    return render(
      <ThemeProvider theme={theme}>
        <SplashApp store={store} />
      </ThemeProvider>,
    );
  }
  function offer(store: SplashStore): Promise<ResumeChoice> {
    const splash = new BootSplash(store, {} as never, {} as never, Promise.resolve());
    return splash.promptResume(info);
  }

  it('buildResumeOfferPrompt: nome, contagem e dica de teclas em PT-BR', () => {
    const p = buildResumeOfferPrompt(info);
    expect(p.session).toEqual({ label: 'minha-api', color: 'verde' });
    expect(p.body.join(' ')).toContain('4 mensagens');
    expect(p.options).toBe('Enter retomar · l outras sessões · n nova');
    const sem = buildResumeOfferPrompt({ ...info, sessions: [info.sessions[0]!] });
    expect(sem.options).toBe('Enter retomar · n nova');
    const noName: ResumeOfferInfo = { messageCount: 4, ageMs: 1, sessions: info.sessions };
    expect(buildResumeOfferPrompt(noName).session).toBeUndefined();
  });

  it('mostra o nome pintado (com cor) e, sob NO_COLOR, o nome em texto puro', async () => {
    const colored = createSplashStore();
    const a = mount(colored, { COLORTERM: 'truecolor' });
    void offer(colored);
    await wait();
    const raw = a.lastFrame() ?? '';
    expect(plain(raw)).toContain('minha-api');
    expect(raw).toMatch(COLOR_SGR);
    a.unmount();

    const mono = createSplashStore();
    const b = mount(mono, { NO_COLOR: '1' });
    void offer(mono);
    await wait();
    const rawMono = b.lastFrame() ?? '';
    expect(rawMono).toContain('minha-api');
    expect(rawMono).not.toMatch(COLOR_SGR);
    b.unmount();
  });

  it('Enter retoma a sugerida', async () => {
    const store = createSplashStore();
    const m = mount(store, {});
    const p = offer(store);
    await wait();
    m.stdin.write(ENTER);
    await expect(p).resolves.toEqual({ kind: 'resume' });
    m.unmount();
  });

  it('n ⇒ nova', async () => {
    const store = createSplashStore();
    const m = mount(store, {});
    const p = offer(store);
    await wait();
    m.stdin.write('n');
    await expect(p).resolves.toEqual({ kind: 'new' });
    m.unmount();
  });

  it('l abre a lista; ↓ + Enter escolhe a outra; Esc volta à oferta', async () => {
    const store = createSplashStore();
    const m = mount(store, {});
    const p = offer(store);
    await wait();
    m.stdin.write('l');
    await wait();
    expect(plain(m.lastFrame())).toContain('blog');
    expect(plain(m.lastFrame())).toContain('enter retoma');
    m.stdin.write(ESC);
    await wait();
    expect(plain(m.lastFrame())).toContain('l outras sessões');
    m.stdin.write('l');
    await wait();
    m.stdin.write(DOWN);
    await wait();
    m.stdin.write(ENTER);
    await expect(p).resolves.toEqual({ kind: 'pick', id: 's2' });
    m.unmount();
  });
});
