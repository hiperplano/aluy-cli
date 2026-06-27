// EST-PASTE-COLLAPSE — na <App>: colar um bloco GRANDE (≥6 linhas) COLAPSA num CHIP textual
// `[texto colado #N, +L linhas]` no composer (NÃO despeja o texto cru); ao SUBMETER, o chip
// EXPANDE no conteúdo COMPLETO (o modelo recebe o texto inteiro). Bloco PEQUENO segue inline.
//
// Espelha o harness de bracketed-paste-app.test.tsx (mesmo controller/tema/render fake).

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { PASTE_START, PASTE_END } from '../../src/session/bracketed-paste.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}

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

async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function mountApp() {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { controller, ...r };
}

/** Bloco grande (≥6 linhas) que deve COLAPSAR. Linhas com conteúdo identificável. */
const BIG = ['um', 'dois', 'tres', 'quatro', 'cinco', 'seis', 'sete'].join('\n');

describe('App — PASTE-COLAPSO: bloco grande vira CHIP (EST-PASTE-COLLAPSE)', () => {
  it('cola ≥6 linhas ⇒ CHIP `[texto colado …]` no composer; o texto cru NÃO aparece', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    await pressUntil(
      () => stdin.write(`${PASTE_START}${BIG}${PASTE_END}`),
      () => plain(lastFrame() ?? '').includes('texto colado'),
    );

    const frame = plain(lastFrame() ?? '');
    // o CHIP está visível…
    expect(frame).toContain('texto colado');
    expect(frame).toContain('linhas]');
    // …e o conteúdo CRU multi-linha NÃO foi despejado no composer.
    expect(frame).not.toContain('quatro');
    expect(frame).not.toContain('sete');
    // colar não submete.
    expect(submitSpy).not.toHaveBeenCalled();
    submitSpy.mockRestore();
    unmount();
  });

  it('Enter depois do chip SUBMETE o conteúdo COMPLETO expandido (não o label)', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    // cola UMA vez (e segura até o chip aparecer).
    await pressUntil(
      () => stdin.write(`${PASTE_START}${BIG}${PASTE_END}`),
      () => plain(lastFrame() ?? '').includes('texto colado'),
    );
    // Enter LIMPO ⇒ expande o chip e submete o bloco INTEIRO.
    await pressUntil(
      () => stdin.write('\r'),
      () => submitSpy.mock.calls.length > 0,
    );
    const submitted = submitSpy.mock.calls[0]?.[0] as string;
    // o conteúdo cheio chegou ao submit (todas as linhas), NÃO o `[texto colado …]`.
    expect(submitted).toContain('um');
    expect(submitted).toContain('quatro');
    expect(submitted).toContain('sete');
    expect(submitted).not.toContain('texto colado');
    submitSpy.mockRestore();
    unmount();
  });

  it('NÃO-REGRESSÃO: bloco PEQUENO (2 linhas) NÃO colapsa — vai inline', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    await pressUntil(
      () => stdin.write(`${PASTE_START}alpha\nbeta${PASTE_END}`),
      () => plain(lastFrame() ?? '').includes('beta'),
    );
    const frame = plain(lastFrame() ?? '');
    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');
    expect(frame).not.toContain('texto colado'); // pequeno ⇒ sem chip
    expect(submitSpy).not.toHaveBeenCalled();
    submitSpy.mockRestore();
    unmount();
  });

  it('backspace sobre o chip o remove INTEIRO (unidade atômica)', async () => {
    const { stdin, lastFrame, unmount } = mountApp();
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    await pressUntil(
      () => stdin.write(`${PASTE_START}${BIG}${PASTE_END}`),
      () => plain(lastFrame() ?? '').includes('texto colado'),
    );
    // um único backspace (DEL, 0x7f) com o cursor logo após o chip ⇒ some o chip todo.
    await pressUntil(
      () => stdin.write('\x7f'),
      () => !plain(lastFrame() ?? '').includes('texto colado'),
    );
    expect(plain(lastFrame() ?? '')).not.toContain('texto colado');
    unmount();
  });
});
