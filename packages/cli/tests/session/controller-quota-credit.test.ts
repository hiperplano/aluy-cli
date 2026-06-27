// EST-0948 · ADR-0069 — o controller funde o CRÉDITO do `GET /v1/quota` (via
// `quotaFetcher`, path B) em `state.meta.quota.credit` no BOOT e no REFRESH pós-turno,
// PRESERVANDO as janelas que vieram do `usage` (path A). Estado dev vazio ⇒ permanece
// oculto (degrada). Integração focada: `quotaFetcher` mockado (sem rede).

import { describe, expect, it, vi } from 'vitest';
import { PolicyPermissionEngine, type Quota } from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { ModelCaller, ModelCallResult } from '@aluy/cli-core';
import type { StreamSink } from '../../src/session/streaming-caller.js';

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

function build(
  responses: readonly { text: string; quota?: Quota | null }[],
  quotaFetcher?: () => Promise<Quota | undefined>,
): SessionController {
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
    ...(quotaFetcher !== undefined ? { quotaFetcher } : {}),
  });
  ctrlRef = controller;
  return controller;
}

/** Aguarda os microtasks do boot fire-and-forget assentarem. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const CREDIT_ONLY: Quota = { windows: {}, credit: { balance: '42.118000' } };
const EMPTY_DEV: Quota = { windows: {} }; // estado dev real (parseQuotaResponse de {windows:[],balance:null})

const WINDOWS_FROM_USAGE: Quota = {
  windows: { fiveHour: { used: 42, limit: 100, resetAt: Date.now() + 2 * 60 * 60_000 } },
};

describe('SessionController — crédito do /v1/quota em meta.quota (EST-0948 · ADR-0069)', () => {
  it('BOOT: `quotaFetcher` traz CRÉDITO ⇒ meta.quota.credit populado (footer acende)', async () => {
    const c = build([{ text: 'oi.' }], async () => CREDIT_ONLY);
    await settle();
    expect(c.current.meta.quota?.credit?.balance).toBe('42.118000');
  });

  it('ESTADO DEV vazio (`{windows:{}}` sem crédito) ⇒ meta.quota sem crédito (footer OCULTO)', async () => {
    const c = build([{ text: 'oi.' }], async () => EMPTY_DEV);
    await settle();
    // patch ocorre, mas sem crédito nem janela ⇒ o footer (formatQuota) devolve undefined.
    expect(c.current.meta.quota?.credit).toBeUndefined();
    expect(c.current.meta.quota?.windows.fiveHour).toBeUndefined();
  });

  it('MERGE: janela do `usage` (path A) + crédito do `/v1/quota` (path B) coexistem', async () => {
    // boot traz crédito; o turno traz a janela pelo `usage` (onQuota). O merge preserva ambos.
    const c = build([{ text: 'oi.', quota: WINDOWS_FROM_USAGE }], async () => CREDIT_ONLY);
    await settle();
    await c.submit('explique');
    await settle();
    expect(c.current.meta.quota?.credit?.balance).toBe('42.118000');
    expect(c.current.meta.quota?.windows.fiveHour?.used).toBe(42);
  });

  it('REFRESH pós-turno: saldo ATUALIZADO sobrescreve o do boot; janela preservada', async () => {
    const balances = ['10.000000', '7.500000'];
    let call = 0;
    const fetcher = vi.fn(async (): Promise<Quota> => {
      const balance = balances[Math.min(call, balances.length - 1)] ?? '0';
      call += 1;
      return { windows: {}, credit: { balance } };
    });
    const c = build([{ text: 'oi.', quota: WINDOWS_FROM_USAGE }], fetcher);
    await settle();
    expect(c.current.meta.quota?.credit?.balance).toBe('10.000000'); // boot
    await c.submit('gaste');
    await settle();
    // applyQuota (janela do usage) + refreshQuota (novo saldo) ⇒ saldo novo + janela mantida.
    expect(c.current.meta.quota?.credit?.balance).toBe('7.500000');
    expect(c.current.meta.quota?.windows.fiveHour?.used).toBe(42);
  });

  it('`quotaFetcher` que degrada a `undefined` (broker fora) ⇒ NÃO apaga o estado', async () => {
    const c = build([{ text: 'oi.' }], async () => undefined);
    await settle();
    expect(c.current.meta.quota).toBeUndefined(); // nada a mostrar, não quebra.
  });

  it('SEM `quotaFetcher` (não injetado) ⇒ comportamento idêntico ao baseline (sem crédito)', async () => {
    const c = build([{ text: 'oi.', quota: WINDOWS_FROM_USAGE }]);
    await c.submit('explique');
    await settle();
    expect(c.current.meta.quota?.windows.fiveHour?.used).toBe(42);
    expect(c.current.meta.quota?.credit).toBeUndefined();
  });
});
