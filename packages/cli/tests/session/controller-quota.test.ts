// EST-0948 (footer/quota) — o controller carrega a QUOTA do broker (evento `quota`
// via sink) em `state.meta.quota`, atualiza a cada turno, e DEGRADA (mantém
// undefined) quando o broker não manda. Integração focada: dirige o sink direto.

import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine, type Quota } from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { ModelCaller, ModelCallResult } from '@hiperplano/aluy-cli-core';
import type { StreamSink } from '../../src/session/streaming-caller.js';

/**
 * Caller scriptado com QUOTA opcional por turno: emite `onQuota` quando a resposta
 * traz uma quota (simula o broker reportando os headers). `null` ⇒ NÃO emite (o
 * broker não mandou — degrada).
 */
function scriptedCaller(
  responses: readonly { text: string; quota?: Quota | null }[],
  sink: StreamSink,
): ModelCaller {
  let turn = 0;
  return {
    async call(): Promise<ModelCallResult> {
      const r = responses[Math.min(turn, responses.length - 1)] ?? { text: '' };
      turn += 1;
      sink.onStart?.();
      for (const ch of r.text) sink.onDelta(ch);
      sink.onUsage?.({ request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 20 });
      if (r.quota) sink.onQuota?.(r.quota);
      sink.onDone?.();
      return { request_id: 'r', content: r.text, finish_reason: 'stop' };
    },
  };
}

const noPorts = {
  fs: {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  },
  shell: {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
  search: {
    async search() {
      return { matches: [], truncated: {} };
    },
  },
} as const;

function build(responses: readonly { text: string; quota?: Quota | null }[]): SessionController {
  let ctrlRef: SessionController | null = null;
  const sink: StreamSink = {
    onStart: () => ctrlRef?.sink.onStart?.(),
    onDelta: (c) => ctrlRef?.sink.onDelta(c),
    onUsage: (u) => ctrlRef?.sink.onUsage?.(u),
    onQuota: (q) => ctrlRef?.sink.onQuota?.(q),
    onDone: () => ctrlRef?.sink.onDone?.(),
  };
  const controller = new SessionController({
    model: scriptedCaller(responses, sink),
    permission: new PolicyPermissionEngine(),
    ports: noPorts,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
  });
  ctrlRef = controller;
  return controller;
}

const QUOTA: Quota = {
  windows: {
    fiveHour: { used: 42, limit: 100, resetAt: Date.now() + 2 * 60 * 60_000 },
    week: { used: 18, limit: 100, resetAt: Date.now() + 3 * 24 * 60 * 60_000 },
  },
};

describe('SessionController — quota do broker em meta.quota (EST-0948)', () => {
  it('arranca SEM quota (degrada: footer oculto)', () => {
    const c = build([{ text: 'oi.' }]);
    expect(c.current.meta.quota).toBeUndefined();
  });

  it('turno COM quota ⇒ meta.quota populado (footer acende)', async () => {
    const c = build([{ text: 'oi.', quota: QUOTA }]);
    await c.submit('explique');
    expect(c.current.meta.quota?.windows.fiveHour?.used).toBe(42);
    expect(c.current.meta.quota?.windows.week?.used).toBe(18);
  });

  it('turno SEM quota ⇒ meta.quota permanece undefined (degrada)', async () => {
    const c = build([{ text: 'oi.' }]); // sem quota
    await c.submit('explique');
    expect(c.current.meta.quota).toBeUndefined();
  });

  it('atualiza a cada turno (sobrescreve com o valor corrente)', async () => {
    const next: Quota = {
      windows: { fiveHour: { used: 88, limit: 100, resetAt: Date.now() + 60 * 60_000 } },
    };
    const c = build([
      { text: 'um.', quota: QUOTA },
      { text: 'dois.', quota: next },
    ]);
    await c.submit('primeiro');
    expect(c.current.meta.quota?.windows.fiveHour?.used).toBe(42);
    await c.submit('segundo');
    expect(c.current.meta.quota?.windows.fiveHour?.used).toBe(88);
  });

  it('quota NÃO mexe no budget LOCAL (tokens/windowPct seguem do onUsage)', async () => {
    const c = build([{ text: 'oi.', quota: QUOTA }]);
    await c.submit('explique');
    // o budget local vem do onUsage (10+20=30), independente da quota do broker.
    expect(c.current.meta.tokens).toBe(30);
    expect(c.current.meta.quota?.windows.fiveHour?.used).toBe(42);
  });
});
