// ADR-0153 — TEST-THEN-REGISTER de modelo LOCAL desconhecido, testado no `controller.ts`
// (ramo `kind:'local'` de `spawnNamed`). Mesmo padrão de
// `subagent-local-model-routing.test.ts` (ADR-0152 D6): `SessionController` direto,
// `verifyAndRegisterLocalModel`/`localModelCatalog`/`callerForLocalModel` FAKES que
// MARCAM cada chamada — provamos o ROTEAMENTO e as condições de segurança do gate
// `seguranca` (testes 5, 6, 8, 10, 11 do parecer; 1/2/3/4/7/9 vivem em
// `tests/model/local/connectivity-check.test.ts` + `test-then-register.test.ts` +
// `tests/io/user-config.test.ts`, onde a peça relevante é testável isolada).

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

const askAutoApprove = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

const LOCAL_META = {
  cwd: '/proj',
  tier: 'aluy-flux',
  backend: 'local' as const,
  activeModel: 'deepseek/deepseek-v4-pro',
  tokens: 0,
  windowPct: 0,
};

/** Porta TTR fake: registra chamadas, resolve `ok` p/ os slugs em `okSlugs`. */
function fakeTtrPort(opts: {
  readonly okSlugs: readonly string[];
  readonly calls: string[];
  /** Se presente, o slug OK é adicionado aqui (simula a união sessão do run.tsx real). */
  readonly sessionRegistered?: Set<string>;
}): (slug: string) => Promise<{ ok: boolean; detail: string; registered: boolean }> {
  return async (slug: string) => {
    opts.calls.push(slug);
    if (opts.okSlugs.includes(slug)) {
      opts.sessionRegistered?.add(slug);
      return {
        ok: true,
        detail: `modelo "${slug}" respondeu — registrado no catálogo do provider local.`,
        registered: true,
      };
    }
    return { ok: false, detail: `modelo local "${slug}" não respondeu: HTTP 404 — modelo ou baseURL errado?`, registered: false };
  };
}

describe('ADR-0153 — slug DESCONHECIDO: test-then-register (ok ⇒ registra+roteia; !ok ⇒ erro por-filho)', () => {
  it('ok:true ⇒ nota "testando…" + nota de sucesso + o filho ROTEIA via callerForLocalModel', async () => {
    const localLog: string[] = [];
    const ttrCalls: string[] = [];
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', model: 'deepseek/deepseek-v4-flash' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      localModelCatalog: { listNames: () => ['deepseek/deepseek-v4-pro'] }, // slug NÃO está aqui
      verifyAndRegisterLocalModel: fakeTtrPort({
        okSlugs: ['deepseek/deepseek-v4-flash'],
        calls: ttrCalls,
      }),
    });
    await controller.submit('spawn com slug desconhecido — deve testar e registrar');

    expect(ttrCalls).toEqual(['deepseek/deepseek-v4-flash']); // 1 teste
    expect(localLog).toEqual(['LOCAL:deepseek/deepseek-v4-flash']); // roteou
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'x')?.status).toBe('done');

    const notes = controller.current.blocks.filter(
      (b): b is NoteBlock => b.kind === 'note' && b.title === 'spawn_agent',
    );
    const noteText = notes.flatMap((n) => n.lines).join(' | ');
    expect(noteText).toMatch(/testando modelo "deepseek\/deepseek-v4-flash"/);
    expect(noteText).toMatch(/respondeu — registrado/);
  });

  it('ok:false ⇒ erro por-filho ANTES do fan-out (não spawnado); a porta NÃO roteia', async () => {
    const localLog: string[] = [];
    const ttrCalls: string[] = [];
    const captured: { messages?: string } = {};
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', model: 'deepseek/deepseek-v4-nope' }] },
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
      localModelCatalog: { listNames: () => ['deepseek/deepseek-v4-pro'] },
      verifyAndRegisterLocalModel: fakeTtrPort({ okSlugs: [], calls: ttrCalls }),
    });
    await controller.submit('spawn com slug que falha no teste vivo');

    expect(ttrCalls).toEqual(['deepseek/deepseek-v4-nope']);
    expect(localLog).toHaveLength(0); // NUNCA roteou
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    expect(captured.messages ?? '').toMatch(/não respondeu/);
    expect(captured.messages ?? '').toMatch(/HTTP 404/);
  });

  it('TESTE DE SEGURANÇA 9 — lote misto: 1 filho com slug 404 (ou credencial ausente) falha, o(s) IRMÃO(S) completam; nenhuma exception escapa do lote', async () => {
    const localLog: string[] = [];
    const ttrCalls: string[] = [];
    const model = parentDelegates({
      agents: [
        { label: 'bom', goal: 'g1', model: 'deepseek/deepseek-v4-pro' }, // JÁ conhecido — nem testa
        { label: 'ruim-404', goal: 'g2', model: 'deepseek/deepseek-v4-nope' }, // teste falha (HTTP 404)
        { label: 'ruim-cred', goal: 'g3', model: 'vendor/sem-credencial' }, // teste "lança" (fail-closed)
      ],
    });
    // porta que simula: 404 p/ um slug, THROW (credencial ausente) p/ outro — nenhum
    // dos dois pode derrubar o lote nem o filho "bom".
    const verifyAndRegisterLocalModel = async (slug: string) => {
      ttrCalls.push(slug);
      if (slug === 'vendor/sem-credencial') {
        // A fábrica REAL (test-then-register.ts) converte qualquer throw em
        // {ok:false} — aqui simulamos já o CONTRATO da porta (a fábrica é testada
        // em isolamento em `test-then-register.test.ts`, teste "fail-closed").
        return {
          ok: false,
          detail: 'modelo local "vendor/sem-credencial" não respondeu (rede/baseURL, ou egress bloqueado pelo anti-SSRF).',
          registered: false,
        };
      }
      return {
        ok: false,
        detail: 'modelo local "deepseek/deepseek-v4-nope" não respondeu: HTTP 404 — modelo ou baseURL errado?',
        registered: false,
      };
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true, maxConcurrency: 3 },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      localModelCatalog: { listNames: () => ['deepseek/deepseek-v4-pro'] },
      verifyAndRegisterLocalModel,
    });
    // NENHUMA exception escapa do submit — o lote conclui normalmente.
    await expect(controller.submit('lote misto: bom (conhecido) + 2 ruins (TTR)')).resolves.not.toThrow();

    expect(ttrCalls.sort()).toEqual(['deepseek/deepseek-v4-nope', 'vendor/sem-credencial']);
    expect(localLog).toEqual(['LOCAL:deepseek/deepseek-v4-pro']); // só o bom rodou
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.find((c) => c.label === 'bom')?.status).toBe('done');
    expect(block?.children.some((c) => c.label === 'ruim-404')).toBe(false); // nunca spawnado
    expect(block?.children.some((c) => c.label === 'ruim-cred')).toBe(false); // nunca spawnado
  });

  it('!ok inclui SUGESTÃO por distância de edição sobre os names (catálogo declarado)', async () => {
    const captured: { messages?: string } = {};
    const ttrCalls: string[] = [];
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', model: 'deepseek/deepseek-v4-flsh' }] }, // typo
      captured,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, []),
      localModelCatalog: {
        listNames: () => ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash'],
      },
      verifyAndRegisterLocalModel: fakeTtrPort({ okSlugs: [], calls: ttrCalls }),
    });
    await controller.submit('spawn com typo — porta testa, falha, sugere');

    expect(ttrCalls).toEqual(['deepseek/deepseek-v4-flsh']);
    const msg = captured.messages ?? '';
    expect(msg).toMatch(/quis dizer/);
    expect(msg).toMatch(/deepseek\/deepseek-v4-flash/);
    expect(msg).toMatch(/Disponíveis:/);
  });
});

describe('TESTE DE SEGURANÇA 6 (nível-controller) — slug JÁ CONHECIDO não testa; N filhos mesmo slug ⇒ 1 teste', () => {
  it('slug já no catálogo declarado ⇒ ROTEIA direto, ZERO chamadas à porta TTR', async () => {
    const localLog: string[] = [];
    const ttrCalls: string[] = [];
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', model: 'deepseek/deepseek-v4-pro' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      localModelCatalog: { listNames: () => ['deepseek/deepseek-v4-pro'] },
      verifyAndRegisterLocalModel: fakeTtrPort({ okSlugs: ['deepseek/deepseek-v4-pro'], calls: ttrCalls }),
    });
    await controller.submit('spawn com slug JÁ conhecido — não deve testar');

    expect(ttrCalls).toHaveLength(0); // 0 pings
    expect(localLog).toEqual(['LOCAL:deepseek/deepseek-v4-pro']); // roteou direto
  });

  it('N filhos pedindo o MESMO slug desconhecido no MESMO lote ⇒ 1 SÓ teste (o loop sequencial já vê "conhecido" após o 1º ok)', async () => {
    const localLog: string[] = [];
    const ttrCalls: string[] = [];
    // `sessionRegistered` simula EXATAMENTE o que `run.tsx` faz de verdade: o Set
    // que `localModelCatalog.listNames()` une, atualizado pela porta ao registrar.
    const sessionRegistered = new Set<string>();
    const model = parentDelegates({
      agents: [
        { label: 'a', goal: 'g', model: 'vendor/model-novo' },
        { label: 'b', goal: 'g', model: 'vendor/model-novo' },
        { label: 'c', goal: 'g', model: 'vendor/model-novo' },
      ],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true, maxConcurrency: 3 },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      // UNIÃO declarado(vazio) ∪ sessionRegistered — como `run.tsx` monta de fato (D2).
      localModelCatalog: { listNames: () => (sessionRegistered.size > 0 ? [...sessionRegistered] : undefined) },
      verifyAndRegisterLocalModel: fakeTtrPort({
        okSlugs: ['vendor/model-novo'],
        calls: ttrCalls,
        sessionRegistered,
      }),
    });
    await controller.submit('3 filhos, mesmo slug desconhecido — 1 teste só');

    // spawnNamed resolve os perfis SEQUENCIALMENTE (comentário do próprio controller):
    // o 1º filho testa (ok, registra na sessão); o 2º/3º já veem "conhecido" via
    // `localModelCatalog.listNames()` e NÃO chamam a porta de novo.
    expect(ttrCalls).toEqual(['vendor/model-novo']);
    expect(localLog.sort()).toEqual([
      'LOCAL:vendor/model-novo',
      'LOCAL:vendor/model-novo',
      'LOCAL:vendor/model-novo',
    ]);
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children).toHaveLength(3);
    expect(block?.children.every((c) => c.status === 'done')).toBe(true);
  });
});

describe('TESTE DE SEGURANÇA 5 (nível-controller) — CRLF/NUL/control NUNCA chega à porta TTR', () => {
  it('slug com CRLF/NUL em spawn/`.md`/dial de config ⇒ resolveModelTier dá kind:"unknown"; verifyAndRegisterLocalModel NUNCA chamada', async () => {
    const registry = new AgentRegistry(
      [globalProfile('helper', 'local:evil\r\nX-Injected: 1')], // `.md` malformado
      [],
    );
    const ttrCalls: string[] = [];
    const captured: { messages?: string } = {};
    const model = parentDelegates(
      {
        agents: [
          { label: 'a', goal: 'g', model: `local:evil\r\nX-Injected: 1` }, // spawn CRLF
          { label: 'b', goal: 'g', model: 'local:evil' + String.fromCharCode(0) + 'x' }, // spawn NUL
          { label: 'c', goal: 'g', agent: 'helper' }, // .md CRLF
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
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, []),
      localModelCatalog: { listNames: () => ['deepseek/deepseek-v4-pro'] },
      verifyAndRegisterLocalModel: fakeTtrPort({ okSlugs: [], calls: ttrCalls }),
    });
    await controller.submit('lote com slugs malformados — a porta TTR nunca deve ver isso');

    expect(ttrCalls).toHaveLength(0); // NUNCA disparou o ping
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children ?? []).toHaveLength(0);
    expect(captured.messages ?? '').toMatch(/não encontrado/); // erro "unknown" padrão (ADR-0146/0152), não TTR
  });

  it('dial global de config com slug CRLF ⇒ idem — nunca chega à porta TTR', async () => {
    const ttrCalls: string[] = [];
    const model = parentDelegates({ agents: [{ label: 'x', goal: 'g' }] }); // SEM model — cai no dial
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      defaultChildModel: 'bad\r\nslug-from-config',
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, []),
      verifyAndRegisterLocalModel: fakeTtrPort({ okSlugs: [], calls: ttrCalls }),
    });
    await controller.submit('dial malformado — porta TTR nunca vê');
    expect(ttrCalls).toHaveLength(0);
  });
});

describe('TESTE DE SEGURANÇA 8 (nível-controller) — a catraca: sessão em Plan nega o spawn, nenhum ping', () => {
  it('modo Plan ⇒ o PRÓPRIO spawn_agent do pai é NEGADO (effect:exec sem allow-list em Plan); verifyAndRegisterLocalModel NUNCA chamada', async () => {
    const ttrCalls: string[] = [];
    const model = parentDelegates({
      agents: [{ label: 'x', goal: 'g', model: 'deepseek/deepseek-v4-flash' }],
    });
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'plan' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, []),
      localModelCatalog: { listNames: () => ['deepseek/deepseek-v4-pro'] },
      verifyAndRegisterLocalModel: fakeTtrPort({ okSlugs: ['deepseek/deepseek-v4-flash'], calls: ttrCalls }),
    });
    await controller.submit('spawn sob Plan — negado antes de qualquer filho nascer');

    expect(ttrCalls).toHaveLength(0); // a catraca do PAI barrou ANTES do spawnNamed
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children ?? []).toHaveLength(0);
  });
});

describe('TESTE DE SEGURANÇA 10 (nível-controller) — porta AUSENTE = comportamento rc.105 idêntico', () => {
  it('Caso 1 (catálogo listável, sem verifyAndRegisterLocalModel) ⇒ fail-closed IDÊNTICO ao rc.105 (formatUnknownLocalModelError)', async () => {
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
      // SEM verifyAndRegisterLocalModel — porta ausente.
    });
    await controller.submit('spawn com typo — porta TTR ausente, fallback Caso 1');

    expect(localLog).toHaveLength(0); // fail-closed ANTES de rodar, igual ao rc.105
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children.some((c) => c.label === 'x') ?? false).toBe(false);
    const msg = captured.messages ?? '';
    expect(msg).toMatch(/deepseek-v4-flsh/);
    expect(msg).toMatch(/deepseek-v4-flash/); // sugestão por distância de edição
    expect(msg).toMatch(/não encontrado/); // exatamente o texto do 0152 D6c, não do 0153
  });

  it('Caso 2 (catálogo NÃO listável, sem verifyAndRegisterLocalModel) ⇒ warn-but-allow IDÊNTICO ao rc.105', async () => {
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
      // SEM localModelCatalog E SEM verifyAndRegisterLocalModel — porta ausente + não-listável.
    });
    await controller.submit('spawn sem catálogo listável e sem porta TTR — fallback Caso 2');

    expect(localLog).toEqual(['LOCAL:deepseek-v4-flash']); // roda mesmo assim (warn-but-allow)
    const note = controller.current.blocks.find(
      (b): b is NoteBlock => b.kind === 'note' && b.title === 'spawn_agent',
    );
    expect(note).toBeDefined();
    expect(note!.lines.join(' ')).toMatch(/não deu para confirmar/); // texto EXATO do 0152 D6c
    // NUNCA a nota "testando..." do 0153 (a porta nem existe).
    const allNotes = controller.current.blocks
      .filter((b): b is NoteBlock => b.kind === 'note' && b.title === 'spawn_agent')
      .flatMap((n) => n.lines)
      .join(' | ');
    expect(allNotes).not.toMatch(/testando modelo/);
  });
});

describe('TESTE DE SEGURANÇA 11 (nível-controller) — DWIM não cresce: nunca chama a porta TTR', () => {
  it('slug desconhecido no campo `agent` (DWIM) ⇒ catálogo-confirmado (fail-closed); verifyAndRegisterLocalModel NUNCA chamada', async () => {
    const ttrCalls: string[] = [];
    const captured: { messages?: string } = {};
    // "agent" recebe um slug que NÃO resolve a nenhum perfil .md — candidato ao DWIM.
    const model = parentDelegates(
      { agents: [{ label: 'x', goal: 'g', agent: 'deepseek/deepseek-v4-flash' }] },
      captured,
    );
    const registry = new AgentRegistry([], []); // registro VAZIO — "deepseek/..." não é um agente .md
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: registry,
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, []),
      // catálogo SEM o slug — DWIM (cond 4) exige CONFIRMAÇÃO de catálogo, fail-closed.
      localModelCatalog: { listNames: () => ['deepseek/deepseek-v4-pro'] },
      verifyAndRegisterLocalModel: fakeTtrPort({
        okSlugs: ['deepseek/deepseek-v4-flash'], // mesmo que a porta DIRIA ok, não deve ser chamada
        calls: ttrCalls,
      }),
    });
    await controller.submit('agent com slug desconhecido — DWIM não deve chamar a porta TTR');

    expect(ttrCalls).toHaveLength(0); // DWIM NUNCA chama a porta nova (D1, "fora do MVP")
    const block = subAgentsBlock(controller.current.blocks);
    expect(block?.children ?? []).toHaveLength(0); // GS-MD7 original: "agente desconhecido"
    expect(captured.messages ?? '').toMatch(/desconhecid/i);
  });

  it('DWIM COM slug JÁ no catálogo (confirmado) ⇒ roteia normalmente, SEM tocar a porta TTR (catálogo já resolve)', async () => {
    const ttrCalls: string[] = [];
    const localLog: string[] = [];
    const model = parentDelegates({ agents: [{ label: 'x', goal: 'g', agent: 'deepseek/deepseek-v4-pro' }] });
    const registry = new AgentRegistry([], []);
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts().ports,
      askResolver: askAutoApprove,
      meta: LOCAL_META,
      subAgents: { enabled: true },
      agentRegistry: registry,
      callerForLocalModel: (slug) => taggedCaller(`LOCAL:${slug}`, localLog),
      localModelCatalog: { listNames: () => ['deepseek/deepseek-v4-pro'] }, // slug JÁ confirmado
      verifyAndRegisterLocalModel: fakeTtrPort({ okSlugs: ['deepseek/deepseek-v4-pro'], calls: ttrCalls }),
    });
    await controller.submit('agent com slug JÁ catalogado — DWIM roteia, sem porta TTR');

    expect(ttrCalls).toHaveLength(0); // catálogo já resolve — nem o DWIM nem o D6c chamam a porta
    expect(localLog).toEqual(['LOCAL:deepseek/deepseek-v4-pro']);
  });
});
