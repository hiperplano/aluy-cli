// EST-0972 — `/history` na App: digitar `/history` abre o PICKER de sessões; ↑↓ navega;
// Enter RETOMA a escolhida AO VIVO (restaura a transcrição + semeia o contexto, via
// o MESMO restoreBlocks/seedHistory do --resume); esc CANCELA sem mudar a sessão.
//
// Drivamos o caminho REAL do composer (stdin) com um MOCK do SessionStore e o wiring
// de retomada idêntico ao run.tsx (applyResumeRecord). Sem broker, sem modelo real.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { applyResumeRecord } from '../../src/session/history.js';
import type { SessionRecord, SessionStore } from '../../src/io/index.js';
import type { SessionBlock } from '../../src/session/model.js';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return [];
    },
  };
  return { fs, shell, search };
}

function scriptedCaller(text: string): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: text, finish_reason: 'stop' };
    },
  };
}

function buildController(): SessionController {
  return new SessionController({
    model: scriptedCaller('ok'),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const you = (t: string): SessionBlock => ({ kind: 'you', text: t });
const aluy = (t: string): SessionBlock => ({ kind: 'aluy', text: t, streaming: false });

function rec(id: string, updatedAt: number, blocks: readonly SessionBlock[]): SessionRecord {
  return { id, version: 1, createdAt: 1, updatedAt, cwd: '/proj', tier: 'aluy-strata', blocks };
}

const RECORDS: Record<string, SessionRecord> = {
  novo: rec('novo', 200, [you('pergunta nova'), aluy('resposta nova')]),
  velho: rec('velho', 100, [you('pergunta velha')]),
};

/** Mock do store: list() devolve resumos recente-first; load() devolve o record. */
function mockStore(): Pick<SessionStore, 'list' | 'load'> {
  return {
    list: () =>
      Object.values(RECORDS)
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          cwd: r.cwd,
          tier: r.tier,
          blockCount: r.blocks.length,
          title: (r.blocks.find((b) => b.kind === 'you') as { text: string } | undefined)?.text,
        })),
    load: (id: string) => RECORDS[id] ?? null,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Wiring de retomada IDÊNTICO ao run.tsx (onResumeSession): carrega o record pelo id e
 * aplica `applyResumeRecord` (restoreBlocks + seedHistory + troca o alvo do auto-save).
 * Devolve também o que foi capturado p/ as asserções (id retomado, seed semeado).
 */
function resumeWiring(store: Pick<SessionStore, 'load'>, controller: SessionController) {
  const captured: { resumedId: string | null; seeded: boolean; switchedTo: string | null } = {
    resumedId: null,
    seeded: false,
    switchedTo: null,
  };
  const onResumeSession = (id: string): void => {
    const record = store.load(id);
    if (!record) return;
    captured.resumedId = id;
    applyResumeRecord(record, {
      restoreBlocks: (blocks) => controller.restoreBlocks(blocks),
      seedHistory: (items) => {
        captured.seeded = items.length > 0;
        controller.seedHistory(items);
      },
      switchSession: (t) => {
        captured.switchedTo = t.id;
        if (t.tier.trim() !== '') controller.setTier(t.tier);
      },
      clearScreen: () => {},
    });
  };
  return { onResumeSession, captured };
}

function renderApp(controller: SessionController, store: Pick<SessionStore, 'list' | 'load'>) {
  const { onResumeSession, captured } = resumeWiring(store, controller);
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        sessionStore={store}
        onResumeSession={onResumeSession}
      />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { ...r, captured };
}

describe('App — `/history` abre o picker e RETOMA a sessão escolhida (EST-0972)', () => {
  it('digitar `/history` + Enter ⇒ RETOMA a 1ª (mais recente): restoreBlocks + seedHistory', async () => {
    const controller = buildController();
    const store = mockStore();
    const { stdin, lastFrame, captured, unmount } = renderApp(controller, store);

    // abre o picker: `/history` + Enter (o Enter confirma a abertura do seletor).
    await pressUntil(
      () => stdin.write('/history\r'),
      () => (lastFrame() ?? '').includes('retomar sessão'),
    );
    // o picker lista as sessões (recente-first): "pergunta nova" antes de "pergunta velha".
    expect(lastFrame()).toContain('pergunta nova');

    // Enter no item 0 (a mais recente) ⇒ retoma.
    await pressUntil(
      () => stdin.write('\r'),
      () => captured.resumedId !== null,
    );

    expect(captured.resumedId).toBe('novo');
    expect(captured.switchedTo).toBe('novo'); // trocou o alvo do auto-save.
    expect(captured.seeded).toBe(true); // semeou o contexto (lastRunHistory).
    // a transcrição da sessão retomada está na tela (restoreBlocks).
    await waitFor(() =>
      controller.blocks.some((b) => b.kind === 'you' && b.text === 'pergunta nova'),
    );
    unmount();
  });

  it('↑↓ navega e Enter retoma a sessão SELECIONADA (não só a 1ª)', async () => {
    const controller = buildController();
    const store = mockStore();
    const { stdin, lastFrame, captured, unmount } = renderApp(controller, store);

    const ESC = String.fromCharCode(27);
    const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
    const plain = (): string => (lastFrame() ?? '').replace(ANSI, '');
    await pressUntil(
      () => stdin.write('/history\r'),
      () => plain().includes('retomar sessão'),
    );
    // desce p/ o 2º item (a mais velha): espera o marcador › migrar p/ a linha "velha".
    await pressUntil(
      () => stdin.write('\x1b[B'), // seta p/ baixo
      () => /›[^\n]*pergunta velha/.test(plain()),
    );
    // confirma a seleção corrente (a mais velha).
    await pressUntil(
      () => stdin.write('\r'),
      () => captured.resumedId !== null,
    );
    expect(captured.resumedId).toBe('velho');
    unmount();
  });

  it('esc CANCELA: fica na sessão atual, NÃO retoma nada', async () => {
    const controller = buildController();
    const store = mockStore();
    const { stdin, lastFrame, captured, unmount } = renderApp(controller, store);

    await pressUntil(
      () => stdin.write('/history\r'),
      () => (lastFrame() ?? '').includes('retomar sessão'),
    );
    // esc fecha o picker.
    await pressUntil(
      () => stdin.write('\x1b'),
      () => !(lastFrame() ?? '').includes('retomar sessão'),
    );
    expect(captured.resumedId).toBeNull(); // não retomou.
    expect(controller.blocks.length).toBe(0); // sessão atual intacta (vazia).
    unmount();
  });

  it('`/history <id>` (atalho com arg) retoma DIRETO, sem abrir o picker', async () => {
    const controller = buildController();
    const store = mockStore();
    const { stdin, captured, unmount } = renderApp(controller, store);

    await pressUntil(
      () => stdin.write('/history velho\r'),
      () => captured.resumedId !== null,
    );
    expect(captured.resumedId).toBe('velho');
    unmount();
  });

  it('SEM sessões ⇒ o picker abre mostrando "nenhuma sessão anterior" (esc sai)', async () => {
    const controller = buildController();
    const emptyStore: Pick<SessionStore, 'list' | 'load'> = { list: () => [], load: () => null };
    const { stdin, lastFrame, captured, unmount } = renderApp(controller, emptyStore);

    await pressUntil(
      () => stdin.write('/history\r'),
      () => (lastFrame() ?? '').includes('nenhuma sessão anterior'),
    );
    // Enter na lista vazia é no-op (não retoma).
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(captured.resumedId).toBeNull();
    unmount();
  });
});
