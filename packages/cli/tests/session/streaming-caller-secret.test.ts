// ADR 0005 — a FALA do modelo (UI e `content` que vira histórico/sessão) passa pela redação
// por valor exato, inclusive com o valor PARTIDO entre deltas do SSE.

import { afterEach, describe, expect, it } from 'vitest';
import {
  secretVault,
  type BrokerModelClient,
  type ModelStreamEvent,
} from '@hiperplano/aluy-cli-core';
import { StreamingModelCaller } from '../../src/session/streaming-caller.js';

const CANARY = 'ZIMBRO-canario-7f3a91c2e8';
afterEach(() => secretVault.clear());

function clienteComDeltas(partes: readonly string[]): BrokerModelClient {
  return {
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      yield { type: 'start', request_id: 'r' };
      for (const p of partes) yield { type: 'delta', content: p };
      yield { type: 'done', finish_reason: 'stop' };
    },
  } as unknown as BrokerModelClient;
}

describe('StreamingModelCaller × cofre de segredos', () => {
  it.each([2, 5])(
    'valor partido em deltas de %i chars não chega à UI nem ao content',
    async (n) => {
      secretVault.set('API_KEY', CANARY);
      const texto = `a chave é ${CANARY}, ok?`;
      const partes: string[] = [];
      for (let i = 0; i < texto.length; i += n) partes.push(texto.slice(i, i + n));
      const ui: string[] = [];
      const caller = new StreamingModelCaller({
        client: clienteComDeltas(partes),
        tier: 'aluy-flux',
        sink: { onStart() {}, onDelta: (c) => ui.push(c), onDone() {} },
      });
      const r = await caller.call({ messages: [], idempotencyKey: 'k' });
      expect(ui.join('')).toBe('a chave é ‹redigido›, ok?');
      expect(r.content).toBe('a chave é ‹redigido›, ok?');
    },
  );

  it('sem segredos: passa-direto, delta a delta (sem retenção)', async () => {
    const ui: string[] = [];
    const caller = new StreamingModelCaller({
      client: clienteComDeltas(['ZIMBRO-', 'can']),
      tier: 'aluy-flux',
      sink: { onStart() {}, onDelta: (c) => ui.push(c), onDone() {} },
    });
    await caller.call({ messages: [], idempotencyKey: 'k' });
    expect(ui).toEqual(['ZIMBRO-', 'can']);
  });
});
