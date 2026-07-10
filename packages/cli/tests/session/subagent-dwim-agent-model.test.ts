// DWIM AUTO-RECOVER (`seguranca` APROVOU-COM-CONDIÇÕES) — quando o modelo-pai (fraco)
// põe o SLUG de um modelo local no campo `agent` do `spawn_agent` (achando que é o
// `model`), e esse nome NÃO resolve a nenhum perfil `.md` do registro, o backend
// `local` reinterpreta o valor como `model` e roteia pelo MESMO caminho D6 (ADR-0152)
// — em vez de desistir com "agente desconhecido" (GS-MD7). Testado DIRETO no
// `SessionController` (mesmo padrão de `subagent-local-model-routing.test.ts`), com
// `callerForLocalModel`/`localModelCatalog` FAKES que MARCAM cada chamada.
//
// Cobre T-DWIM1..T-DWIM11 do DoD (todas as 8 condições de segurança embutidas):
//   1. backend LOCAL (zero regressão broker/hosted).
//   2. `model` explícito NUNCA sobrescrito pelo `agent` (precedência ADR-0146).
//   3. mesmo juízo do D6 — `kind:'local'` COM slug concreto (não-vazio).
//   4. confirmação de CATÁLOGO OBRIGATÓRIA (listável + presente ⇒ roteia; qualquer
//      outra combinação ⇒ GS-MD7 original, nunca o erro de "modelo local").
//   5. reescrita limpa (`agent` some) — o filho nunca se apresenta como agente nomeado.
//   6. nota SEMPRE visível.
//   7. fail-closed por-filho (irmãos sobrevivem).
//   8. zero regressão do `model` explícito/`.md` real.

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

/**
 * Modelo do PAI: 1º turno delega via `spawn_agent(agentsInput)`, 2º conclui (e
 * grava, se `captured` for passado, o histórico serializado — o que o probe/erro
 * devolveu ao PAI como DADO).
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

/** Caller LOCAL que tenta um EFEITO (run_command) no 1º turno, conclui no 2º. */
function localEffectCaller(tag: string, log: string[]): ModelCaller {
  let turn = 0;
  return {
    async call(): Promise<ModelCallResult> {
      log.push(tag);
      const content =
        turn === 0 ? toolCall('run_command', { command: 'echo hack' }) : 'bloqueado — não agi.';
      turn += 1;
      return {
        request_id: 'r',
        content,
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'local', tokens_in: 1, tokens_out: 1 },
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

function dwimNote(blocks: readonly SessionBlock[]): NoteBlock | undefined {
  return blocks.find(
    (b): b is NoteBlock => b.kind === 'note' && b.title === 'spawn_agent',
  );
}

const askAutoApprove = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

const LOCAL_META = {
  cwd: '/proj',
  tier: 'aluy-flux',
  backend: 'local' as const,
  activeModel: 'deepseek-v4-pro',
  tokens: 0,
  windowPct: 0,
};

const BROKER_META = {
  cwd: '/proj',
  tier: 'aluy-flux',
  backend: 'broker' as const,
  tokens: 0,
  windowPct: 0,
};

describe('T-DWIM1 — local, agent=slug PRESENTE no catálogo, sem .md, sem model ⇒ roteia + nota visível', () => {
  it('reinterpreta o campo agent como model e chama callerForLocalModel', async () => {
    const localLog: string[] = [];
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', agent: 'deepseek/deepseek-v4-flash' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []), // registro vazio — nenhum .md casa
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      localModelCatalog: { listNames: () => ['deepseek/deepseek-v4-flash'] },
    });
    await controller.submit('spawna sub-agente no modelo deepseek/deepseek-v4-flash');

    expect(localLog).toEqual(['LOCAL:deepseek/deepseek-v4-flash']);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'x')?.status).toBe('done');
    expect(block?.children.find((c) => c.label === 'x')?.model).toBe(
      'local · deepseek/deepseek-v4-flash',
    );
    const note = dwimNote(controller.current.blocks);
    expect(note).toBeDefined();
    expect(note!.lines.join(' ')).toMatch(/interpretei/i);
    expect(note!.lines.join(' ')).toMatch(/deepseek\/deepseek-v4-flash/);
    expect(note!.lines.join(' ')).toMatch(/agent/i);
  });
});

describe('T-DWIM2 — local, agent NÃO é kind:local (sentinela/sinônimo de tier) ⇒ erro GS-MD7 mantido', () => {
  it('agent="inherit" (sentinela de herança) ⇒ não roteia, erro de agente desconhecido', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', agent: 'inherit' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
      localModelCatalog: { listNames: () => ['inherit'] }, // mesmo "presente", não é kind:'local'
    });
    await controller.submit('spawn com agent=inherit');

    expect(localCalls).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(captured.messages ?? '').toMatch(/desconhecido/);
    expect(captured.messages ?? '').toMatch(/GS-MD7/);
  });

  it('agent="opus" (sinônimo de TIER, não slug local) ⇒ não roteia, erro de agente desconhecido', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', agent: 'opus' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
      localModelCatalog: { listNames: () => ['opus'] },
    });
    await controller.submit('spawn com agent=opus');

    expect(localCalls).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(captured.messages ?? '').toMatch(/desconhecido/);
  });
});

describe('T-DWIM3 — agent=.md REAL existente ⇒ inalterado (DWIM não toca)', () => {
  it('roda o perfil do .md normalmente, sem passar pelo DWIM', async () => {
    const registry = new AgentRegistry([globalProfile('helper', 'local:deepseek-v4-flash')], []);
    const localLog: string[] = [];
    const model = parentDelegates({ agents: [{ label: 'x', goal: 'g', agent: 'helper' }] });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: registry,
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      // catálogo NÃO contém "helper" — se o DWIM disparasse por engano, falharia a
      // confirmação de catálogo; como o .md resolve, o catálogo nem é consultado p/ isto.
      localModelCatalog: { listNames: () => ['deepseek-v4-flash'] },
    });
    await controller.submit('delegue ao helper (agente .md real)');

    expect(localLog).toEqual(['LOCAL:deepseek-v4-flash']);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'x')?.status).toBe('done');
    // nenhuma nota de DWIM — o .md resolveu de cara, sem reinterpretação.
    expect(dwimNote(controller.current.blocks)).toBeUndefined();
  });
});

describe('T-DWIM4 — local, agent com CR/LF/NUL ⇒ isReasonableModelSlug falha ⇒ não roteia, erro GS-MD7 sem linha nova', () => {
  it('slug malformado (CRLF) no campo agent ⇒ callerForLocalModel nunca chamada; erro original intacto', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', agent: 'evil\r\nX-Injected: 1' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
      localModelCatalog: { listNames: () => ['evil'] },
    });
    await controller.submit('spawn com agent malformado (CRLF)');

    expect(localCalls).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(dwimNote(controller.current.blocks)).toBeUndefined();
    expect(captured.messages ?? '').toMatch(/desconhecido/);
    expect(captured.messages ?? '').not.toMatch(/interpretei/i);
  });
});

describe('T-DWIM5 — local, agent=slug válido AUSENTE do catálogo listável, sem .md ⇒ NÃO roteia; erro GS-MD7', () => {
  it('erro é "agente desconhecido", não "modelo local desconhecido"', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', agent: 'deepseek/deepseek-v4-flash' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
      // catálogo LISTÁVEL, mas SEM o slug pedido.
      localModelCatalog: { listNames: () => ['outro-modelo'] },
    });
    await controller.submit('spawn com slug ausente do catálogo');

    expect(localCalls).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(dwimNote(controller.current.blocks)).toBeUndefined();
    const msg = captured.messages ?? '';
    expect(msg).toMatch(/agente/);
    expect(msg).toMatch(/deepseek\/deepseek-v4-flash/);
    expect(msg).toMatch(/desconhecido/);
    expect(msg).not.toMatch(/modelo local/i);
  });
});

describe('T-DWIM6 — local, catálogo NÃO listável, agent=slug válido, sem .md ⇒ NÃO roteia; erro GS-MD7', () => {
  it('sem localModelCatalog injetado ⇒ não auto-roteia (sem warn-but-allow p/ inferência)', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', agent: 'deepseek-v4-flash' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
      // SEM localModelCatalog — "não listável".
    });
    await controller.submit('spawn sem catálogo listável');

    expect(localCalls).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(dwimNote(controller.current.blocks)).toBeUndefined();
    expect(captured.messages ?? '').toMatch(/desconhecido/);
  });

  it('catálogo LISTÁVEL mas listNames() devolve undefined ⇒ idem, não auto-roteia', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', agent: 'deepseek-v4-flash' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
      localModelCatalog: { listNames: () => undefined },
    });
    await controller.submit('spawn — catálogo declarado vazio');

    expect(localCalls).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(captured.messages ?? '').toMatch(/desconhecido/);
  });
});

describe('T-DWIM7 — local, agent=slug inexistente E model=explícito diferente ⇒ agent não clobba model; erro do agent bogus mantido', () => {
  it('precedência ADR-0146 intacta: model explícito não é usado nem sobrescrito', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      {
        agents: [
          { label: 'x', goal: 'g', agent: 'bogus-agent-name', model: 'deepseek-v4-pro' },
        ],
      },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
      // catálogo contém o slug do "agent" bogus — se a precedência falhasse, isto
      // seria o que faria o DWIM (erradamente) rotear.
      localModelCatalog: { listNames: () => ['bogus-agent-name', 'deepseek-v4-pro'] },
    });
    await controller.submit('spawn com agent bogus + model explícito');

    expect(localCalls).toHaveLength(0); // NUNCA chamado — nem com o agent nem com o model
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(dwimNote(controller.current.blocks)).toBeUndefined();
    const msg = captured.messages ?? '';
    expect(msg).toMatch(/agente/);
    expect(msg).toMatch(/bogus-agent-name/);
    expect(msg).toMatch(/desconhecido/);
  });
});

describe('T-DWIM8 — backend broker, agent=slug que SERIA local sob local, sem .md ⇒ NÃO roteia; erro GS-MD7 (zero regressão)', () => {
  it('sob backend broker o DWIM nunca dispara', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', agent: 'deepseek/deepseek-v4-flash' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: BROKER_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
      localModelCatalog: { listNames: () => ['deepseek/deepseek-v4-flash'] },
    });
    await controller.submit('spawn sob backend broker');

    expect(localCalls).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(dwimNote(controller.current.blocks)).toBeUndefined();
    expect(captured.messages ?? '').toMatch(/desconhecido/);
  });
});

describe('T-DWIM9 — local, agent="custom"/"local" (degenerado sem slug), sem .md ⇒ NÃO roteia; erro GS-MD7', () => {
  it('agent="local" (sentinela sem slug) ⇒ não roteia', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', agent: 'local' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
      localModelCatalog: { listNames: () => ['local'] },
    });
    await controller.submit('spawn com agent=local (degenerado)');

    expect(localCalls).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(captured.messages ?? '').toMatch(/desconhecido/);
  });

  it('agent="custom" (sentinela sem slug) ⇒ não roteia', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', agent: 'custom' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
      localModelCatalog: { listNames: () => ['custom'] },
    });
    await controller.submit('spawn com agent=custom (degenerado)');

    expect(localCalls).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(captured.messages ?? '').toMatch(/desconhecido/);
  });
});

describe('T-DWIM10 — pós-DWIM: filho não se apresenta como agente nomeado; toolScope ⊆ pai; catraca effect:exec intacta', () => {
  it('rótulo/model do filho não citam "agente" nomeado; run_command tentado pelo filho é NEGADO pela mesma catraca do pai', async () => {
    const localLog: string[] = [];
    const { ports, ran } = fakePorts();
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', agent: 'deepseek-v4-flash' }],
    });
    const askApproveSpawnDenyEffect = {
      async resolve(request: { readonly call: { readonly name: string } }) {
        return request.call.name === SPAWN_AGENT_TOOL_NAME
          ? ({ kind: 'approve-once' } as const)
          : ({ kind: 'deny' } as const);
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'normal' }),
      ports,
      askResolver: askApproveSpawnDenyEffect,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => localEffectCaller(`LOCAL:${slug}`, localLog),
      localModelCatalog: { listNames: () => ['deepseek-v4-flash'] },
    });
    await controller.submit('spawn DWIM — o filho tenta um efeito, a catraca do pai nega');

    // o filho FALOU pelo caller local (o roteamento aconteceu)…
    expect(localLog.length).toBeGreaterThan(0);
    // …mas o EFEITO (run_command) foi NEGADO pela MESMA catraca do pai — nada executou.
    expect(ran).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    const child = block?.children.find((c) => c.label === 'x');
    expect(child?.status).toBe('done');
    // rótulo continua o que o PAI deu ("x") — nunca o nome do "agente" pedido.
    expect(child?.label).toBe('x');
    // o rótulo de modelo mostra SÓ o slug local, não um nome de agente nomeado.
    expect(child?.model).toBe('local · deepseek-v4-flash');
    // nenhum campo de credencial/provider/endpoint vazou.
    const serialized = JSON.stringify(controller.current);
    expect(serialized).not.toMatch(/\b(base_?url|api[_-]?key|token|secret|authorization)\b/i);
  });
});

describe('T-DWIM11 — local, agent="deepseek/deepseek-v4-flash" (slug com `/`) presente no catálogo ⇒ roteia (rc.104 destrava `/`)', () => {
  it('slug com barra roteia via DWIM; variante com CRLF segue rejeitada', async () => {
    const localLog: string[] = [];
    const localCalls: string[] = [];
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', agent: 'deepseek/deepseek-v4-flash' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, localLog);
      },
      localModelCatalog: { listNames: () => ['deepseek/deepseek-v4-flash'] },
    });
    await controller.submit('spawna sub-agente no modelo deepseek/deepseek-v4-flash');

    expect(localCalls).toEqual(['deepseek/deepseek-v4-flash']);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'x')?.status).toBe('done');
  });

  it('variante CRLF no mesmo formato vendor/model ⇒ segue rejeitada (não roteia)', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', agent: 'deepseek/deepseek-v4-flash\r\nX-Injected: 1' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
      localModelCatalog: {
        listNames: () => ['deepseek/deepseek-v4-flash\r\nX-Injected: 1'],
      },
    });
    await controller.submit('spawn com slug CRLF no formato vendor/model');

    expect(localCalls).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(captured.messages ?? '').toMatch(/desconhecido/);
  });
});
