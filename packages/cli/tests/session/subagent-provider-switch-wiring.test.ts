// BUG (dono, sessão viva): depois de `/provider openrouter` no meio da sessão, o PAI falava
// com o provider novo mas TODO sub-agente falhava em ~1,4s com 0 tokens ("Unknown Model").
// Causa: o `/provider` só trocava o client do `StreamingModelCaller` do pai; os callers de
// sub-agente/compactação/ask capturavam o `ModelClient` do BOOT. O filho mandava o slug do
// provider novo ao ENDPOINT do provider antigo.
//
// Estes testes montam a sessão de verdade (`buildSession`), trocam o provider pela MESMA
// porta do `/provider` e conferem POR QUAL client o filho sai. Falham sem o `liveClient`.

import { describe, expect, it } from 'vitest';
import {
  SPAWN_AGENT_TOOL_NAME,
  type ModelCallRequest,
  type ModelCallResult,
  type ModelClient,
  type ModelStreamEvent,
} from '@hiperplano/aluy-cli-core';
import { buildSession } from '../../src/session/wiring.js';

const OPEN = '<<<ALUY_TOOL_CALL';
const CLOSE = 'ALUY_TOOL_CALL>>>';
const spawn = (): string =>
  `${OPEN}\n${JSON.stringify({
    name: SPAWN_AGENT_TOOL_NAME,
    input: { agents: [{ label: 'filho', goal: 'SUBTAREFA-FILHO: diga ok' }] },
  })}\n${CLOSE}`;

/** Client de um "provider": registra quem foi chamado e por qual rota (pai=stream, filho=call). */
function providerClient(tag: string, log: string[]): ModelClient {
  let parentTurn = 0;
  return {
    async *stream(args: { request: ModelCallRequest }): AsyncGenerator<ModelStreamEvent> {
      log.push(`${tag}:pai:${args.request.model ?? '-'}`);
      const content = parentTurn++ % 2 === 0 ? spawn() : 'consolidei.';
      yield { type: 'start', request_id: 'r', session_id: 's' };
      yield { type: 'delta', content };
      yield { type: 'done', finish_reason: 'stop' };
    },
    async call(args: { request: ModelCallRequest }): Promise<ModelCallResult> {
      log.push(`${tag}:filho:${args.request.model ?? '-'}`);
      return {
        request_id: 'rc',
        content: 'ok do filho.',
        finish_reason: 'stop',
        usage: { request_id: 'rc', tier: args.request.tier, tokens_in: 1, tokens_out: 1 },
      };
    },
  } as unknown as ModelClient;
}

describe('sub-agente segue o provider ATIVO depois do /provider (wiring real)', () => {
  it('após trocar o provider, o FILHO herdado sai pelo client NOVO, com o slug do pai', async () => {
    const log: string[] = [];
    const antigo = providerClient('zai', log);
    const novo = providerClient('openrouter', log);
    const s = buildSession({
      env: {},
      brokerClient: antigo,
      effectiveBackend: 'local',
      mode: 'unsafe',
      subAgents: { enabled: true, maxConcurrency: 1 },
      switchLocalProvider: async () => ({
        ok: true,
        detail: 'ok',
        client: novo,
        defaultModel: 'z-ai/glm-5.3-flash',
      }),
    });

    // sanidade: ANTES da troca o filho sai pelo client do boot
    s.controller.setTier('custom', 'glm-4.6');
    await s.controller.submit('delegue 1');
    expect(log.filter((l) => l.includes(':filho'))).toEqual(['zai:filho:glm-4.6']);

    log.length = 0;
    const r = await s.controller.setLocalProvider('openrouter');
    expect(r.ok).toBe(true);
    await s.controller.submit('delegue 2');

    expect(log.filter((l) => l.includes(':filho'))).toEqual([
      'openrouter:filho:z-ai/glm-5.3-flash',
    ]);
    expect(log.some((l) => l.startsWith('zai:'))).toBe(false); // NADA vaza pro endpoint velho
    s.controller.dispose();
  });
});
