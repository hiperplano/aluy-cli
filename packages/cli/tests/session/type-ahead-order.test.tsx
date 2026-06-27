// EST-0982 — REGRESSÃO dos 4 bugs da auditoria do type-ahead (#253/#265 família). Portados
// dos repros READ-ONLY de `type-ahead-audit-repro.test.tsx` (branch audit-typeahead), mas
// aqui com as expectativas CORRIGIDAS (passam SÓ com o fix). Reusa o MESMO harness do
// type-ahead.test.tsx (gatedStreamingCaller).
//
//   P0-1 — INVERSÃO DE ORDEM: `/compact` enfileirado + texto depois ⇒ ordem PRESERVADA
//          (o texto NÃO encaixa antes; enfileira atrás do /compact). Fila vazia + texto puro
//          ⇒ AINDA encaixa mid-turn (não regride #253).
//   P1-1 — `/clear` enfileirado ⇒ a fila ESVAZIA; itens posteriores NÃO re-semeiam.
//   P1-2 — esc/abort ⇒ a fila ESVAZIA.
//   P2-1 — `/help` mid-turn ⇒ RODA paralelo (não enfileira); `/compact` mid-turn ⇒ enfileira.

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
import type { SlashCommand } from '../../src/slash/commands.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return (s ?? '').replace(ANSI, '');
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

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function gatedStreamingCaller(opts: {
  sink: () => SessionController['sink'];
  nextGate: () => Promise<void>;
  onCall: (goalMessages: number, firstGoal: string) => void;
}): ModelCaller {
  return {
    async call(args): Promise<ModelCallResult> {
      const userMsgs = args.messages.filter((m) => m.role === 'user');
      opts.onCall(args.messages.length, (userMsgs[0]?.content as string) ?? '');
      const sink = opts.sink();
      sink.onStart?.();
      sink.onDelta('trabalhando…');
      await opts.nextGate();
      sink.onDone?.();
      return { request_id: 'r', content: 'trabalhando…', finish_reason: 'stop' };
    },
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

function buildSession(opts: { onCommand?: (command: SlashCommand, args: string) => void } = {}) {
  const gates = [defer(), defer(), defer(), defer(), defer()];
  let gateIdx = 0;
  const calls: { messages: number; firstGoal: string }[] = [];
  let controllerRef: SessionController | null = null;

  const model = gatedStreamingCaller({
    sink: () => controllerRef!.sink,
    nextGate: () => gates[gateIdx++]!.promise,
    onCall: (n, g) => calls.push({ messages: n, firstGoal: g }),
  });

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
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        {...(opts.onCommand ? { onCommand: opts.onCommand } : {})}
      />
    </ThemeProvider>,
  );
  return {
    controller,
    calls,
    resolveGate: (i: number) => gates[i]!.resolve(),
    ...r,
  };
}

const CR = '\r'; // Enter limpo

describe('EST-0982 — type-ahead: ordem + clear/esc + paralelos read-only', () => {
  // ── P0-1 — INVERSÃO DE ORDEM consertada ─────────────────────────────────────────
  // `/compact` (Enter) e DEPOIS `contexto tardio` (Enter). ANTES: o texto puro ENCAIXAVA
  // AGORA (injectInput) furando o /compact que já estava na fila ⇒ inversão. AGORA: com a
  // fila NÃO-vazia, o texto também ENFILEIRA (atrás do /compact) — a ordem digitada (FIFO
  // global) é preservada. injectInput NÃO é chamado com o texto tardio.
  it('P0-1 — texto-puro digitado APÓS um /slash enfileirado ENFILEIRA (não fura o que veio antes)', async () => {
    const s = buildSession({ onCommand: vi.fn() });
    const injectSpy = vi.spyOn(s.controller, 'injectInput');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    // 1º digita um MUTADOR (vai pra fila)…
    await pressUntil(
      () => s.stdin.write('/compact'),
      () => plain(s.lastFrame()).includes('/compact'),
    );
    s.stdin.write(CR);
    await waitFor(() => plain(s.lastFrame()).includes('na fila'));

    // …2º digita TEXTO PURO. Como a fila NÃO está vazia, ENFILEIRA atrás do /compact.
    await pressUntil(
      () => s.stdin.write('contexto tardio'),
      () => plain(s.lastFrame()).includes('contexto tardio'),
    );
    s.stdin.write(CR);

    // Os DOIS estão na fila agora (ordem preservada) — e o texto NÃO foi injetado mid-turn.
    await waitFor(() => plain(s.lastFrame()).includes('2 na fila'));
    expect(injectSpy.mock.calls.some((c) => c[0] === 'root' && c[1] === 'contexto tardio')).toBe(
      false,
    );
    expect(plain(s.lastFrame())).toContain('2 na fila');

    s.resolveGate(0);
    injectSpy.mockRestore();
    s.unmount();
  });

  // ── P0-1 (não-regressão) — fila VAZIA + texto puro ⇒ AINDA encaixa mid-turn (#253) ─
  it('P0-1 — fila VAZIA + texto puro ⇒ ENCAIXA mid-turn via injectInput (não regride #253)', async () => {
    const s = buildSession();
    const injectSpy = vi.spyOn(s.controller, 'injectInput');
    const submitSpy = vi.spyOn(s.controller, 'submit');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('mais contexto'),
      () => plain(s.lastFrame()).includes('mais contexto'),
    );
    s.stdin.write(CR);

    // Encaixou AGORA (fila estava vazia) — injectInput('root', …) e SEM virar "na fila".
    await waitFor(() => injectSpy.mock.calls.some((c) => c[1] === 'mais contexto'));
    expect(plain(s.lastFrame())).not.toContain('na fila');
    // NÃO virou submit concorrente.
    expect(submitSpy.mock.calls.some((c) => c[0] === 'mais contexto')).toBe(false);

    s.resolveGate(0);
    injectSpy.mockRestore();
    submitSpy.mockRestore();
    s.unmount();
  });

  // ── P1-1 — `/clear` enfileirado ESVAZIA a fila (itens posteriores não re-semeiam) ──
  it('P1-1 — /clear enfileirado DESCARTA a fila: itens posteriores NÃO re-semeiam o contexto', async () => {
    const onCommand = vi.fn();
    const s = buildSession({ onCommand });
    const bangSpy = vi.spyOn(s.controller, 'runBang').mockResolvedValue();

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    // Enfileira /clear (mutador) e DEPOIS um !bang.
    await pressUntil(
      () => s.stdin.write('/clear'),
      () => plain(s.lastFrame()).includes('/clear'),
    );
    s.stdin.write(CR);
    await waitFor(() => plain(s.lastFrame()).includes('na fila'));
    await pressUntil(
      () => s.stdin.write('!echo depois-do-clear'),
      () => plain(s.lastFrame()).includes('!echo depois-do-clear'),
    );
    s.stdin.write(CR);
    await waitFor(() => plain(s.lastFrame()).includes('2 na fila'));

    // Termina o turno: a fila drena. /clear roda (onCommand id=clear) e ESVAZIA o resto da
    // fila — o !bang enfileirado APÓS o /clear NÃO sobrevive (não re-semeia o contexto limpo).
    s.resolveGate(0);
    await waitFor(() => onCommand.mock.calls.some((c) => (c[0] as SlashCommand).id === 'clear'));
    // A fila fica vazia (sem "na fila") e o bang NUNCA roda.
    await waitFor(() => !plain(s.lastFrame()).includes('na fila'));
    await new Promise((r) => setTimeout(r, 40)); // dá tempo de um (eventual, bug) drain ocorrer
    expect(onCommand.mock.calls.some((c) => (c[0] as SlashCommand).id === 'clear')).toBe(true);
    expect(bangSpy.mock.calls.some((c) => c[0] === 'echo depois-do-clear')).toBe(false);

    bangSpy.mockRestore();
    s.unmount();
  });

  // ── P1-2 — esc DESCARTA a fila ──────────────────────────────────────────────────
  it('P1-2 — esc interrompe o turno E LIMPA a fila (itens enfileirados não auto-submetem)', async () => {
    const s = buildSession();
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('!echo abandonado'),
      () => plain(s.lastFrame()).includes('!echo abandonado'),
    );
    s.stdin.write(CR);
    await waitFor(() => plain(s.lastFrame()).includes('na fila'));

    // esc INTERROMPE o turno (o usuário "desistiu") — e a fila é DESCARTADA junto.
    await pressUntil(
      () => s.stdin.write(ESC),
      () => interruptSpy.mock.calls.length > 0,
    );

    expect(interruptSpy).toHaveBeenCalled();
    await waitFor(() => !plain(s.lastFrame()).includes('na fila'));
    expect(plain(s.lastFrame())).not.toContain('na fila');

    s.resolveGate(0);
    interruptSpy.mockRestore();
    s.unmount();
  });

  // ── P2-1 — `/help` (read-only) roda PARALELO mid-turn; `/compact` (mutador) enfileira ─
  it('P2-1 — /help mid-turn RODA paralelo (não enfileira) via runCommand/onCommand', async () => {
    const onCommand = vi.fn();
    const s = buildSession({ onCommand });
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');
    const submitSpy = vi.spyOn(s.controller, 'submit');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('/help'),
      () => plain(s.lastFrame()).includes('/help'),
    );
    await pressUntil(
      () => s.stdin.write(CR),
      () => onCommand.mock.calls.some((c) => (c[0] as SlashCommand).id === 'help'),
    );

    // RODOU JÁ (paralelo): onCommand recebeu `help`. NÃO enfileirou, NÃO interrompeu,
    // NÃO criou submit/turno novo — o trabalho segue em streaming.
    expect(onCommand.mock.calls.some((c) => (c[0] as SlashCommand).id === 'help')).toBe(true);
    expect(plain(s.lastFrame())).not.toContain('na fila');
    expect(s.controller.current.phase).toBe('streaming');
    expect(interruptSpy).not.toHaveBeenCalled();

    s.resolveGate(0);
    interruptSpy.mockRestore();
    submitSpy.mockRestore();
    s.unmount();
  });

  it('P2-1 — /compact (MUTADOR) mid-turn AINDA ENFILEIRA (não roda paralelo)', async () => {
    const onCommand = vi.fn();
    const s = buildSession({ onCommand });

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('/compact'),
      () => plain(s.lastFrame()).includes('/compact'),
    );
    s.stdin.write(CR);

    // Enfileirou ("na fila") — NÃO rodou paralelo (onCommand NÃO recebeu compact mid-turn).
    await waitFor(() => plain(s.lastFrame()).includes('na fila'));
    expect(onCommand.mock.calls.some((c) => (c[0] as SlashCommand).id === 'compact')).toBe(false);

    s.resolveGate(0);
    s.unmount();
  });
});
