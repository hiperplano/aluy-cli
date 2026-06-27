// EST-0948 — INTEGRAÇÃO: buildSession fia o `max_tokens` de OUTPUT POR CHAMADA
// (anti-TRUNCAMENTO) do config (flag/env) até o corpo do request que o broker recebe.
//
// Prova end-to-end:
//   - SEM config ⇒ o request NÃO leva `max_tokens` (UNSET ⇒ o broker decide; é o
//     comportamento de hoje, não-regressão).
//   - ALUY_MAX_OUTPUT_TOKENS=16384 ⇒ o request leva `max_tokens: 16384`.
//   - `--max-output-tokens` (via opts.maxOutputTokens) VENCE o env.
//   - inválido ⇒ UNSET + aviso (onConfigWarn), sem quebrar.
//   - clamp num teto CLI-side.
//
// ⚠ DISTINTO do budget local `ALUY_MAX_TOKENS`/`--max-tokens` (anti-runaway acumulado):
// um teste no fim prova que mexer no budget local NÃO injeta `max_tokens` no request
// (são eixos diferentes) — guarda anti-confusão/anti-regressão.

import { describe, expect, it } from 'vitest';
import type { BrokerModelClient, ChatMessage } from '@aluy/cli-core';
import { buildSession } from '../../src/session/wiring.js';

/** Broker stub: captura o `max_tokens` de cada request e emite um turno mínimo. */
function capturingBroker(): {
  client: BrokerModelClient;
  maxTokensSeen: Array<number | undefined>;
} {
  const maxTokensSeen: Array<number | undefined> = [];
  const client: BrokerModelClient = {
    async *stream(args: { request: { messages: readonly ChatMessage[]; max_tokens?: number } }) {
      maxTokensSeen.push(args.request.max_tokens);
      yield { type: 'start', request_id: 'r', session_id: 's' } as never;
      yield { type: 'delta', content: 'pronto.' } as never;
      yield { type: 'done', finish_reason: 'stop' } as never;
    },
  } as unknown as BrokerModelClient;
  return { client, maxTokensSeen };
}

describe('EST-0948 — max_tokens de OUTPUT por chamada fiado de buildSession ao request', () => {
  it('SEM config ⇒ o request NÃO leva max_tokens (UNSET ⇒ o broker decide) — não-regressão', async () => {
    const { client, maxTokensSeen } = capturingBroker();
    const s = buildSession({ env: {}, brokerClient: client });
    await s.controller.submit('faça algo');
    expect(maxTokensSeen.length).toBeGreaterThan(0);
    expect(maxTokensSeen[0]).toBeUndefined();
  });

  it('ALUY_MAX_OUTPUT_TOKENS=16384 ⇒ o request leva max_tokens:16384', async () => {
    const { client, maxTokensSeen } = capturingBroker();
    const s = buildSession({
      env: { ALUY_MAX_OUTPUT_TOKENS: '16384' },
      brokerClient: client,
    });
    await s.controller.submit('faça algo');
    expect(maxTokensSeen[0]).toBe(16384);
  });

  it('--max-output-tokens (opts.maxOutputTokens) VENCE o env', async () => {
    const { client, maxTokensSeen } = capturingBroker();
    const s = buildSession({
      env: { ALUY_MAX_OUTPUT_TOKENS: '16384' },
      maxOutputTokens: '32768',
      brokerClient: client,
    });
    await s.controller.submit('faça algo');
    expect(maxTokensSeen[0]).toBe(32768);
  });

  it('valor inválido ⇒ UNSET + aviso (onConfigWarn), sem quebrar a sessão', async () => {
    const warns: string[] = [];
    const { client, maxTokensSeen } = capturingBroker();
    const s = buildSession({
      env: { ALUY_MAX_OUTPUT_TOKENS: 'lixo' },
      brokerClient: client,
      onConfigWarn: (m) => void warns.push(m),
    });
    await s.controller.submit('faça algo');
    expect(maxTokensSeen[0]).toBeUndefined(); // inválido ⇒ UNSET (broker decide)
    expect(warns.length).toBe(1);
    expect(warns[0]!).toMatch(/ALUY_MAX_OUTPUT_TOKENS/);
  });

  it('valor absurdo ⇒ CLAMPADO no teto CLI-side (não vai inteiro ao broker)', async () => {
    const { client, maxTokensSeen } = capturingBroker();
    const s = buildSession({
      env: {},
      maxOutputTokens: '99999999', // bem acima do teto CLI-side
      brokerClient: client,
    });
    await s.controller.submit('faça algo');
    expect(maxTokensSeen[0]).toBe(200_000); // MAX_OUTPUT_TOKENS_CEILING
  });

  it('o budget LOCAL (--max-tokens) NÃO injeta max_tokens no request — eixos distintos', async () => {
    const { client, maxTokensSeen } = capturingBroker();
    // mexe SÓ no budget local da sessão (anti-runaway acumulado); o max_tokens de
    // OUTPUT por chamada continua UNSET ⇒ o broker decide. Guarda anti-confusão.
    const s = buildSession({
      env: { ALUY_MAX_TOKENS: '500000' },
      brokerClient: client,
    });
    await s.controller.submit('faça algo');
    expect(maxTokensSeen[0]).toBeUndefined();
  });
});
