// EST-0948 (server-limits / FU-VAU-003) — o controller LÊ o limite/quota REAL do
// `usage` (canal que JÁ carrega `balance_after`) e:
//   • surfaça o CRÉDITO agora (aviso de saldo baixo, one-shot);
//   • usa o LIMITE do server como o ◷ REAL quando presente (não o DEFAULT_MAX_TOKENS);
//   • DEGRADA quando ausente (cai no fail-safe LOCAL + footer oculto), sem o fail-safe sumir.

import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine, type ModelUsage } from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { ModelCaller, ModelCallResult } from '@aluy/cli-core';
import type { StreamSink } from '../../src/session/streaming-caller.js';

/** Caller scriptado com um `usage` por turno (controla balance_after/limits/tokens). */
function scriptedCaller(
  responses: readonly { text: string; usage: Partial<ModelUsage> }[],
  sink: StreamSink,
): ModelCaller {
  let turn = 0;
  return {
    async call(): Promise<ModelCallResult> {
      const r = responses[Math.min(turn, responses.length - 1)] ?? { text: '', usage: {} };
      turn += 1;
      sink.onStart?.();
      for (const ch of r.text) sink.onDelta(ch);
      sink.onUsage?.({ request_id: 'r', tier: 'aluy-flux', ...r.usage });
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
  responses: readonly { text: string; usage: Partial<ModelUsage> }[],
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
  });
  ctrlRef = controller;
  return controller;
}

function noteTitles(c: SessionController): string[] {
  return c.current.blocks
    .filter((b): b is Extract<typeof b, { kind: 'note' }> => b.kind === 'note')
    .map((b) => b.title);
}

describe('SessionController — server-limits do `usage` (EST-0948)', () => {
  it('arranca SEM serverLimits (degrada: footer/crédito oculto)', () => {
    const c = build([{ text: 'oi.', usage: {} }]);
    expect(c.current.meta.serverLimits).toBeUndefined();
  });

  it('balance_after presente ⇒ meta.serverLimits.balanceAfter (crédito surfaçado AGORA)', async () => {
    const c = build([
      { text: 'oi.', usage: { balance_after: '42.5', tokens_in: 10, tokens_out: 20 } },
    ]);
    await c.submit('explique');
    expect(c.current.meta.serverLimits?.balanceAfter).toBe(42.5);
  });

  it('saldo BAIXO ⇒ nota de aviso "crédito baixo" (one-shot)', async () => {
    const c = build([
      { text: 'um.', usage: { balance_after: '0.5' } },
      { text: 'dois.', usage: { balance_after: '0.3' } },
    ]);
    await c.submit('primeiro');
    expect(noteTitles(c).filter((t) => t === 'crédito baixo')).toHaveLength(1);
    await c.submit('segundo');
    // NÃO repete o aviso enquanto continua baixo (one-shot por sessão).
    expect(noteTitles(c).filter((t) => t === 'crédito baixo')).toHaveLength(1);
  });

  it('saldo com FOLGA ⇒ NENHUM aviso (não inventa)', async () => {
    const c = build([{ text: 'oi.', usage: { balance_after: '100' } }]);
    await c.submit('explique');
    expect(noteTitles(c)).not.toContain('crédito baixo');
  });

  it('saldo volta a subir ⇒ RE-ARMA o aviso p/ a próxima queda', async () => {
    const c = build([
      { text: 'um.', usage: { balance_after: '0.5' } }, // baixo ⇒ avisa
      { text: 'dois.', usage: { balance_after: '50' } }, // recarregou ⇒ re-arma
      { text: 'tres.', usage: { balance_after: '0.2' } }, // baixo de novo ⇒ avisa de novo
    ]);
    await c.submit('um');
    await c.submit('dois');
    await c.submit('tres');
    expect(noteTitles(c).filter((t) => t === 'crédito baixo')).toHaveLength(2);
  });

  it('o ◷ (budgetPct) PERMANECE o fail-safe LOCAL — ADR-0069: a quota de produto do CLI é CRÉDITO, não o ◷', async () => {
    // Mesmo com o server informando um teto de tokens, o ◷ é o % do budget LOCAL (10M),
    // NÃO o do server: a dimensão que governa o ator CLI é o CRÉDITO (footer), não um
    // medidor de janela de tokens. 30 tokens / 10M ⇒ 0%. O `limits` fica guardado p/ o
    // server-limits, mas NÃO hijacka o ◷.
    const c = build([
      {
        text: 'oi.',
        usage: { tokens_in: 10, tokens_out: 20, limits: { limit: 1_000_000, used: 700_000 } },
      },
    ]);
    await c.submit('explique');
    expect(c.current.meta.budgetPct).toBe(0); // fail-safe local, não 70% do server
    expect(c.current.meta.serverLimits?.limit).toBe(1_000_000);
  });

  it('sem dados de server ⇒ o ◷ é o do fail-safe LOCAL (comportamento atual)', async () => {
    const c = build([{ text: 'oi.', usage: { tokens_in: 10, tokens_out: 20 } }]);
    await c.submit('explique');
    expect(c.current.meta.budgetPct).toBe(0);
    expect(c.current.meta.serverLimits).toBeUndefined();
  });

  it('o fail-safe LOCAL NÃO some: tokens crus seguem do onUsage, independentes do server', async () => {
    const c = build([
      {
        text: 'oi.',
        usage: { tokens_in: 10, tokens_out: 20, balance_after: '5' },
      },
    ]);
    await c.submit('explique');
    // os tokens CRUS da sessão seguem do budget local (10+20), independentes do crédito.
    expect(c.current.meta.tokens).toBe(30);
  });

  it('serverLimits (crédito) PERSISTE quando um turno seguinte não traz dados de server', async () => {
    const c = build([
      { text: 'um.', usage: { balance_after: '9' } },
      { text: 'dois.', usage: { tokens_in: 5, tokens_out: 5 } }, // sem nada de server
    ]);
    await c.submit('um');
    expect(c.current.meta.serverLimits?.balanceAfter).toBe(9);
    await c.submit('dois');
    // PRESERVA o último conhecido (não vira undefined por um turno sem dados de server).
    expect(c.current.meta.serverLimits?.balanceAfter).toBe(9);
  });
});
