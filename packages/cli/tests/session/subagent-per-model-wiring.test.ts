// EST-SUBAGENT-MODEL · ADR-0061 §3 · ADR-0073 (tier por-request) · CLI-SEC-7 —
// INTEGRAÇÃO no @aluy/cli: `buildSession` fia o `model:` do `.md` de CADA sub-agente
// nomeado até o `tier` do corpo do request DAQUELE filho.
//
// O pai delega via `spawn_agent({ agents:[{ agent:'<nome>', ... }] })`; o registry
// resolve o `.md` (system prompt/toolScope/MODEL); o spawner traduz `model`→tier
// (resolveModelTier) e roteia o filho ao caller daquele tier (fábrica `callerForTier`
// construída no wiring, reusando o BrokerModelCaller com o tier FIXO). O broker
// resolve provider/credencial/quota (CLI-SEC-7) e valida (422 ⇒ degrade honesto).
//
// Prova end-to-end (broker mockado — SEM modelo real, frugal):
//   - 2 filhos nomeados com models distintos (`opus`→aluy-deep, `granito`→aluy-granito)
//     ⇒ cada request de filho leva o SEU tier;
//   - filho nomeado SEM `model` no `.md` ⇒ o request usa o tier do PAI (back-compat);
//   - filho com tier inservível ⇒ o broker (mock) 422 ⇒ desfecho de erro p/ aquele
//     filho, sem derrubar o outro;
//   - HG-2: o corpo do filho carrega só `tier` (chave de catálogo), nunca credencial.
//
// O PAI fala por `client.stream()`; os FILHOS por `client.call()` — distinguimos o
// request do filho pela ROTA (`call`) + o `goal` que só o filho recebe.

import { describe, expect, it } from 'vitest';
import {
  AgentRegistry,
  SPAWN_AGENT_TOOL_NAME,
  type AgentProfile,
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

interface CapturedChild {
  readonly tier: string;
  readonly goal: string;
  readonly raw: ModelCallRequest;
}

/** Perfil global mínimo (dono=confiável) com um `model:` declarado. */
function globalProfile(name: string, model?: string): AgentProfile {
  return {
    name,
    systemPrompt: `você é o ${name}.`,
    origin: 'global',
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * Broker stub: o PAI (stream) delega DOIS filhos nomeados no 1º turno e conclui no
 * 2º; cada FILHO (call) conclui de imediato. Captura, por filho, o `tier` que ele
 * mandou ao broker (a pista roteada pelo `model:` do `.md`). `failTier` injeta um 422
 * p/ um tier específico (tier inservível ⇒ degrade honesto).
 */
function spawningBroker(opts?: { failTier?: string }): {
  client: BrokerModelClient;
  childReqs: CapturedChild[];
} {
  const childReqs: CapturedChild[] = [];
  let parentTurn = 0;

  const client = {
    async *stream(args: { request: ModelCallRequest }): AsyncGenerator<ModelStreamEvent> {
      void args;
      const turn = parentTurn;
      parentTurn += 1;
      const content =
        turn % 2 === 0
          ? toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [
                { label: 'p1', goal: 'SUBTAREFA: A', agent: 'pesquisador' },
                { label: 'p2', goal: 'SUBTAREFA: B', agent: 'rascunhador' },
              ],
            })
          : 'consolidei os filhos.';
      yield { type: 'start', request_id: 'r', session_id: 'sp' };
      yield { type: 'delta', content };
      yield { type: 'done', finish_reason: 'stop' };
    },
    async call(args: { request: ModelCallRequest }): Promise<ModelCallResult> {
      const tier = args.request.tier;
      // o canal de mensagens do filho carrega o goal recortado (só o filho o tem).
      const goal = JSON.stringify(args.request.messages);
      childReqs.push({ tier, goal, raw: args.request });
      if (opts?.failTier !== undefined && tier === opts.failTier) {
        // espelha um 422 do broker (tier inservível) — BrokerError não-retentado sobe.
        throw new Error(`422 unservable_model: tier "${tier}" não existe`);
      }
      return {
        request_id: 'rc',
        content: 'relatório do filho.',
        finish_reason: 'stop',
        usage: { request_id: 'rc', tier, tokens_in: 1, tokens_out: 1 },
      };
    },
  } as unknown as BrokerModelClient;

  return { client, childReqs };
}

function buildWith(client: BrokerModelClient, registry: AgentRegistry) {
  return buildSession({
    env: {},
    brokerClient: client,
    mode: 'unsafe', // auto-aprova o spawn_agent (foco é a pista de tier, não a catraca).
    subAgents: { enabled: true, maxConcurrency: 2 },
    agentRegistry: registry,
  });
}

/** Acha o request do filho cujo goal-canal cita a subtarefa dada. */
function childFor(reqs: CapturedChild[], needle: string): CapturedChild | undefined {
  return reqs.find((r) => r.goal.includes(needle));
}

describe('EST-SUBAGENT-MODEL — buildSession fia o model do `.md` ao tier do FILHO', () => {
  it('2 filhos nomeados com models distintos ⇒ cada request leva o SEU tier', async () => {
    const registry = new AgentRegistry(
      [globalProfile('pesquisador', 'opus'), globalProfile('rascunhador', 'granito')],
      [],
    );
    const { client, childReqs } = spawningBroker();
    const s = buildWith(client, registry);

    await s.controller.submit('delegue duas subtarefas');

    expect(childReqs).toHaveLength(2);
    // opus → aluy-deep, granito → aluy-granito (cada filho na sua pista).
    expect(childFor(childReqs, 'SUBTAREFA: A')!.tier).toBe('aluy-deep');
    expect(childFor(childReqs, 'SUBTAREFA: B')!.tier).toBe('aluy-granito');
  });

  it('filho nomeado SEM model no `.md` ⇒ o request usa o tier do PAI (back-compat)', async () => {
    const registry = new AgentRegistry(
      [globalProfile('pesquisador', 'opus'), globalProfile('rascunhador') /* SEM model */],
      [],
    );
    const { client, childReqs } = spawningBroker();
    const s = buildWith(client, registry);

    await s.controller.submit('delegue');

    expect(childReqs).toHaveLength(2);
    const withModel = childFor(childReqs, 'SUBTAREFA: A')!;
    const noModel = childFor(childReqs, 'SUBTAREFA: B')!;
    // o filho com model vai p/ o tier do `.md`; o SEM model herda o tier do PAI (default).
    expect(withModel.tier).toBe('aluy-deep');
    // o filho-sem-model NÃO foi roteado p/ o tier do `.md` do outro — caiu no caller do
    // PAI (tier default da sessão, ≠ aluy-deep que o pai não está usando neste teste).
    expect(noModel.tier).not.toBe('aluy-deep');
  });

  it('tier inservível do `.md` ⇒ o filho DEGRADA (erro), sem derrubar o outro filho', async () => {
    const registry = new AgentRegistry(
      [
        globalProfile('pesquisador', 'granito'), // ok
        globalProfile('rascunhador', 'aluy-quartzo'), // tier inexistente ⇒ 422
      ],
      [],
    );
    const { client, childReqs } = spawningBroker({ failTier: 'aluy-quartzo' });
    const s = buildWith(client, registry);

    // não deve LANÇAR p/ o pai: o 422 do filho vira DADO (desfecho de erro do filho).
    await expect(s.controller.submit('delegue')).resolves.toBeUndefined();

    // ambos os filhos TENTARAM (cada um na sua pista); o ruim mandou o tier inservível.
    expect(childReqs.some((r) => r.tier === 'aluy-granito')).toBe(true);
    expect(childReqs.some((r) => r.tier === 'aluy-quartzo')).toBe(true);
  });

  it('HG-2: o corpo do FILHO carrega só `tier` (chave de catálogo), nunca credencial', async () => {
    const registry = new AgentRegistry([globalProfile('pesquisador', 'opus')], []);
    const { client, childReqs } = spawningBroker();
    // só 1 filho neste cenário — o pai delega 2 mas o 2º (rascunhador) é desconhecido
    // ⇒ desfecho de erro (não vira request). Garantimos ≥1 request capturado.
    const s = buildWith(client, registry);
    await s.controller.submit('delegue');

    const req = childReqs.find((r) => r.tier === 'aluy-deep');
    expect(req).toBeDefined();
    const raw = req!.raw as unknown as Record<string, unknown>;
    expect(raw.api_key).toBeUndefined();
    expect(raw.base_url).toBeUndefined();
    // tiers canônicos do `.md` NÃO viajam como via Custom (sem `model` slug nem provider).
    expect(raw.model).toBeUndefined();
    expect(raw.provider).toBeUndefined();
  });
});
