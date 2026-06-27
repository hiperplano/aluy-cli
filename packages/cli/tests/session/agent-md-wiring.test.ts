// EST-0964 — INTEGRAÇÃO: buildSession fia o AGENT.md (instruções de projeto) do
// startup até o canal `system` da chamada de modelo.
//
// Prova end-to-end que `projectInstructions` passado a `buildSession` chega ao
// `system` da requisição que o broker recebe — e que SEM ele, o system não carrega
// o cabeçalho de projeto (não-regressão).

import { describe, expect, it } from 'vitest';
import type { BrokerModelClient, ChatMessage } from '@aluy/cli-core';
import { PROJECT_INSTRUCTIONS_HEADER } from '@aluy/cli-core';
import { buildSession } from '../../src/session/wiring.js';

/** Broker stub: captura as mensagens e emite um turno final mínimo via stream. */
function capturingBroker(): { client: BrokerModelClient; systems: string[] } {
  const systems: string[] = [];
  const client: BrokerModelClient = {
    async *stream(args: { request: { messages: readonly ChatMessage[] } }) {
      const sys = args.request.messages.find((m) => m.role === 'system');
      if (sys) systems.push(sys.content);
      yield { type: 'start', request_id: 'r', session_id: 's' } as never;
      yield { type: 'delta', content: 'pronto.' } as never;
      yield { type: 'done', finish_reason: 'stop' } as never;
    },
  } as unknown as BrokerModelClient;
  return { client, systems };
}

describe('EST-0964 · AGENT.md fiado de buildSession ao canal system', () => {
  it('projectInstructions ⇒ o system da chamada de modelo carrega o AGENT.md', async () => {
    const { client, systems } = capturingBroker();
    const s = buildSession({
      env: {},
      brokerClient: client,
      projectInstructions: '# proj\nrode `npm test` antes de commitar.',
    });
    await s.controller.submit('faça algo');
    expect(systems.length).toBeGreaterThan(0);
    expect(systems[0]!).toContain(PROJECT_INSTRUCTIONS_HEADER);
    expect(systems[0]!).toContain('rode `npm test` antes de commitar');
  });

  it('SEM projectInstructions ⇒ o system NÃO carrega o cabeçalho de projeto', async () => {
    const { client, systems } = capturingBroker();
    const s = buildSession({ env: {}, brokerClient: client });
    await s.controller.submit('faça algo');
    expect(systems.length).toBeGreaterThan(0);
    expect(systems[0]!).not.toContain(PROJECT_INSTRUCTIONS_HEADER);
  });
});
