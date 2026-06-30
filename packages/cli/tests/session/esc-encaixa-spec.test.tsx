// ESPEC FINAL DO DONO (corrigida ao vivo) — o ESC durante o turno vivo NUNCA para enquanto
// houver qualquer pendência (fila visível OU injects em "encaixando…"). Ele só ACELERA o
// encaixe. O ESC SÓ para o turno quando TUDO está vazio (fila vazia E sem injects pendentes
// E composer vazio). F8/Ctrl+C seguem hard-stop (não testados aqui — inalterados).
//
// Harness de TURNO VIVO espelhado de queue-ask-esc.test.tsx (fake ModelCaller gateado):
//   • texto puro digitado mid-turn + UM ESC ⇒ `controller.interrupt` NÃO chamado
//     (msg preservada via inject; fase segue `streaming`).
//   • TUDO vazio (sem fila, sem inject, composer vazio) + ESC ⇒ `interrupt` É chamado (freio).
//   • o ESC com pendência RODA o encaixe (injectInput('root') p/ itens de texto puro da fila)
//     — prova que "acelera".

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
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const CR = '\r';
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => (s ?? '').replace(ANSI, '');

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
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return [];
    },
  };
  return { fs, shell, search };
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function buildSession(opts: {
  iters: (turn: number) => string;
  gates?: (turn: number) => Promise<void> | undefined;
}) {
  let controllerRef: SessionController | null = null;
  let turn = 0;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      const sink = controllerRef!.sink;
      sink.onStart?.();
      const t = turn++;
      const g = opts.gates?.(t);
      if (g) await g;
      return { request_id: 'r', content: opts.iters(t), finish_reason: 'stop' };
    },
  };
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  controllerRef = controller;
  controller.dismissBoot();

  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  return { controller, ...r };
}

describe('ESPEC FINAL — ESC só PARA com tudo vazio; senão ACELERA o encaixe', () => {
  it('texto puro digitado mid-turn + UM ESC ⇒ interrupt NÃO chamado (msg preservada, fase segue streaming)', async () => {
    const g0 = defer();
    const s = buildSession({
      iters: () => 'trabalhando…',
      gates: (t) => (t === 0 ? g0.promise : undefined),
    });
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    // Digita TEXTO PURO + Enter ⇒ encaixa (injectInput) ⇒ pendingInjects > 0.
    await pressUntil(
      () => s.stdin.write('como está o build?'),
      () => plain(s.lastFrame()).includes('como está o build?'),
    );
    await pressUntil(
      () => s.stdin.write(CR),
      () =>
        s.controller.current.pendingInjects.length > 0 ||
        plain(s.lastFrame()).includes('na fila'),
    );
    expect(s.controller.current.pendingInjects.length).toBeGreaterThan(0);

    // UM ESC com inject pendente ⇒ ACELERA (não para). interrupt NÃO chamado.
    s.stdin.write(ESC);
    await new Promise((r) => setTimeout(r, 120));

    expect(interruptSpy).not.toHaveBeenCalled();
    expect(s.controller.current.phase).toBe('streaming');

    g0.resolve();
    interruptSpy.mockRestore();
    s.unmount();
  });

  it('TUDO vazio (sem fila, sem inject, composer vazio) + ESC ⇒ interrupt É chamado (freio intacto)', async () => {
    const g0 = defer();
    const s = buildSession({
      iters: () => 'trabalhando…',
      gates: (t) => (t === 0 ? g0.promise : undefined),
    });
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    // Nada digitado, nada na fila, nada injetado.
    expect(s.controller.current.pendingInjects.length).toBe(0);
    s.stdin.write(ESC);
    await waitFor(() => interruptSpy.mock.calls.length > 0);

    expect(interruptSpy).toHaveBeenCalled();

    g0.resolve();
    interruptSpy.mockRestore();
    s.unmount();
  });

  it('ESC com item de TEXTO PURO na FILA ⇒ RODA o encaixe (injectInput(root)) — prova que acelera, NÃO para', async () => {
    const g0 = defer();
    const s = buildSession({
      // iter 0 gateada ⇒ turno VIVO multi-iteração; um run_command destrutivo abre ask
      //   p/ que o texto puro digitado caia na FILA visível (enqueueOrInject sob ask
      //   roteia texto puro p/ a fila quando não pode injetar mid-ask). Aqui simplificamos:
      //   forçamos a fila enfileirando enquanto o turno está vivo via Enter, depois ESC.
      iters: (t) => (t === 0 ? toolCall('read_file', { path: 'x' }) : 'pronto.'),
      gates: (t) => (t === 0 ? g0.promise : undefined),
    });
    const injectSpy = vi.spyOn(s.controller, 'injectInput');
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    // Digita texto puro + Enter ⇒ encaixa via injectInput('root') (mid-turn) ⇒ inject pendente.
    await pressUntil(
      () => s.stdin.write('acelera isso'),
      () => plain(s.lastFrame()).includes('acelera isso'),
    );
    await pressUntil(
      () => s.stdin.write(CR),
      () => injectSpy.mock.calls.some((c) => c[0] === 'root' && c[1] === 'acelera isso'),
    );

    // ESC com inject pendente ⇒ NÃO para (acelera). interrupt NÃO chamado.
    s.stdin.write(ESC);
    await new Promise((r) => setTimeout(r, 120));

    expect(injectSpy.mock.calls.some((c) => c[0] === 'root' && c[1] === 'acelera isso')).toBe(true);
    expect(interruptSpy).not.toHaveBeenCalled();

    g0.resolve();
    injectSpy.mockRestore();
    interruptSpy.mockRestore();
    s.unmount();
  });
});
