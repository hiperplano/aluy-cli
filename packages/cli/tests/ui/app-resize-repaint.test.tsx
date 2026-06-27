// EST-1015 — RESIZE no modo INLINE força um REPAINT LIMPO (anti "tela quebra ao
// redimensionar"). Bug reproduzido em tmux/PTY real: ao redimensionar, o reflow do
// terminal deixava divisores/linhas de larguras ANTIGAS órfãos na tela (um divisor de
// 60 col sobrava acima do frame de 120; fragmentos colavam no composer). O `log-update`
// do Ink só apaga `previousLineCount` linhas e a conta erra no reflow. O fix: na mudança
// de DIMENSÃO (e só no INLINE — o cockpit tem o differ), `clearScreen()` repinta do zero
// (`\x1b[2J\x1b[3J\x1b[H` + remontar o <Static>), com debounce ~90ms p/ coalescer o drag.
//
// PROVA: o `\x1b[2J` (clear de TELA INTEIRA) é a ASSINATURA do `clearScreen` — o Ink
// normal usa `\x1b[2K` (clear de LINHA), nunca `2J`. Então "houve 2J após o resize" prova
// o repaint limpo, e "NÃO houve 2J sem mudança de dimensão" prova que não re-emitimos à toa.

import React from 'react';
import { describe, expect, it } from 'vitest';
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

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const CLEAR_SCREEN = '\x1b[2J'; // assinatura do clearScreen (full-screen erase)

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

function renderApp(controller: SessionController, extra: Record<string, unknown> = {}) {
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} {...extra} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return r;
}

// O fake stdout do ink-testing-library é um EventEmitter com `.columns`/`.rows` e `.write`.
// Mudar a dimensão + `emit('resize')` é exatamente o que o terminal real faz no SIGWINCH.
function resize(stdout: { emit: (e: string) => void }, columns: number, rows: number): void {
  // `columns`/`rows` no fake do ink-testing-library são GETTERS — redefinimos a
  // propriedade (como o terminal real faz no SIGWINCH antes de emitir 'resize').
  Object.defineProperty(stdout, 'columns', { value: columns, configurable: true });
  Object.defineProperty(stdout, 'rows', { value: rows, configurable: true });
  stdout.emit('resize');
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('App — RESIZE inline força repaint limpo (anti tela-quebrada) — EST-1015', () => {
  it('mudança de DIMENSÃO no inline emite o clear de tela inteira (\\x1b[2J)', async () => {
    const controller = buildController();
    const { stdout, lastFrame, unmount } = renderApp(controller);
    await waitFor(() => (lastFrame() ?? '').length > 0);
    const before = stdout.frames.length;
    resize(stdout as never, 60, 24);
    // debounce ~90ms: espera assentar.
    await waitFor(() => stdout.frames.slice(before).some((f) => f.includes(CLEAR_SCREEN)));
    expect(stdout.frames.slice(before).some((f) => f.includes(CLEAR_SCREEN))).toBe(true);
    unmount();
  });

  it('SEM mudança de dimensão (resize espúrio, mesma medida) NÃO emite clear', async () => {
    const controller = buildController();
    const { stdout, lastFrame, unmount } = renderApp(controller);
    await waitFor(() => (lastFrame() ?? '').length > 0);
    const cols = stdout.columns as number;
    const rows = stdout.rows as number;
    const before = stdout.frames.length;
    resize(stdout as never, cols, rows); // mesma dimensão
    await sleep(180);
    expect(stdout.frames.slice(before).some((f) => f.includes(CLEAR_SCREEN))).toBe(false);
    unmount();
  });

  it('DRAG (resizes rápidos) COALESCE num único clear no fim (debounce)', async () => {
    const controller = buildController();
    const { stdout, lastFrame, unmount } = renderApp(controller);
    await waitFor(() => (lastFrame() ?? '').length > 0);
    const before = stdout.frames.length;
    // simula arrastar a janela: 5 resizes em < 90ms cada.
    for (const w of [90, 70, 50, 65, 80]) {
      resize(stdout as never, w, 24);
      await sleep(15);
    }
    await waitFor(() => stdout.frames.slice(before).some((f) => f.includes(CLEAR_SCREEN)));
    await sleep(120); // deixa qualquer clear extra aparecer
    const clears = stdout.frames.slice(before).filter((f) => f.includes(CLEAR_SCREEN)).length;
    // trailing-edge: 1 clear no fim do drag, não 5.
    expect(clears).toBe(1);
    unmount();
  });
});
