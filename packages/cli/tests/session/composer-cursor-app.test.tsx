// EST-0948 (composer/sessão) — EDIÇÃO COM CURSOR na App, dirigida CHAR-A-CHAR pela
// stdin (sequências cruas de terminal — o mesmo caminho de um PTY real passa pelo
// `useInput` do Ink). Prova o DoD: digitar, ←←← pro meio, INSERIR e APAGAR no meio,
// Home/End (Ctrl+A/Ctrl+E readline) — e o objetivo SUBMETIDO reflete a edição
// posicional (não o append-only de antes). Também a não-regressão do batched-Enter.

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

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const PLACEHOLDER = 'digite um objetivo';

// Sequências CRUAS de terminal (o que um PTY entrega no stdin).
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const CTRL_A = '\x01'; // Home (readline)
const CTRL_E = '\x05'; // End (readline)
const ALT_LEFT = '\x1b[1;3D'; // word-left
const BACKSPACE = '\x7f'; // a Backspace física na maioria dos terminais/xrdp
const ENTER = '\r';

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

/**
 * Reescreve um chunk até a condição assentar — a stdin-mock da ink-testing-library
 * guarda só a ÚLTIMA escrita e o listener do Ink só attacha pós-commit (ver
 * batch-enter.test). Para teclas de MOVIMENTO/EDIÇÃO (idempotentes só enquanto a
 * condição não vale) isto é seguro: paramos no 1º efeito observado.
 */
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

/**
 * Garante que o listener de stdin do Ink JÁ ATTACHOU (ele só liga num efeito
 * pós-commit do 1º render). Escreve um sentinela `~`, espera ecoar, e o APAGA com
 * backspace — deixando o composer vazio mas com o listener vivo. A partir daí cada
 * `write(ch)` é entregue UMA vez (sem reescrever o mesmo char ⇒ sem duplicação).
 */
async function ensureListener(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
): Promise<void> {
  await pressUntil(
    () => stdin.write('~'),
    () => plain(lastFrame() ?? '').includes('~'),
  );
  stdin.write(BACKSPACE);
  await new Promise((r) => setTimeout(r, 15));
}

/**
 * Digita um texto char-a-char (cada char UMA vez, com settle) — assim o cursor anda
 * com o append e o estado é determinístico. Verifica o ECO cumulativo no fim.
 */
async function typeText(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  text: string,
): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 20));
  }
  await waitFor(() => plain(lastFrame() ?? '').includes(text));
}

/**
 * Bate UMA tecla (sequência crua) e espera assentar. Com o listener já attachado
 * (ensureListener), um único write é entregue uma vez — sem reescrever (que
 * duplicaria a edição). Settle curto p/ o commit do React.
 */
async function tap(stdin: { write: (s: string) => void }, seq: string): Promise<void> {
  stdin.write(seq);
  await new Promise((r) => setTimeout(r, 25));
}

describe('App — edição com CURSOR (char-a-char via stdin, EST-0948)', () => {
  it('←←× pro meio + INSERIR ⇒ o caractere entra NO MEIO (não no fim)', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));
    await ensureListener(stdin, lastFrame);

    // digita "hllo" (faltando o "e").
    await typeText(stdin, lastFrame, 'hllo');
    expect(plain(lastFrame() ?? '')).toContain('hllo');

    // move o cursor 3× p/ a esquerda: de depois do 2º "l"(4) → entre h e l (pos 1).
    await tap(stdin, LEFT);
    await tap(stdin, LEFT);
    await tap(stdin, LEFT);
    // insere "e" — deve cair entre o "h" e o 1º "l" ⇒ "hello".
    await tap(stdin, 'e');
    await waitFor(() => plain(lastFrame() ?? '').includes('hello'));

    // Enter submete o objetivo EDITADO.
    await tap(stdin, ENTER);
    await waitFor(() => submitSpy.mock.calls.length > 0);
    expect(submitSpy.mock.calls[0]?.[0]).toBe('hello');
    submitSpy.mockRestore();
    unmount();
  });

  it('← pro meio + BACKSPACE ⇒ apaga o char ANTES do cursor (não o último)', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));
    await ensureListener(stdin, lastFrame);

    // "abXc": queremos apagar o "X" do meio (não o "c" do fim).
    await typeText(stdin, lastFrame, 'abXc');
    // ← uma vez: cursor de 4 (fim) → 3 (entre X e c). Backspace apaga o "X" (pos-1).
    await tap(stdin, LEFT);
    await tap(stdin, BACKSPACE);
    await waitFor(
      () => plain(lastFrame() ?? '').includes('abc') && !plain(lastFrame() ?? '').includes('abX'),
    );

    await tap(stdin, ENTER);
    await waitFor(() => submitSpy.mock.calls.length > 0);
    expect(submitSpy.mock.calls[0]?.[0]).toBe('abc');
    submitSpy.mockRestore();
    unmount();
  });

  it('Home (Ctrl+A) leva o cursor ao INÍCIO ⇒ inserir prepende', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));
    await ensureListener(stdin, lastFrame);

    await typeText(stdin, lastFrame, 'mundo');
    // Ctrl+A → início (pos 0).
    await tap(stdin, CTRL_A);
    // insere "oi " no começo ⇒ "oi mundo".
    await typeText(stdin, lastFrame, 'oi ');
    await tap(stdin, ENTER);
    await waitFor(() => submitSpy.mock.calls.length > 0);
    expect(submitSpy.mock.calls[0]?.[0]).toBe('oi mundo');
    submitSpy.mockRestore();
    unmount();
  });

  it('Home (Ctrl+A) + End (Ctrl+E): volta ao fim ⇒ inserir faz append', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));
    await ensureListener(stdin, lastFrame);

    await typeText(stdin, lastFrame, 'abc');
    await tap(stdin, CTRL_A); // início
    await tap(stdin, CTRL_E); // fim de novo
    // inserir "d" deve cair no FIM ⇒ "abcd" (prova que o End levou o cursor ao fim).
    await tap(stdin, 'd');
    await waitFor(() => plain(lastFrame() ?? '').includes('abcd'));
    await tap(stdin, ENTER);
    await waitFor(() => submitSpy.mock.calls.length > 0);
    expect(submitSpy.mock.calls[0]?.[0]).toBe('abcd');
    submitSpy.mockRestore();
    unmount();
  });

  it('Alt+← (palavra) salta a palavra inteira ⇒ inserir cai no INÍCIO da última palavra', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));
    await ensureListener(stdin, lastFrame);

    await typeText(stdin, lastFrame, 'liste arquivos');
    // Alt+← do fim ⇒ início de "arquivos" (pos 6). Inserir "os " ⇒ "liste os arquivos".
    await tap(stdin, ALT_LEFT);
    await typeText(stdin, lastFrame, 'os ');
    await tap(stdin, ENTER);
    await waitFor(() => submitSpy.mock.calls.length > 0);
    expect(submitSpy.mock.calls[0]?.[0]).toBe('liste os arquivos');
    submitSpy.mockRestore();
    unmount();
  });

  it('→ depois de ← reposiciona: insere no lugar certo de volta', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));
    await ensureListener(stdin, lastFrame);

    // "abd": cursor 3. ←← ⇒ cursor 1. → ⇒ cursor 2 (entre b e d). insere "c" ⇒ "abcd".
    await typeText(stdin, lastFrame, 'abd');
    await tap(stdin, LEFT);
    await tap(stdin, LEFT);
    await tap(stdin, RIGHT);
    await tap(stdin, 'c');
    await waitFor(() => plain(lastFrame() ?? '').includes('abcd'));
    await tap(stdin, ENTER);
    await waitFor(() => submitSpy.mock.calls.length > 0);
    expect(submitSpy.mock.calls[0]?.[0]).toBe('abcd');
    submitSpy.mockRestore();
    unmount();
  });
});

describe('App — NÃO-REGRESSÃO do composer com o cursor (EST-0948)', () => {
  it('batched-Enter (xrdp/paste) ainda submete a linha em lote', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);
    await pressUntil(
      () => stdin.write('liste arquivos\r'),
      () => submitSpy.mock.calls.length > 0,
    );
    expect(submitSpy.mock.calls[0]?.[0]).toBe('liste arquivos');
    submitSpy.mockRestore();
    unmount();
  });

  it('digitação simples (sem mover) ainda faz append e submete o texto íntegro', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));
    await ensureListener(stdin, lastFrame);
    await typeText(stdin, lastFrame, 'ola');
    await pressUntil(
      () => stdin.write(ENTER),
      () => submitSpy.mock.calls.length > 0,
    );
    expect(submitSpy.mock.calls[0]?.[0]).toBe('ola');
    submitSpy.mockRestore();
    unmount();
  });
});

// EST-0965 — backspace EMBUTIDO num chunk MISTO no composer IDLE (mesma FONTE ÚNICA
// `applyTypedChunk` do type-ahead). Em xrdp/SSH texto+backspace chegam GRUDADOS num
// único `read`; antes o byte vinha literal e o texto ficava intacto (o bug do PTY).
describe('App — backspace EMBUTIDO no chunk (idle) — EST-0965', () => {
  it('`abc` + backspace num único write ⇒ submete `ab` (não `abc`)', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));
    // chunk MISTO texto+backspace, e então Enter num 2º write (separado, p/ não reescrever).
    await pressUntil(
      () => stdin.write('abc' + BACKSPACE),
      () => plain(lastFrame() ?? '').includes('ab') && !plain(lastFrame() ?? '').includes('abc'),
    );
    await pressUntil(
      () => stdin.write(ENTER),
      () => submitSpy.mock.calls.length > 0,
    );
    expect(submitSpy.mock.calls[0]?.[0]).toBe('ab');
    submitSpy.mockRestore();
    unmount();
  });

  it('texto+backspace+Enter TUDO num chunk ⇒ submete a linha com backspace aplicado', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);
    // `abc\x7f\r` num único chunk: backspace tira o `c`, `\r` submete ⇒ `ab`.
    await pressUntil(
      () => stdin.write('abc' + BACKSPACE + ENTER),
      () => submitSpy.mock.calls.length > 0,
    );
    expect(submitSpy.mock.calls[0]?.[0]).toBe('ab');
    submitSpy.mockRestore();
    unmount();
  });
});
