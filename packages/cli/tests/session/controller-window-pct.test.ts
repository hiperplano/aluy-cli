// F11 (dogfooding) — a `% janela` (meta.windowPct) é a OCUPAÇÃO do contexto ATUAL
// (= `tokens_in`, o prompt enviado ao modelo no turno), NÃO o acumulado da sessão.
// Antes do fix usava o cumulativo (meta.tokens) ⇒ nunca caía após /clear ou /compact,
// enganando o usuário ("janela cheia" com contexto já liberado). Aqui dirige o sink
// direto: um turno com prompt GRANDE sobe a janela; o turno seguinte com prompt MENOR
// (como ocorre após /clear ou /compact) faz a janela CAIR — e o acumulado SEGUE subindo.

import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine } from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { ModelCaller, ModelCallResult } from '@aluy/cli-core';
import type { StreamSink } from '../../src/session/streaming-caller.js';

// Caller que reporta um `tokens_in` CUSTOM por turno (o tamanho do prompt/contexto).
function caller(
  turns: readonly { tokensIn: number; tokensOut: number }[],
  sink: StreamSink,
): ModelCaller {
  let i = 0;
  return {
    async call(): Promise<ModelCallResult> {
      const t = turns[Math.min(i, turns.length - 1)] ?? { tokensIn: 0, tokensOut: 0 };
      i += 1;
      sink.onStart?.();
      sink.onDelta('ok.');
      sink.onUsage?.({
        request_id: 'r',
        tier: 'aluy-flux',
        tokens_in: t.tokensIn,
        tokens_out: t.tokensOut,
      });
      sink.onDone?.();
      return { request_id: 'r', content: 'ok.', finish_reason: 'stop' };
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
  turns: readonly { tokensIn: number; tokensOut: number }[],
  contextWindow?: number,
): SessionController {
  let ref: SessionController | null = null;
  const sink: StreamSink = {
    onStart: () => ref?.sink.onStart?.(),
    onDelta: (c) => ref?.sink.onDelta(c),
    onUsage: (u) => ref?.sink.onUsage?.(u),
    onDone: () => ref?.sink.onDone?.(),
  };
  const c = new SessionController({
    model: caller(turns, sink),
    permission: new PolicyPermissionEngine(),
    ports: noPorts,
    askResolver: new TuiAskResolver(),
    // contextWindow default = 200_000 (DEFAULT_CONTEXT_WINDOW); 0 = janela DESCONHECIDA.
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
  });
  ref = c;
  return c;
}

describe('SessionController — % janela reflete o CONTEXTO ATUAL, não o cumulativo (F11)', () => {
  it('windowPct = tokens_in/janela (prompt do turno), não o acumulado', async () => {
    const c = build([{ tokensIn: 100_000, tokensOut: 1_000 }]);
    await c.submit('um prompt grande');
    // 100_000 / 200_000 = 50%.
    expect(c.current.meta.windowPct).toBe(50);
    // o acumulado da sessão é tokens_in + tokens_out.
    expect(c.current.meta.tokens).toBe(101_000);
  });

  it('quando o prompt ENCOLHE (pós /clear ou /compact) a janela CAI, mas o acumulado SOBE', async () => {
    const c = build([
      { tokensIn: 120_000, tokensOut: 1_000 }, // contexto cheio: 60%
      { tokensIn: 20_000, tokensOut: 1_000 }, // contexto liberado: 10%
    ]);
    await c.submit('turno 1 (contexto grande)');
    expect(c.current.meta.windowPct).toBe(60);

    await c.submit('turno 2 (contexto pequeno, como após /clear ou /compact)');
    // A janela CAI para 20_000/200_000 = 10% (o fix). Antes ficava no cumulativo
    // (142_000/200_000 = 71%), enganando o usuário.
    expect(c.current.meta.windowPct).toBe(10);
    // o acumulado, esse sim, segue subindo (uso da sessão).
    expect(c.current.meta.tokens).toBe(142_000);
  });

  it('turno sem tokens_in reportado ⇒ MANTÉM a janela anterior (não zera o sinal)', async () => {
    const c = build([
      { tokensIn: 80_000, tokensOut: 1_000 }, // 40%
      { tokensIn: 0, tokensOut: 500 }, // não reportou prompt ⇒ mantém 40%
    ]);
    await c.submit('turno 1');
    expect(c.current.meta.windowPct).toBe(40);
    await c.submit('turno 2 sem tokens_in');
    expect(c.current.meta.windowPct).toBe(40);
  });

  // EST-1015 (fix) — janela DESCONHECIDA (contextWindow=0: tier `custom`/desconhecido) NÃO
  // pode virar `100%`. Antes: promptTokens/0 = Infinity ⇒ Math.min(100, …) = 100 (enganoso).
  it('contextWindow=0 (janela desconhecida) ⇒ NÃO mostra 100% (preserva o anterior)', async () => {
    const c = build([{ tokensIn: 50_000, tokensOut: 1_000 }], 0);
    await c.submit('turno num tier de janela desconhecida (custom)');
    // sem janela conhecida, o sinal fica no valor inicial (0), NUNCA 100% espúrio.
    expect(c.current.meta.windowPct).toBe(0);
    expect(c.current.meta.windowPct).not.toBe(100);
    // o acumulado de tokens segue normal (independe da janela).
    expect(c.current.meta.tokens).toBe(51_000);
  });
});
