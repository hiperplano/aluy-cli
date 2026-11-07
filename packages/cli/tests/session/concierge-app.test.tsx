// ADR 0006 — Concierge na TUI: a conversa NUNCA espera o trabalho.
//   • mensagem durante um turno vivo é respondida na hora (não vai à fila nem ao encaixe cego);
//   • Esc NÃO interrompe tarefa (só limpa o rascunho);
//   • correção vai à tarefa pelo `task_send` (injectInput), e o Concierge diz honestamente;
//   • aprovação é caixa de entrada: o chat segue e `/a` resolve;
//   • modo clássico inalterado (Esc interrompe; o Concierge nem é chamado).

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ConciergeModel,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { ConciergeRuntime } from '../../src/session/concierge-runtime.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const CR = '\r';
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => (s ?? '').replace(ANSI, '');

const ports = (): ToolPorts => ({
  fs: { readFile: async () => '', writeFile: async () => {}, exists: async () => false },
  shell: { exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) },
  search: { search: async () => [] },
});

const defer = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function type(s: { stdin: { write(x: string): void } }, text: string): Promise<void> {
  s.stdin.write(text);
  await new Promise((r) => setTimeout(r, 40));
  s.stdin.write(CR);
}

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
const toolCall = (name: string, input: Record<string, unknown>): string =>
  `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;

function build(opts: {
  mode: 'concierge' | 'classic';
  iters: (turn: number) => string;
  gates?: (turn: number) => Promise<void> | undefined;
  concierge: (msg: string) => ModelCallResult;
}) {
  let controllerRef: SessionController | null = null;
  let turn = 0;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      const sink = controllerRef!.sink;
      sink.onStart?.();
      sink.onDelta?.('');
      const t = turn++;
      const g = opts.gates?.(t);
      if (g) await g;
      return { request_id: 'r', content: opts.iters(t), finish_reason: 'stop' };
    },
  };
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: ports(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  controllerRef = controller;
  controller.dismissBoot();
  const conciergeCalls: string[] = [];
  const cmodel: ConciergeModel = {
    call: async ({ messages }) => {
      const last = String(messages[messages.length - 1]!.content);
      const msg = /Mensagem do dono: (.*)$/s.exec(last)?.[1] ?? last;
      conciergeCalls.push(msg);
      return opts.concierge(msg);
    },
  };
  const rt = new ConciergeRuntime({ sink: controller, model: cmodel });
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: ENV })}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        concierge={rt}
        initialConversation={opts.mode}
      />
    </ThemeProvider>,
  );
  return { controller, rt, conciergeCalls, ...r };
}

const text = (content: string, calls: ModelCallResult['tool_calls'] = []): ModelCallResult => ({
  request_id: 'c',
  content,
  finish_reason: 'stop',
  ...(calls.length ? { tool_calls: calls } : {}),
});

describe('Concierge na TUI — a conversa nunca espera o trabalho', () => {
  it('mensagem durante um turno vivo é respondida na hora; o turno segue; nada vai à fila', async () => {
    const g0 = defer();
    const s = build({
      mode: 'concierge',
      iters: () => 'pronto.',
      gates: (t) => (t === 0 ? g0.promise : undefined),
      concierge: (m) =>
        /trabalho/.test(m)
          ? text('Iniciei.', [{ id: '1', name: 'task_start', input: { goal: 'fazer o trabalho' } }])
          : text('Está rodando, t1 em chamada ao modelo.'),
    });
    await type(s, 'faça o trabalho');
    await waitFor(() => s.controller.current.phase === 'streaming');
    expect(s.rt.registry.get('t1')!.status).toBe('running');

    await type(s, 'como está?');
    await waitFor(() => plain(s.lastFrame()).includes('Está rodando, t1'));
    // O turno NÃO foi tocado: segue streaming, e a mensagem não foi para fila/encaixe.
    expect(s.controller.current.phase).toBe('streaming');
    expect(s.controller.current.pendingInjects.length).toBe(0);
    expect(plain(s.lastFrame())).not.toContain('na fila');
    expect(s.conciergeCalls).toEqual(['faça o trabalho', 'como está?']);

    g0.resolve();
    await waitFor(() => s.rt.registry.get('t1')!.status === 'done');
    s.unmount();
  });

  it('Esc NUNCA interrompe a tarefa: só limpa o rascunho', async () => {
    const g0 = defer();
    const s = build({
      mode: 'concierge',
      iters: () => 'pronto.',
      gates: (t) => (t === 0 ? g0.promise : undefined),
      concierge: () => text('Iniciei.', [{ id: '1', name: 'task_start', input: { goal: 'g' } }]),
    });
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');
    await type(s, 'faça o trabalho');
    await waitFor(() => s.controller.current.phase === 'streaming');

    // Esc com o composer VAZIO (no clássico isto PARAVA o turno).
    s.stdin.write(ESC);
    await new Promise((r) => setTimeout(r, 150));
    // Esc com rascunho: só apaga.
    s.stdin.write('rascunho qualquer');
    await new Promise((r) => setTimeout(r, 60));
    s.stdin.write(ESC);
    await new Promise((r) => setTimeout(r, 150));

    expect(interruptSpy).not.toHaveBeenCalled();
    expect(s.controller.current.phase).toBe('streaming');
    expect(s.rt.registry.get('t1')!.status).toBe('running');
    expect(plain(s.lastFrame())).not.toContain('rascunho qualquer');

    g0.resolve();
    await waitFor(() => s.rt.registry.get('t1')!.status === 'done');
    s.unmount();
  });

  it('correção vai à tarefa certa pelo task_send (fila de injeção), sem reiniciar o turno', async () => {
    const g0 = defer();
    const s = build({
      mode: 'concierge',
      iters: () => 'pronto.',
      gates: (t) => (t === 0 ? g0.promise : undefined),
      concierge: (m) =>
        /async/.test(m)
          ? text('Enviei à t1.', [
              {
                id: '2',
                name: 'task_send',
                input: { task_id: 't1', message: 'usar async/await (correção)' },
              },
            ])
          : text('Iniciei.', [{ id: '1', name: 'task_start', input: { goal: 'g' } }]),
    });
    const injectSpy = vi.spyOn(s.controller, 'injectInput');
    await type(s, 'faça o trabalho');
    await waitFor(() => s.controller.current.phase === 'streaming');
    await type(s, 'use async');
    await waitFor(() => injectSpy.mock.calls.length > 0);
    // Quem decidiu foi o Concierge (o texto injetado é o do task_send, não o cru do dono).
    expect(injectSpy).toHaveBeenCalledWith('root', 'usar async/await (correção)');
    expect(s.conciergeCalls).toContain('use async');
    expect(s.controller.current.phase).toBe('streaming');
    g0.resolve();
    s.unmount();
  });

  it('aprovação é caixa de entrada: o chat segue e /a resolve só a tarefa dona', async () => {
    const s = build({
      mode: 'concierge',
      iters: (t) => (t === 0 ? toolCall('run_command', { command: 'echo oi' }) : 'feito.'),
      concierge: (m) =>
        /trabalho/.test(m)
          ? text('Iniciei.', [{ id: '1', name: 'task_start', input: { goal: 'g' } }])
          : text('Aguardando sua aprovação, use /a.'),
    });
    await type(s, 'faça o trabalho');
    await waitFor(() => s.controller.current.phase === 'asking');
    expect(s.rt.registry.get('t1')!.status).toBe('waiting_approval');
    expect(plain(s.lastFrame())).toContain('/a aprova');

    // O chat NÃO está bloqueado pela caixa: pergunta e recebe resposta.
    await type(s, 'e agora?');
    await waitFor(() => plain(s.lastFrame()).includes('Aguardando sua aprovação'));
    expect(s.controller.current.phase).toBe('asking'); // a aprovação segue pendente

    await type(s, '/a');
    await waitFor(() => s.controller.current.phase !== 'asking');
    await waitFor(() => s.rt.registry.get('t1')!.status === 'done');
    s.unmount();
  });
});

describe('Modo clássico inalterado', () => {
  it('Esc com tudo vazio INTERROMPE o turno e o Concierge nem é chamado', async () => {
    const g0 = defer();
    const s = build({
      mode: 'classic',
      iters: () => 'pronto.',
      gates: (t) => (t === 0 ? g0.promise : undefined),
      concierge: () => text('não deveria ser chamado'),
    });
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');
    void s.controller.submit('objetivo');
    await waitFor(() => s.controller.current.phase === 'streaming');
    s.stdin.write(ESC);
    await waitFor(() => interruptSpy.mock.calls.length > 0);
    expect(interruptSpy).toHaveBeenCalled();
    expect(s.conciergeCalls).toEqual([]);
    g0.resolve();
    s.unmount();
  });

  it('mensagem mid-turn continua indo ao encaixe (injectInput), sem o Concierge', async () => {
    const g0 = defer();
    const s = build({
      mode: 'classic',
      iters: () => 'pronto.',
      gates: (t) => (t === 0 ? g0.promise : undefined),
      concierge: () => text('não deveria ser chamado'),
    });
    const injectSpy = vi.spyOn(s.controller, 'injectInput');
    void s.controller.submit('objetivo');
    await waitFor(() => s.controller.current.phase === 'streaming');
    await type(s, 'mais uma coisa');
    await waitFor(() => injectSpy.mock.calls.length > 0);
    expect(s.conciergeCalls).toEqual([]);
    g0.resolve();
    s.unmount();
  });
});
