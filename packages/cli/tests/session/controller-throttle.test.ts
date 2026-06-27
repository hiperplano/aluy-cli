// Anti-flicker (DoD) — o SessionController coalesce as NOTIFICAÇÕES do stream: os
// deltas de token atualizam o estado (texto íntegro), mas os observers (re-render)
// são chamados no máx. 1×/janela do throttle. As TRANSIÇÕES (fim de turno) dão
// flushNow — o último token nunca fica preso. Timer FAKE injetado (determinístico).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';

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
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

/** Caller que faz stream char-a-char no sink do controller (via proxy). */
function scriptedCaller(text: string, sink: StreamSink): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      sink.onStart?.();
      for (const ch of text) sink.onDelta(ch);
      sink.onUsage?.({ request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 20 });
      sink.onDone?.();
      return { request_id: 'r', content: text, finish_reason: 'stop' };
    },
  };
}

/** Relógio fake que coleta os flushes agendados. */
function fakeClock() {
  const pending: Array<() => void> = [];
  return {
    schedule(cb: () => void) {
      pending.push(cb);
      return pending.length;
    },
    clear() {},
    tick() {
      const cbs = pending.splice(0);
      for (const cb of cbs) cb();
    },
  };
}

function build(text: string) {
  const clock = fakeClock();
  let ctrl: SessionController | null = null;
  const sink: StreamSink = {
    onStart: () => ctrl?.sink.onStart?.(),
    onDelta: (c) => ctrl?.sink.onDelta(c),
    onUsage: (u) => ctrl?.sink.onUsage?.(u),
    onDone: () => ctrl?.sink.onDone?.(),
  };
  const controller = new SessionController({
    model: scriptedCaller(text, sink),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { schedule: (cb) => clock.schedule(cb), clear: () => clock.clear() },
  });
  ctrl = controller;
  return { controller, clock };
}

describe('SessionController — throttle do stream (anti-flicker)', () => {
  it('muitos deltas NÃO viram uma notificação por token (flush coalescido)', async () => {
    const text = 'uma resposta com bastante texto para muitos deltas token-a-token aqui.';
    const { controller } = build(text);
    let notifications = 0;
    controller.subscribe(() => notifications++);
    const baseline = notifications; // a subscrição já chamou 1× com o estado inicial
    await controller.submit('explique');
    // Sem throttle seriam ~`text.length` notificações de delta. Com throttle, o nº
    // de notificações é MUITO menor que o nº de tokens (a frequência é limitada).
    const deltaNotifs = notifications - baseline;
    expect(deltaNotifs).toBeLessThan(text.length); // não é 1/token
    // o texto íntegro chegou ao estado mesmo coalescido (nada perdido).
    const aluy = controller.current.blocks.find((b) => b.kind === 'aluy');
    expect(aluy?.kind === 'aluy' && aluy.text).toContain('token-a-token');
  });

  it('o fim do turno dá flushNow: o estado final (streaming=false) é notificado', async () => {
    const { controller } = build('pronto.');
    let lastPhase: string | null = null;
    let lastAluyStreaming: boolean | null = null;
    controller.subscribe((s) => {
      lastPhase = s.phase;
      const a = [...s.blocks].reverse().find((b) => b.kind === 'aluy');
      lastAluyStreaming = a && a.kind === 'aluy' ? a.streaming : null;
    });
    await controller.submit('faça');
    // a ÚLTIMA notificação (não presa no throttle) reflete o turno FECHADO.
    expect(lastPhase).toBe('done');
    expect(lastAluyStreaming).toBe(false);
  });
});
