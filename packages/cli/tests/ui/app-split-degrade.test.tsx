// EST-0990 — degradação por LARGURA do split no App (RENDER real): com o split LIGADO,
// 60–99 col ⇒ TABS (barra de abas + 1 coluna), <60 col ⇒ DESABILITA (1 coluna + aviso).
// O ink-testing fixa columns=100; aqui MOCKamos `useStdout` p/ forçar larguras estreitas.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// Mock só do `useStdout` (o resto do Ink intacto). `__COLUMNS` decide a largura.
let MOCK_COLUMNS = 70;
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({
      stdout: { columns: MOCK_COLUMNS, rows: 40, write: () => {} },
    }),
  };
});

import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type SearchPort,
  type ShellPort,
} from '@aluy/cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');
const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

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
function inertCaller(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
}
function buildController(): SessionController {
  return new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}
function renderApp(controller: SessionController) {
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: ENV })}>
      <App controller={controller} animate={false} bootMs={0} initialSplitView={true} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return r;
}

describe('App — degradação do split por largura (EST-0990)', () => {
  it('70 col ⇒ TABS: barra de abas (CHAT / LOG) com 1 coluna ativa', async () => {
    MOCK_COLUMNS = 70;
    const controller = buildController();
    const { lastFrame, unmount } = renderApp(controller);
    // espera o boot DISPENSAR (a barra de abas só aparece pós-boot).
    await waitFor(() => plain(lastFrame() ?? '').includes('▎CHAT'));
    const out = plain(lastFrame() ?? '');
    // a barra de abas usa o marcador ▎ + CHAT/LOG; a aba ativa (chat) mostra o chat.
    expect(out).toContain('▎CHAT');
    expect(out).toContain('LOG');
    // NÃO há a régua lado-a-lado `│ LOG` (não é o modo side).
    expect(out).not.toContain('sem atividade ainda'); // a aba ativa é o CHAT
    unmount();
  });

  it('50 col ⇒ DESABILITADO: 1 coluna + aviso de tela estreita', async () => {
    MOCK_COLUMNS = 50;
    const controller = buildController();
    const { lastFrame, unmount } = renderApp(controller);
    await waitFor(() => plain(lastFrame() ?? '').includes('split desabilitado'));
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('split desabilitado');
    expect(out).toContain('estreita');
    // sem aba nem coluna de log (degradou p/ 1 coluna).
    expect(out).not.toContain('▎CHAT');
    unmount();
  });
});
