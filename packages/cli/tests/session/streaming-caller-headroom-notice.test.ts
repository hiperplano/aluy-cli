// AVISOS DO HEADROOM NÃO ESCREVEM CRU NO TERMINAL DA TUI.
//
// Visto em 16/09 (tmux, 177×53): `[headroom] mensagens comprimidas: 8671 → 8478 tokens (-193)`
// apareceu no meio da tela e deslocou o frame. O caller escrevia com `process.stderr.write`,
// que o Ink não controla (o `patchConsole` só pega `console.*`). Com um sink, o aviso vai só
// para ele (a TUI decide: nota ou nada); sem sink, segue no stderr (headless/serviço).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RETRY_OFF,
  type BrokerModelClient,
  type ModelStreamEvent,
} from '@hiperplano/aluy-cli-core';
import { StreamingModelCaller } from '../../src/session/streaming-caller.js';

vi.mock('../../src/model/headroom.js', () => ({
  compressViaHeadroom: async (
    messages: unknown[],
    opts: {
      onSavings?: (i: { before: number; after: number; ratio: number }) => void;
      onRefused?: (r: string) => void;
    },
  ) => {
    opts.onSavings?.({ before: 8671, after: 8478, ratio: 0.97 });
    opts.onRefused?.('destino não-loopback');
    return messages;
  },
}));

function client(): BrokerModelClient {
  const script: ModelStreamEvent[] = [
    { type: 'delta', content: 'ok' } as unknown as ModelStreamEvent,
    { type: 'done' } as unknown as ModelStreamEvent,
  ];
  return {
    async *stream() {
      for (const ev of script) yield ev;
    },
  } as unknown as BrokerModelClient;
}

describe('headroom — avisos nunca escrevem cru no terminal quando há sink', () => {
  let writes: string[];
  beforeEach(() => {
    writes = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      writes.push(String(c));
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('com onHeadroomNotice: nada vai p/ stderr; savings e refused chegam ao sink', async () => {
    const notices: Array<{ kind: string; text: string }> = [];
    const caller = new StreamingModelCaller({
      client: client(),
      tier: 'default',
      retry: RETRY_OFF,
      headroomUrl: 'http://127.0.0.1:8787',
      sink: { onDelta: () => {} },
      onHeadroomNotice: (n: { kind: string; text: string }) => notices.push(n),
    });
    await caller.call({ messages: [{ role: 'user', content: 'x' }], idempotencyKey: 'k' });
    expect(writes.filter((w) => w.includes('[headroom]'))).toEqual([]);
    expect(notices.map((n) => n.kind)).toEqual(['savings', 'refused']);
    expect(notices[0]?.text).toContain('8671 → 8478 tokens (-193)');
  });

  it('sem sink (headless/serviço): mantém a linha no stderr (retrocompat)', async () => {
    const caller = new StreamingModelCaller({
      client: client(),
      tier: 'default',
      retry: RETRY_OFF,
      headroomUrl: 'http://127.0.0.1:8787',
      sink: { onDelta: () => {} },
    });
    await caller.call({ messages: [{ role: 'user', content: 'x' }], idempotencyKey: 'k' });
    expect(writes.some((w) => w.includes('mensagens comprimidas: 8671 → 8478'))).toBe(true);
  });
});
