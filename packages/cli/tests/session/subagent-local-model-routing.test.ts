// ADR-0152 (D6) — roteamento de um SUB-AGENTE a um MODELO LOCAL específico do
// MESMO provider do pai (backend `local`/BYO direto, ADR-0120). Slug cru
// (`deepseek-v4-flash`) sob backend local vira `kind:'local'` (ergonomia BYO);
// `local:<slug>`/`custom:<slug>`-sob-local são a forma explícita/alias. O filho
// roda no MESMO provider/auth/base_url/fetch-pinado do pai, só o `model` muda —
// via a porta `callerForLocalModel`, análoga a `callerForTier`/`customCallerFor`
// (ADR-0146). Probe local (D6c) fail-closed quando o catálogo é LISTÁVEL; warn-
// but-allow (aviso VISÍVEL) quando não é.
//
// Testado DIRETO no `SessionController` (mesmo padrão de `subagent-model-
// adr0146.test.ts`), com `callerForLocalModel`/`localModelCatalog` FAKES que
// MARCAM cada chamada — provamos o ROTEAMENTO e as condições de segurança do
// gate `seguranca` (T1-T9 do DoD), não o provider real.

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

/** Caller LOCAL que SEMPRE pede leitura (loop até o teto — p/ provar E-A2 agregado). */
function loopingLocalCaller(tag: string, log: string[]): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      log.push(tag);
      return {
        request_id: 'r',
        content: toolCall('read_file', { path: 'a' }),
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

describe('ADR-0152 (D6) — precedência e fontes: spawn / `.md` / dial de config', () => {
  it('spawn com model:"deepseek-v4-flash" CRU sob backend local ⇒ roteia via callerForLocalModel (ergonomia BYO)', async () => {
    const localLog: string[] = [];
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', model: 'deepseek-v4-flash' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
    });
    await controller.submit('spawna no deepseek-v4-flash');
    expect(localLog).toEqual(['LOCAL:deepseek-v4-flash']);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'x')?.status).toBe('done');
  });

  it('spawn com model:"local:<slug>" (prefixo explícito) ⇒ roteia igual', async () => {
    const localLog: string[] = [];
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', model: 'local:deepseek-v4-flash' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
    });
    await controller.submit('spawn explícito');
    expect(localLog).toEqual(['LOCAL:deepseek-v4-flash']);
  });

  it('`.md` de agente nomeado com model:"local:x" ⇒ roteia via callerForLocalModel', async () => {
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
    });
    await controller.submit('delegue ao helper (model local no .md)');
    expect(localLog).toEqual(['LOCAL:deepseek-v4-flash']);
  });

  it('dial global (defaultChildModel) com slug local CRU ⇒ default dos filhos (posição 3 da precedência)', async () => {
    const localLog: string[] = [];
    const model = parentDelegates({ agents: [{ label: 'x', goal: 'g' }] }); // SEM model
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      defaultChildModel: 'deepseek-v4-flash',
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
    });
    await controller.submit('spawn sem model — cai no dial local');
    expect(localLog).toEqual(['LOCAL:deepseek-v4-flash']);
  });

  it('kind:"local" com o PAI NÃO em backend local ⇒ erro legível ANTES de rodar (fail-closed)', async () => {
    const captured: { messages?: string } = {};
    const localLog: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', model: 'local:deepseek-v4-flash' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 }, // SEM backend local
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
    });
    await controller.submit('spawn local fora de sessão local');
    expect(localLog).toHaveLength(0); // nunca rodou
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(captured.messages ?? '').toMatch(/backend/i);
    expect(captured.messages ?? '').toMatch(/local/i);
  });
});

describe('T1 — nenhuma fonte injeta provider/base_url/api_key nem amplia o toolset do filho', () => {
  it('spawn/`.md`/config com slug local ⇒ toolset do filho ⊆ pai; spawn_agent NEGADO no filho', async () => {
    const registry = new AgentRegistry(
      [globalProfile('helper', 'local:deepseek-v4-flash')],
      [],
    );
    const { ports, ran } = fakePorts();
    const localLog: string[] = [];
    // 3 filhos: um via param do spawn, um via `.md`, um via dial de config — os TRÊS
    // tentam `spawn_agent` (netos, E-A1) e `run_command` FORA de qualquer toolScope
    // declarado; nenhum deve conseguir (catraca do filho é SEMPRE ⊆ pai).
    const model = parentDelegates({
      agents: [
        { label: 'a', goal: 'g', model: 'deepseek-v4-flash' },
        { label: 'b', goal: 'g', agent: 'helper' },
        { label: 'c', goal: 'g' }, // cai no dial
      ],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true, maxConcurrency: 3 },
      agentRegistry: registry,
      defaultChildModel: 'deepseek-v4-flash',
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      // catálogo LISTÁVEL e com match ⇒ sem a nota de warn-but-allow (T7 testa essa
      // nota em separado); aqui o foco é SÓ o anti-leak de credencial/endpoint.
      localModelCatalog: { listNames: () => ['deepseek-v4-flash'] },
    });
    await controller.submit('lote misto local — nenhum escala capacidade');

    // todos os 3 rodaram (nenhum foi barrado pelo ROTEAMENTO em si).
    expect(localLog.sort()).toEqual([
      'LOCAL:deepseek-v4-flash',
      'LOCAL:deepseek-v4-flash',
      'LOCAL:deepseek-v4-flash',
    ]);
    // NENHUM comando de efeito rodou fora da catraca do filho (spawn_agent NEGADO,
    // run_command não foi tentado por este caller-fake — mas o toolset em si já não
    // inclui spawn_agent p/ filhos, E-A1). Nenhum comando shell veio de um "neto".
    expect(ran).toHaveLength(0);
    // Nenhum campo de credencial/base_url/api_key/endpoint vazou no estado. (O NOME
    // "provider" pode aparecer em PROSA de UI legítima — ver T7 — mas não aqui, já
    // que o catálogo listável evita a nota; então checar a palavra tb é seguro.)
    const serialized = JSON.stringify(controller.current);
    expect(serialized).not.toMatch(/\b(provider|base_?url|api[_-]?key|token|secret|authorization)\b/i);
  });
});

describe('T2 — probe LOCAL listável: erro do slug typo contém SÓ nomes + sugestão (sem leak)', () => {
  it('slug com typo ⇒ erro por-filho ANTES do fan-out, com sugestão; NUNCA base_url/host/provider/api_key/token', async () => {
    const captured: { messages?: string } = {};
    const localLog: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', model: 'deepseek-v4-flsh' }] }, // typo
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      localModelCatalog: {
        listNames: () => ['deepseek-v4-pro', 'deepseek-v4-flash'],
      },
    });
    await controller.submit('spawn com typo no slug local');

    expect(localLog).toHaveLength(0); // fail-closed ANTES de rodar
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    const msg = captured.messages ?? '';
    expect(msg).toMatch(/deepseek-v4-flsh/); // o slug pedido
    expect(msg).toMatch(/deepseek-v4-flash/); // sugestão por distância de edição
    expect(msg).toMatch(/não encontrado/);
    // regex de NEGAÇÃO sobre o config real — nunca provider/host/base_url/api_key/token.
    expect(msg).not.toMatch(/\b(provider|base_?url|host|api[_-]?key|token|secret|authorization)\b/i);
  });
});

describe('T3 — snapshot de sessão local com filho roteado', () => {
  it('mostra "local · deepseek-v4-flash" e NENHUM campo de credencial/provider/endpoint', async () => {
    const localLog: string[] = [];
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', model: 'deepseek-v4-flash' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      // catálogo listável + match ⇒ sem a nota de warn-but-allow (que legitimamente
      // usa a palavra "provider" em prosa — ver T7); aqui o foco é o anti-leak.
      localModelCatalog: { listNames: () => ['deepseek-v4-flash'] },
    });
    await controller.submit('spawn roteado a modelo local — snapshot');

    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'x')?.model).toBe('local · deepseek-v4-flash');

    const serialized = JSON.stringify(controller.current);
    expect(serialized).not.toMatch(/\b(provider|base_?url|api[_-]?key|token|secret|authorization)\b/i);
  });
});

describe('T5 — forma do slug (condição de segurança 3, REVISADA): `vendor/model` ROTEIA; CRLF/NUL/control SEGUEM rejeitados em TODA fonte', () => {
  it('slug com barra (`vendor/model`) em CADA fonte (spawn/`.md`) ⇒ ROTEIA via callerForLocalModel (body-only, sem risco de path/header)', async () => {
    const registry = new AgentRegistry(
      [globalProfile('helper', 'local:vendor/model-c')], // `.md` com barra — agora forma VÁLIDA
      [],
    );
    const localLog: string[] = [];
    const localCalls: string[] = [];
    const model = parentDelegates({
      agents: [
        { label: 'a', goal: 'g', model: 'local:vendor/model-a' }, // spawn com barra
        { label: 'c', goal: 'g', agent: 'helper' }, // .md com barra
      ],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true, maxConcurrency: 2 },
      agentRegistry: registry,
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, localLog);
      },
    });
    await controller.submit('lote com slugs vendor/model em 2 fontes');

    // AMBOS chegaram a chamar `callerForLocalModel` — `/` não é mais barrado (a
    // validação de forma só barra control chars/CR/LF/NUL/TAB/DEL/vazio/teto).
    expect(localCalls.sort()).toEqual(['vendor/model-a', 'vendor/model-c']);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'a')?.status).toBe('done');
    expect(block?.children.find((c) => c.label === 'c')?.status).toBe('done');
  });

  it('CRLF/NUL em CADA fonte (spawn/`.md`) ⇒ callerForLocalModel NUNCA é chamada com o slug malformado', async () => {
    const registry = new AgentRegistry(
      [globalProfile('helper', 'local:evil\r\nX-Injected: 1')], // `.md` malformado (CRLF)
      [],
    );
    const localLog: string[] = [];
    const localCalls: string[] = [];
    const captured: { messages?: string } = {};
    const model = parentDelegates(
      {
        agents: [
          { label: 'a', goal: 'g', model: `local:evil\r\nX-Injected: 1` }, // spawn malformado (CRLF)
          { label: 'b', goal: 'g', model: 'local:evil' + String.fromCharCode(0) + 'x' }, // spawn malformado (NUL)
          { label: 'c', goal: 'g', agent: 'helper' }, // .md malformado (CRLF)
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
      subAgents: { enabled: true, maxConcurrency: 3 },
      agentRegistry: registry,
      // config dial (3ª fonte) TAMBÉM malformado, testado em separado abaixo.
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, localLog);
      },
    });
    await controller.submit('lote com slugs malformados (CRLF/NUL) nas 3 fontes');

    // NENHUM filho chegou a chamar `callerForLocalModel` com um slug malformado —
    // e de fato NENHUM chegou a rodar (cada um virou erro "unknown", D2 padrão).
    // Isto é a PROVA de que control/CRLF/NUL seguem barrados após o relaxamento de `/`/`:`.
    expect(localCalls).toHaveLength(0);
    expect(localLog).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children ?? []).toHaveLength(0);
    const msg = captured.messages ?? '';
    expect(msg).toMatch(/não encontrado/);
  });

  it('dial de config (3ª fonte) com slug CRLF ⇒ idem: NUNCA vira config.model (control/CRLF seguem barrados)', async () => {
    const localCalls: string[] = [];
    const captured: { messages?: string } = {};
    const model = parentDelegates({ agents: [{ label: 'x', goal: 'g' }] }, captured); // SEM model
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      defaultChildModel: 'bad\r\nslug-from-config',
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
    });
    await controller.submit('spawn — dial de config malformado (CRLF)');
    expect(localCalls).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children ?? []).toHaveLength(0);
    expect(captured.messages ?? '').toMatch(/não encontrado/);
  });
});

describe('T6 — catálogo listável: um filho com slug typo ⇒ ok:false ANTES do fan-out; irmãos vivos', () => {
  it('2 filhos, um bom e um com typo ⇒ o bom RODA (no seu slug), o typo falha SEM derrubar o bom', async () => {
    const localLog: string[] = [];
    const model = parentDelegates({
      agents: [
        { label: 'bom', goal: 'g1', model: 'deepseek-v4-flash' },
        { label: 'ruim', goal: 'g2', model: 'deepseek-v4-flsh' }, // typo
      ],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true, maxConcurrency: 2 },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      localModelCatalog: { listNames: () => ['deepseek-v4-pro', 'deepseek-v4-flash'] },
    });
    await controller.submit('lote misto: bom + typo');

    expect(localLog).toEqual(['LOCAL:deepseek-v4-flash']); // só o bom chamou o caller
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'bom')?.status).toBe('done');
    expect(block?.children.some((c) => c.label === 'ruim')).toBe(false); // nunca spawnado
  });
});

describe('T7 — catálogo NÃO listável: aviso aparece na superfície VISÍVEL ao usuário', () => {
  it('SEM localModelCatalog injetado ⇒ warn-but-allow com NOTA visível (não só log) e o filho RODA', async () => {
    const localLog: string[] = [];
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', model: 'deepseek-v4-flash' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      // SEM localModelCatalog — "não listável".
    });
    await controller.submit('spawn local sem catálogo listável');

    expect(localLog).toEqual(['LOCAL:deepseek-v4-flash']); // roda mesmo assim
    const note = controller.current.blocks.find(
      (b): b is NoteBlock => b.kind === 'note' && b.title === 'spawn_agent',
    );
    expect(note).toBeDefined();
    expect(note!.lines.join(' ')).toMatch(/não deu para confirmar/);
    expect(note!.lines.join(' ')).toMatch(/deepseek-v4-flash/);
    // A nota PODE dizer "provider" em prosa genérica (é o texto canônico do ADR:
    // "...no catálogo do provider local...o provider valida na 1ª chamada" — isto
    // NÃO é uma credencial). O que NUNCA pode aparecer é base_url/api_key/token/
    // secret/authorization/host — o VALOR de uma credencial/endpoint concreto.
    expect(note!.lines.join(' ')).not.toMatch(
      /\b(base_?url|api[_-]?key|token|secret|authorization|host)\b/i,
    );
  });

  it('catálogo LISTÁVEL, mas listNames() devolve undefined (provider sem modelos declarados) ⇒ mesmo warn-but-allow', async () => {
    const localLog: string[] = [];
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', model: 'deepseek-v4-flash' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      localModelCatalog: { listNames: () => undefined },
    });
    await controller.submit('spawn local — catálogo declarado vazio');
    expect(localLog).toEqual(['LOCAL:deepseek-v4-flash']);
    const note = controller.current.blocks.find(
      (b): b is NoteBlock => b.kind === 'note' && b.title === 'spawn_agent',
    );
    expect(note).toBeDefined();
  });
});

describe('T8 — filho roteado a modelo local passa pela decide() do pai (modo/budget agregado)', () => {
  it('a catraca do PAI (ask sempre-ask) NEGA o efeito tentado pelo filho roteado a modelo local', async () => {
    // `spawn_agent` (effect:'exec') SOB modo Plan é NEGADO ao PRÓPRIO PAI antes de
    // qualquer filho nascer (Plan não tem allow-list p/ tools de efeito) — não dá
    // p/ provar "o filho herda Plan" via um `submit()` completo (o teste PURO de
    // `childEngineOf` com mode:'plan' em `subagent-per-model.test.ts` prova essa
    // herança no mecanismo exato que o spawner usa). Aqui provamos a MESMA garantia
    // (decide() do pai governa o filho, mesmo roteado a outro MODELO) por uma via
    // que É alcançável ponta-a-ponta: modo 'normal' (ask), com um resolver que
    // aprova SÓ o `spawn_agent` do pai e NEGA qualquer outro efeito — o filho
    // roteado a local tenta `run_command` e é negado, igual a um filho comum.
    const localLog: string[] = [];
    const { ports, ran } = fakePorts();
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', model: 'deepseek-v4-flash' }],
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
      callerForLocalModel: (slug) => localEffectCaller(`LOCAL:${slug}`, localLog),
    });
    await controller.submit('spawn local — o filho tenta um efeito, a catraca do pai nega');

    // o filho FALOU pelo caller local (roteamento aconteceu)…
    expect(localLog.length).toBeGreaterThan(0);
    // …mas o EFEITO (run_command) foi NEGADO pela MESMA catraca do pai — nada executou.
    expect(ran).toHaveLength(0);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'x')?.status).toBe('done');
  });

  it('SharedBudget AGREGADO (E-A2): o teto compartilhado conta o filho roteado a local junto com o pai', async () => {
    const localLog: string[] = [];
    const { ports } = fakePorts();
    // pai delega 1 filho local que LÊ EM LOOP (nunca conclui sozinho); teto baixo
    // agregado — a sessão para por budget, não roda indefinidamente.
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'leia em loop', model: 'deepseek-v4-flash' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => loopingLocalCaller(`LOCAL:${slug}`, localLog),
      limits: { maxIterations: 6, maxToolCalls: 100, maxTokens: 1_000_000 },
    });
    await controller.submit('leia em loop — deve parar no teto agregado');

    expect(localLog.length).toBeGreaterThan(0); // o filho local rodou (debitou do agregado)
    expect(['budget', 'done']).toContain(controller.current.phase);
  });
});

describe('T9 (nível-controller) — zero regressão sob backend broker/ausente: slug cru NÃO promove a local', () => {
  it('backend broker + slug cru desconhecido ⇒ erro "unknown" padrão (ADR-0146); callerForLocalModel NUNCA chamada', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', model: 'gpt-9-turbo' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-flux', backend: 'broker', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      // callerForLocalModel injetada MESMO ASSIM (ex.: teste com opts sobrando) — não
      // deve ser usada sob broker; a promoção a "local" só vale sob backend local.
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
    });
    await controller.submit('spawn com nome inválido sob broker');
    expect(localCalls).toHaveLength(0);
    expect(captured.messages ?? '').toMatch(/gpt-9-turbo/);
    expect(captured.messages ?? '').toMatch(/não deu para confirmar no catálogo|não encontrado/);
  });

  it('SEM backend explícito (default hospedado) + slug cru ⇒ idem — comportamento intocado', async () => {
    const captured: { messages?: string } = {};
    const localCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', model: 'deepseek-v4-flash' }] },
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 }, // SEM backend
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => {
        localCalls.push(slug);
        return taggedCaller(`LOCAL:${slug}`, []);
      },
    });
    await controller.submit('spawn sob sessão hospedada default');
    expect(localCalls).toHaveLength(0); // NUNCA promovido a local
    expect(captured.messages ?? '').toMatch(/deepseek-v4-flash/);
    expect(captured.messages ?? '').toMatch(/não encontrado/);
  });
});
