// ADR-0146 (EST-SUBAGENT-MODEL) — controle do modelo/tier dos sub-agentes:
// (D1) parâmetro `model` do `spawn_agent` VENCE (D3) o `model:` do `.md`, que VENCE
// (D4) o dial global (`defaultChildModel`), que VENCE a herança do pai. (D2) probe
// L1+L2 fail-closed ANTES do fan-out (nome desconhecido ⇒ erro+sugestão, sem
// derrubar os irmãos). (D3) `custom`/`custom:<slug>` só roda com o pai em
// `tier:'custom'`. (Q-3) aviso NÃO-bloqueante de tier mais caro. (D5) o rótulo do
// tier resolvido aparece no bloco `subagents` da UI. GS-SAM1..6 — nunca credencial.
//
// Testado DIRETO no `SessionController` (como `controller-subagents.test.ts`), com
// `callerForTier`/`customCallerFor`/`modelProbe` fakes que MARCAM cada chamada —
// provamos o ROTEAMENTO, não o broker real.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  AgentRegistry,
  SPAWN_AGENT_TOOL_NAME,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type AgentProfile,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import type { SessionBlock, SubAgentsBlock, NoteBlock } from '../../src/session/model.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function fakePorts(): ToolPorts {
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
    async exec() {
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

/**
 * Modelo do PAI: 1º turno delega via `spawn_agent(agentsInput)`, 2º conclui. Quando
 * `captured` é passado, o 2º call (que já recebe a OBSERVAÇÃO do `spawn_agent` na
 * mensagem) grava o histórico serializado — prova o que o probe/erro devolveu ao
 * PAI como DADO (o `formatSubAgentResults`), sem depender do bloco de UI (que só
 * existe p/ filhos que CHEGARAM a ser spawnados — GS-MD7 já tem essa propriedade
 * p/ nome de agente desconhecido; o probe D2/D3 do ADR-0146 espelha o MESMO padrão).
 */
function parentDelegates(
  agentsInput: Record<string, unknown>,
  captured?: { messages?: string },
): ModelCaller {
  let turn = 0;
  return {
    async call(args): Promise<ModelCallResult> {
      if (turn === 1 && captured) captured.messages = JSON.stringify(args.messages);
      const content =
        turn === 0 ? toolCall(SPAWN_AGENT_TOOL_NAME, agentsInput) : 'consolidei o resultado.';
      turn += 1;
      return {
        request_id: 'r',
        content,
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
      };
    },
  };
}

/** Caller MARCADO por tag; conclui de imediato ("pronto"). */
function taggedCaller(tag: string, log: string[]): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      log.push(tag);
      return {
        request_id: 'req',
        content: 'pronto.',
        finish_reason: 'stop',
        usage: { request_id: 'req', tier: tag, tokens_in: 1, tokens_out: 1 },
      };
    },
  };
}

function globalProfile(name: string, model?: string): AgentProfile {
  return {
    name,
    systemPrompt: `você é o ${name}.`,
    origin: 'global',
    ...(model !== undefined ? { model } : {}),
  };
}

function subAgentsBlock(blocks: readonly SessionBlock[]): SubAgentsBlock | undefined {
  return blocks.find((b): b is SubAgentsBlock => b.kind === 'subagents');
}

const askAutoApprove = { async resolve() { return { kind: 'approve-once' as const }; } };

describe('ADR-0146 (D1/D3) — precedência: param do spawn VENCE o model: do `.md`', () => {
  it('agent nomeado com model:"granito" no `.md`, mas o spawn pede model:"opus" ⇒ roteia p/ aluy-deep', async () => {
    const registry = new AgentRegistry([globalProfile('helper', 'granito')], []);
    const tierLog: string[] = [];
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', agent: 'helper', model: 'opus' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true, maxConcurrency: 2 },
      agentRegistry: registry,
      callerForTier: (tier) => taggedCaller(tier, tierLog),
    });

    await controller.submit('delegue ao helper com o modelo opus');

    expect(tierLog).toEqual(['aluy-deep']); // opus vence granito
  });
});

describe('ADR-0146 (D2) — probe fail-closed: nome de modelo desconhecido', () => {
  it('model sem cara de tier/sentinela ⇒ erro POR-FILHO com sugestão, ANTES do fan-out (irmão roda)', async () => {
    const tierLog: string[] = [];
    const captured: { messages?: string } = {};
    const model = parentDelegates(
      {
        agents: [
          { label: 'bom', goal: 'g1', model: 'sonnet' },
          { label: 'ruim', goal: 'g2', model: 'sonet' }, // typo
        ],
      },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true, maxConcurrency: 2 },
      callerForTier: (tier) => taggedCaller(tier, tierLog),
      modelProbe: {
        availableNames: async () => ['aluy-flux', 'aluy-granito', 'aluy-strata', 'aluy-deep'],
      },
    });

    await controller.submit('spawn com 2 filhos, um com typo');

    // o "bom" rodou (foi ao tier certo); o probe não derrubou o irmão nem ele foi
    // spawnado no tier de nenhum outro (só 1 entrada no log).
    expect(tierLog).toEqual(['aluy-strata']);
    // o "ruim" NUNCA chegou a ser spawnado (fail-closed ANTES do fan-out — igual ao
    // "agente desconhecido" de GS-MD7, não entra no bloco de UI dos filhos que
    // RODARAM); o erro legível+sugestão volta ao PAI como DADO (observação da tool).
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'ruim')).toBe(false);
    expect(block?.children.find((c) => c.label === 'bom')?.status).toBe('done');
    expect(captured.messages ?? '').toMatch(/ruim/);
    expect(captured.messages ?? '').toMatch(/sonnet/); // sugestão
    expect(captured.messages ?? '').toMatch(/não encontrado/);
  });

  it('SEM modelProbe (broker offline) ⇒ degrade honesto, ainda assim erro fail-closed', async () => {
    const captured: { messages?: string } = {};
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', model: 'gpt-9-turbo' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      // SEM modelProbe injetado.
    });
    await controller.submit('spawn com nome inválido');
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false); // fail-closed antes de rodar
    expect(captured.messages ?? '').toMatch(/gpt-9-turbo/);
    expect(captured.messages ?? '').toMatch(/não deu para confirmar no catálogo/);
  });
});

describe('ADR-0146 (D3) — "custom"/"custom:<slug>" só roda com o pai em tier:custom', () => {
  it('pai FORA de tier:custom + model:"custom" ⇒ erro legível ANTES de rodar', async () => {
    const captured: { messages?: string } = {};
    const model = parentDelegates({ agents: [{ label: 'x', goal: 'g', model: 'custom' }] }, captured);
    const customLog: string[] = [];
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 }, // NÃO custom
      subAgents: { enabled: true },
      customCallerFor: (slug) => taggedCaller(`custom:${slug ?? ''}`, customLog),
    });
    await controller.submit('spawn custom fora de sessão BYO');

    expect(customLog).toHaveLength(0); // nunca chegou a rodar — fail-closed ANTES do fan-out
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(captured.messages ?? '').toMatch(/BYO\/Custom/);
    expect(captured.messages ?? '').toMatch(/aluy-flux/);
  });

  it('pai em tier:custom + model:"custom:<slug>" ⇒ roda via customCallerFor com o slug indicado', async () => {
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', model: 'custom:meu-slug' }],
    });
    const customLog: string[] = [];
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'custom', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      customCallerFor: (slug) => taggedCaller(`custom:${slug ?? ''}`, customLog),
    });
    await controller.submit('spawn custom dentro de sessão BYO');

    expect(customLog).toEqual(['custom:meu-slug']);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'x')?.status).toBe('done');
  });
});

describe('ADR-0146 (D4) — dial global (defaultChildModel) é o default dos filhos', () => {
  it('SEM model no spawn/`.md` ⇒ usa o dial global (posição 3 da precedência)', async () => {
    const tierLog: string[] = [];
    const model = parentDelegates({ agents: [{ label: 'x', goal: 'g' }] }); // SEM model
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      callerForTier: (tier) => taggedCaller(tier, tierLog),
      defaultChildModel: 'granito',
    });
    await controller.submit('spawn sem model — deve cair no dial');
    expect(tierLog).toEqual(['aluy-granito']);
  });

  it('model do spawn AINDA VENCE o dial (precedência intacta)', async () => {
    const tierLog: string[] = [];
    const model = parentDelegates({ agents: [{ label: 'x', goal: 'g', model: 'opus' }] });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      callerForTier: (tier) => taggedCaller(tier, tierLog),
      defaultChildModel: 'granito',
    });
    await controller.submit('spawn com model — vence o dial');
    expect(tierLog).toEqual(['aluy-deep']);
  });
});

describe('ADR-0146 (Q-3) — aviso NÃO-bloqueante de tier mais caro', () => {
  it('tier mais caro que o corrente ⇒ nota informativa, mas o filho RODA', async () => {
    const tierLog: string[] = [];
    const model = parentDelegates({ agents: [{ label: 'x', goal: 'g', model: 'opus' }] });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 }, // flux é o mais barato
      subAgents: { enabled: true },
      callerForTier: (tier) => taggedCaller(tier, tierLog),
    });
    await controller.submit('spawn com tier mais caro');

    expect(tierLog).toEqual(['aluy-deep']); // rodou de qualquer jeito
    const note = controller.current.blocks.find(
      (b): b is NoteBlock => b.kind === 'note' && b.title === 'spawn_agent',
    );
    expect(note).toBeDefined();
    expect(note!.lines.join(' ')).toMatch(/mais caro/);
  });

  it('tier IGUAL/mais barato que o corrente ⇒ SEM aviso', async () => {
    const tierLog: string[] = [];
    const model = parentDelegates({ agents: [{ label: 'x', goal: 'g', model: 'flux' }] });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-deep', tokens: 0, windowPct: 0 }, // já no mais caro
      subAgents: { enabled: true },
      callerForTier: (tier) => taggedCaller(tier, tierLog),
    });
    await controller.submit('spawn com tier mais barato');

    expect(tierLog).toEqual(['aluy-flux']);
    const note = controller.current.blocks.find(
      (b): b is NoteBlock => b.kind === 'note' && b.title === 'spawn_agent',
    );
    expect(note).toBeUndefined();
  });
});

describe('ADR-0146 (D5) — o rótulo do tier resolvido aparece no bloco `subagents`', () => {
  it('filho com model:"opus" ⇒ o child-view mostra "aluy-deep"', async () => {
    const model = parentDelegates({ agents: [{ label: 'x', goal: 'g', model: 'opus' }] });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      callerForTier: (tier) => taggedCaller(tier, []),
    });
    await controller.submit('spawn com opus');
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'x')?.model).toBe('aluy-deep');
  });

  it('filho SEM model ⇒ o child-view mostra "herdado (<tier do pai>)"', async () => {
    const model = parentDelegates({ agents: [{ label: 'x', goal: 'g' }] });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
    });
    await controller.submit('spawn genérico');
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'x')?.model).toBe('herdado (aluy-strata)');
  });

  it('GS-SAM4 — o rótulo de UI NUNCA carrega provider/base_url/api_key/token/secret', async () => {
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', model: 'custom:meta-llama/llama-3.3-70b' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'custom', model: 'slug-do-pai', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      customCallerFor: (slug) => taggedCaller(`custom:${slug ?? ''}`, []),
    });
    await controller.submit('spawn custom com slug');
    const block = subAgentsBlock(controller.current.blocks);
    const label = block?.children.find((c) => c.label === 'x')?.model;
    expect(label).toBe('custom · meta-llama/llama-3.3-70b');
    expect(label ?? '').not.toMatch(/\b(provider|base_?url|api[_-]?key|token|secret|authorization)\b/i);
  });
});

describe('GS-SAM1/GS-SAM4 — anti-vazamento de credencial no estado inteiro da sessão', () => {
  it('serializa TODO o `controller.current` e falha se aparecer provider/base_url/api_key/token/secret', async () => {
    const model = parentDelegates({
      agents: [
        { label: 'a', goal: 'g1', model: 'custom:meta-llama/llama-3.3-70b' },
        { label: 'b', goal: 'g2', model: 'opus' },
        { label: 'c', goal: 'g3', model: 'sonet-typo' },
      ],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'custom', model: 'slug-do-pai', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true, maxConcurrency: 3 },
      callerForTier: (tier) => taggedCaller(tier, []),
      customCallerFor: (slug) => taggedCaller(`custom:${slug ?? ''}`, []),
      modelProbe: {
        availableNames: async () => ['aluy-flux', 'aluy-granito', 'aluy-strata', 'aluy-deep'],
      },
    });
    await controller.submit('lote misto p/ o anti-leak sweep');

    const serialized = JSON.stringify(controller.current);
    expect(serialized).not.toMatch(/\b(provider|base_?url|api[_-]?key|token|secret|authorization)\b/i);
  });
});
