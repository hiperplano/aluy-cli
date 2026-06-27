// EST-0962 (Custom · bug do sub-agente 422) — INTEGRAÇÃO no @aluy/cli: `buildSession`
// fia a pista de modelo CORRENTE do PAI (tier + slug Custom do StreamingModelCaller)
// até o corpo do request dos FILHOS (sub-agentes).
//
// O bug: o pai em `tier:'custom'` gerava um filho com `tier:'custom'` SEM `model`
// ⇒ broker 422 "o modo Custom exige model"; ou o filho ficava preso no tier default.
// Causa: o `customModel` corrente do pai NÃO era propagado ao caller do filho.
//
// Prova end-to-end (broker mockado — SEM modelo real, frugal):
//   - pai em `tier:'custom'`+slug ⇒ o request do FILHO inclui `model:<slug>` + `tier:'custom'`;
//   - pai em tier CANÔNICO ⇒ o filho NÃO manda model;
//   - LEITURA DINÂMICA: trocar o Custom no pai em runtime ⇒ o próximo spawn usa o novo slug;
//   - HG-2: o corpo do filho NUNCA carrega provider/api_key/base_url.
//
// O PAI fala por `client.stream()` (StreamingModelCaller); os FILHOS por `client.call()`
// (BrokerModelCaller dedicado, não-streaming). O stub captura AMBOS — distinguimos o
// request do filho pelo `goal` que só o filho recebe no canal de mensagens.

import { describe, expect, it } from 'vitest';
import {
  SPAWN_AGENT_TOOL_NAME,
  type BrokerModelClient,
  type ModelCallRequest,
  type ModelCallResult,
  type ModelStreamEvent,
} from '@aluy/cli-core';
import { buildSession } from '../../src/session/wiring.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

interface CapturedReq {
  readonly tier: string;
  readonly model: string | undefined;
  readonly raw: ModelCallRequest;
}

/**
 * Broker stub que captura TODO request (stream do pai + call dos filhos). O PAI (1ª
 * sessão pelo `stream`) delega 1 filho via spawn_agent no 1º turno e conclui no 2º.
 * O FILHO (`call`, não-stream) conclui de imediato. O filho é distinguido pela ROTA:
 * só ele passa por `call()` — o pai fala por `stream()`.
 */
function spawningBroker(): { client: BrokerModelClient; childReqs: CapturedReq[] } {
  const childReqs: CapturedReq[] = [];
  let parentTurn = 0;

  const client = {
    // PAI — streaming. 1º turno: spawn_agent com 1 filho; 2º: resposta final. O pai
    // NUNCA é capturado como filho (filho fala por `call`, não por `stream`).
    async *stream(args: { request: ModelCallRequest }): AsyncGenerator<ModelStreamEvent> {
      void args;
      const turn = parentTurn;
      parentTurn += 1;
      // Cada submit = 2 turnos do pai: turno PAR delega (spawn_agent), turno ÍMPAR
      // consolida. Assim CADA `submit()` dispara exatamente 1 filho (testa o spawn
      // dinâmico através de múltiplas delegações).
      const content =
        turn % 2 === 0
          ? toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [{ label: 'pesquisa', goal: 'SUBTAREFA-FILHO: pesquise X' }],
            })
          : 'consolidei o resultado do filho.';
      yield { type: 'start', request_id: 'r', session_id: 'sp' };
      yield { type: 'delta', content };
      yield { type: 'done', finish_reason: 'stop' };
    },
    // FILHOS — não-streaming (BrokerModelCaller.call). SÓ o filho passa por aqui ⇒
    // captura direta da pista de modelo (tier + slug) que o filho mandou ao broker.
    async call(args: { request: ModelCallRequest }): Promise<ModelCallResult> {
      childReqs.push({
        tier: args.request.tier,
        model: args.request.model,
        raw: args.request,
      });
      return {
        request_id: 'rc',
        content: 'relatório do filho.',
        finish_reason: 'stop',
        usage: { request_id: 'rc', tier: args.request.tier, tokens_in: 1, tokens_out: 1 },
      };
    },
  } as unknown as BrokerModelClient;

  return { client, childReqs };
}

function buildWithSubAgents(client: BrokerModelClient) {
  return buildSession({
    env: {},
    brokerClient: client,
    // unsafe ⇒ auto-aprova o spawn_agent (foco do teste é a pista de modelo, não a catraca).
    mode: 'unsafe',
    subAgents: { enabled: true, maxConcurrency: 1 },
  });
}

describe('EST-0962 — buildSession propaga a pista Custom do PAI ao FILHO (sub-agente)', () => {
  it('pai em tier:custom + slug ⇒ o request do FILHO leva tier:custom + model:<slug>', async () => {
    const { client, childReqs } = spawningBroker();
    const s = buildWithSubAgents(client);

    // o usuário escolhe o modo Custom no `/model` ANTES de delegar
    s.controller.setTier('custom', 'meta-llama/llama-3.3-70b-instruct');
    await s.controller.submit('delegue uma subtarefa');

    expect(childReqs.length).toBe(1);
    expect(childReqs[0]!.tier).toBe('custom');
    expect(childReqs[0]!.model).toBe('meta-llama/llama-3.3-70b-instruct');
  });

  it('pai em tier CANÔNICO ⇒ o FILHO NÃO manda model (não-regressão #36/#71)', async () => {
    const { client, childReqs } = spawningBroker();
    const s = buildWithSubAgents(client);

    // sem trocar p/ custom: o pai fica no tier default (canônico)
    await s.controller.submit('delegue uma subtarefa');

    expect(childReqs.length).toBe(1);
    expect(childReqs[0]!.tier).not.toBe('custom');
    expect(childReqs[0]!.model).toBeUndefined();
  });

  it('LEITURA DINÂMICA: trocar o Custom no pai em runtime ⇒ o PRÓXIMO spawn usa o novo slug', async () => {
    const { client, childReqs } = spawningBroker();
    const s = buildWithSubAgents(client);

    s.controller.setTier('custom', 'slug-antigo');
    await s.controller.submit('1ª delegação');
    // o usuário troca o Custom no pai EM RUNTIME (entre dois turnos do pai)
    s.controller.setTier('custom', 'slug-novo');
    await s.controller.submit('2ª delegação');

    expect(childReqs.length).toBe(2);
    expect(childReqs[0]!.model).toBe('slug-antigo');
    expect(childReqs[1]!.model).toBe('slug-novo');
  });

  it('HG-2: o corpo do FILHO NUNCA carrega provider/api_key/base_url', async () => {
    const { client, childReqs } = spawningBroker();
    const s = buildWithSubAgents(client);

    s.controller.setTier('custom', 'algum/slug');
    await s.controller.submit('delegue');

    expect(childReqs.length).toBe(1);
    const raw = childReqs[0]!.raw as unknown as Record<string, unknown>;
    expect(raw.provider).toBeUndefined();
    expect(raw.api_key).toBeUndefined();
    expect(raw.base_url).toBeUndefined();
    // só a pista sancionada (tier + model) viaja
    expect(childReqs[0]!.tier).toBe('custom');
    expect(childReqs[0]!.model).toBe('algum/slug');
  });
});
