// ADR 0006 — a resposta do Concierge faz STREAM de verdade: com o `StreamingModelCaller`
// real (o mesmo do wiring) e um cliente que entrega os pedaços devagar, o bloco `Λluy`
// cresce ANTES de o modelo terminar (nada de tudo-de-uma-vez no fim).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type BrokerModelClient,
  type ModelStreamEvent,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { ConciergeRuntime } from '../../src/session/concierge-runtime.js';
import { StreamingModelCaller } from '../../src/session/streaming-caller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ports = (): ToolPorts => ({
  fs: { readFile: async () => '', writeFile: async () => {}, exists: async () => false },
  shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
  search: { search: async () => [] },
});

describe('Concierge — streaming incremental com o caller real', () => {
  it('o texto do bloco Λluy cresce enquanto o cliente ainda entrega pedaços', async () => {
    const words = ['Vou ', 'explicar ', 'quando ', 'a ', 'tarefa ', 'voltar.'];
    let releasedLast = false;
    const client = {
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        yield { type: 'start', request_id: 'r' };
        for (let i = 0; i < words.length; i += 1) {
          if (i === words.length - 1) releasedLast = true;
          yield { type: 'delta', content: words[i]! };
          await sleep(60);
        }
        yield { type: 'done', finish_reason: 'stop' };
      },
    } as unknown as BrokerModelClient;

    const conversation = new SessionController({
      model: { call: async () => ({ request_id: 'x', content: '', finish_reason: 'stop' }) },
      permission: new PolicyPermissionEngine(),
      ports: ports(),
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPort: 0 } as never,
      flush: { intervalMs: 0 },
    });
    conversation.dismissBoot();
    const caller = new StreamingModelCaller({ client, tier: 'aluy-flux', sink: conversation.sink });
    const rt = new ConciergeRuntime({ sink: conversation, model: { call: (a) => caller.call(a) } });

    const sizes: number[] = [];
    let sawPartialBeforeEnd = false;
    const sample = setInterval(() => {
      const b = conversation.current.blocks.filter((x) => x.kind === 'aluy') as { text: string }[];
      const len = b[0]?.text.length ?? 0;
      sizes.push(len);
      if (len > 0 && len < words.join('').length && !releasedLast) sawPartialBeforeEnd = true;
    }, 20);
    await rt.handleOwnerMessage('explica');
    clearInterval(sample);

    const aluy = conversation.current.blocks.filter((x) => x.kind === 'aluy') as { text: string }[];
    expect(aluy).toHaveLength(1);
    expect(aluy[0]!.text).toBe(words.join(''));
    expect(sawPartialBeforeEnd).toBe(true);
    // Vários tamanhos distintos observados ⇒ cresceu aos poucos, não de uma vez.
    expect(new Set(sizes.filter((n) => n > 0)).size).toBeGreaterThanOrEqual(3);
  });
});
