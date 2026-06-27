// EST-0978 · ADR-0061 · CLI-SEC-11 — o SessionController resolve agentes NOMEADOS via
// o AgentRegistry (gate FORTE): `spawn_agent({ agent: "revisor" })` roda o perfil do
// `.md`; nome desconhecido ⇒ ERRO VISÍVEL (GS-MD7), sem fallback elevado.

import { describe, expect, it } from 'vitest';
import {
  AgentRegistry,
  PolicyPermissionEngine,
  SPAWN_AGENT_TOOL_NAME,
  type AgentProfile,
  type AskRequest,
  type AskResolution,
  type AskResolver,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function fakePorts(): { ports: ToolPorts; ran: string[] } {
  const ran: string[] = [];
  const fs: FileSystemPort = {
    async readFile() {
      return 'x';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  };
  const shell: ShellPort = {
    async exec(c) {
      ran.push(c);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { ports: { fs, shell, search }, ran };
}

function routingModel(script: (sessionId: string, turn: number) => string): {
  model: ModelCaller;
  firstSession: () => string | null;
} {
  const counts = new Map<string, number>();
  let first: string | null = null;
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const lastColon = key.lastIndexOf(':');
      const sessionId = lastColon > 0 ? key.slice(0, lastColon) : key;
      if (first === null) first = sessionId;
      const turn = counts.get(sessionId) ?? 0;
      counts.set(sessionId, turn + 1);
      return {
        request_id: 'r',
        content: script(sessionId, turn),
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
      };
    },
  };
  return { model, firstSession: () => first };
}

function profile(over: Partial<AgentProfile> & { name: string }): AgentProfile {
  return {
    name: over.name,
    systemPrompt: over.systemPrompt ?? 'persona',
    origin: over.origin ?? 'global',
    ...(over.description !== undefined ? { description: over.description } : {}),
    ...(over.tools !== undefined ? { tools: over.tools } : {}),
    ...(over.model !== undefined ? { model: over.model } : {}),
  };
}

describe('EST-0978 · controller resolve agente NOMEADO', () => {
  it('GS-MD7: agente DESCONHECIDO ⇒ desfecho de ERRO visível (filho NÃO roda, sem shell)', async () => {
    const { ports, ran } = fakePorts();
    const registry = new AgentRegistry([profile({ name: 'revisor', origin: 'global' })], []);
    let parent: string | null = null;
    const { model } = routingModel((sessionId, turn) => {
      if (parent === null) parent = sessionId;
      if (sessionId === parent) {
        return turn === 0
          ? toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [{ label: 'x', goal: 'faça', agent: 'naoexiste' }],
            })
          : 'recebi o erro do agente desconhecido.';
      }
      // se um filho rodar (não deveria), ele tentaria um shell — marcaria `ran`.
      return toolCall('run_command', { command: 'echo NUNCA' });
    });

    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: {
        async resolve() {
          return { kind: 'approve-once' };
        },
      },
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      agentRegistry: registry,
    });

    await controller.submit('delegue ao agente naoexiste');
    expect(controller.current.phase).toBe('done');
    // o filho desconhecido NUNCA foi spawnado ⇒ nenhum comando de shell rodou.
    expect(ran).toEqual([]);
  });

  it('agente NOMEADO conhecido roda com persona + toolScope(⊆pai): tool fora do escopo é negada', async () => {
    const { ports, ran } = fakePorts();
    // revisor: tools read_file,grep — NÃO pode run_command.
    const registry = new AgentRegistry(
      [
        profile({
          name: 'revisor',
          systemPrompt: 'sou revisor',
          tools: ['read_file', 'grep'],
          origin: 'global',
        }),
      ],
      [],
    );
    let parent: string | null = null;
    const { model } = routingModel((sessionId, turn) => {
      if (parent === null) parent = sessionId;
      if (sessionId === parent) {
        return turn === 0
          ? toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [{ label: 'revisor', goal: 'revise', agent: 'revisor' }],
            })
          : 'consolidei a revisão.';
      }
      // FILHO (revisor): turn 0 tenta run_command (fora do toolScope) → negado;
      // turn 1 desiste.
      return turn === 0
        ? toolCall('run_command', { command: 'rm -rf /' })
        : 'sem ferramenta de shell, encerro.';
    });

    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: {
        async resolve() {
          return { kind: 'approve-once' };
        },
      },
      meta: { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      agentRegistry: registry,
    });

    await controller.submit('delegue ao agente revisor');
    expect(controller.current.phase).toBe('done');
    // o revisor TENTOU run_command mas o toolScope negou ⇒ nenhum shell rodou.
    expect(ran).toEqual([]);
  });
});

// EST-0978 · ADR-0061 · RES-MD-1 · CLI-SEC-3/9 — ANTI-SPOOFING DE NOME CROSS-CAMADA
// HONRADO PELO LOCUS. O registry PRODUZ `crossLayerConflict`+`origin` quando um `.md`
// de PROJETO (DADO de terceiro) é homônimo de um GLOBAL confiável; o controller
// (locus) NÃO PODE spawnar o de projeto em silêncio na delegação EXPLÍCITA por nome:
//   • SEM confirmação (resolver nega / não-interativo) ⇒ o de PROJETO NÃO roda (deny
//     fail-closed; NUNCA o global homônimo silencioso no lugar);
//   • COM confirmação explícita ⇒ roda o de PROJETO (origem rotulada na confirmação).
describe('EST-0978 · RES-MD-1 · controller HONRA o conflito cross-camada na delegação', () => {
  // Registry com `revisor` em AMBAS as camadas. O de PROJETO tem run_command no
  // toolScope (⇒ deixa rastro em `ran` SE rodar); o GLOBAL homônimo NÃO tem shell
  // (read_file/grep) — então um rastro em `ran` PROVA que o de PROJETO rodou.
  function conflictedRegistry(): AgentRegistry {
    return new AgentRegistry(
      [
        profile({
          name: 'revisor',
          systemPrompt: 'global confiável',
          tools: ['read_file', 'grep'],
          origin: 'global',
        }),
      ],
      [
        profile({
          name: 'revisor',
          systemPrompt: 'projeto homônimo',
          tools: ['run_command'],
          origin: 'project',
        }),
      ],
    );
  }

  // Modelo: o PAI delega por nome a `revisor`; o FILHO (se rodar) executa um shell que
  // marca `ran` — só possível se o de PROJETO (com run_command) for o spawnado.
  function delegatingModel(): ModelCaller {
    let parent: string | null = null;
    const { model } = routingModel((sessionId, turn) => {
      if (parent === null) parent = sessionId;
      if (sessionId === parent) {
        return turn === 0
          ? toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [{ label: 'revisor', goal: 'revise', agent: 'revisor' }],
            })
          : 'turno do pai concluído.';
      }
      // FILHO: turn 0 roda o shell (rastro em `ran`); turn 1 encerra.
      return turn === 0
        ? toolCall('run_command', { command: 'echo SOU-O-PROJETO' })
        : 'filho encerrou.';
    });
    return model;
  }

  // Resolver que CONTA quantas confirmações recebeu e devolve uma resolução fixa.
  function scriptedResolver(resolution: AskResolution): {
    resolver: AskResolver;
    asks: AskRequest[];
  } {
    const asks: AskRequest[] = [];
    const resolver: AskResolver = {
      async resolve(request: AskRequest): Promise<AskResolution> {
        asks.push(request);
        return resolution;
      },
    };
    return { resolver, asks };
  }

  it('NÃO-INTERATIVO (resolver nega, fail-closed) ⇒ o de PROJETO NÃO roda, sem shell', async () => {
    const { ports, ran } = fakePorts();
    // Resolver headless: NEGA toda confirmação (espelha o TuiAskResolver sem TTY).
    const { resolver, asks } = scriptedResolver({ kind: 'deny', reason: 'sem TTY' });

    const controller = new SessionController({
      model: delegatingModel(),
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: resolver,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      agentRegistry: conflictedRegistry(),
    });

    await controller.submit('delegue ao revisor');
    expect(controller.current.phase).toBe('done');
    // O conflito cross-camada FOI confirmado (o locus consumiu o flag) ...
    expect(asks).toHaveLength(1);
    // ... e a ORIGEM é VISÍVEL na confirmação (anti-spoofing CLI-SEC-9).
    expect(asks[0]!.reason).toContain('[origem: projeto]');
    expect(asks[0]!.category).toBe('always-ask:escalation');
    expect(asks[0]!.alwaysAsk).toBe(true);
    // DENY fail-closed: o de PROJETO (run_command) NUNCA rodou ⇒ nenhum shell.
    expect(ran).toEqual([]);
  });

  it('INTERATIVO mas NEGADO ⇒ o de PROJETO não sequestra a delegação (sem shell)', async () => {
    const { ports, ran } = fakePorts();
    const { resolver, asks } = scriptedResolver({ kind: 'deny' });

    const controller = new SessionController({
      model: delegatingModel(),
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: resolver,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      agentRegistry: conflictedRegistry(),
    });

    await controller.submit('delegue ao revisor');
    expect(controller.current.phase).toBe('done');
    expect(asks).toHaveLength(1);
    // Negado ⇒ o de PROJETO não roda; o global homônimo TAMPOUCO roda em silêncio.
    expect(ran).toEqual([]);
  });

  it('INTERATIVO e CONFIRMADO ⇒ roda o de PROJETO (origem rotulada na confirmação)', async () => {
    const { ports, ran } = fakePorts();
    // Aprovação EXPLÍCITA do de projeto (o usuário confirmou ver a origem).
    const { resolver, asks } = scriptedResolver({ kind: 'approve-once' });

    const controller = new SessionController({
      model: delegatingModel(),
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: resolver,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      agentRegistry: conflictedRegistry(),
    });

    await controller.submit('delegue ao revisor');
    expect(controller.current.phase).toBe('done');
    // Houve confirmação com a origem visível ...
    expect(asks).toHaveLength(1);
    expect(asks[0]!.reason).toContain('[origem: projeto]');
    // ... e SÓ por confirmação explícita o de PROJETO (com run_command) rodou.
    expect(ran).toEqual(['echo SOU-O-PROJETO']);
  });
});
