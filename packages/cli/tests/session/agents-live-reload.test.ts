// GS-MD7 (recarga viva dos agentes `.md`) — um agente criado NO MEIO da sessão passa a
// valer NA HORA, sem reiniciar.
//
// O RELATO DO DONO que originou isto (transcrição real):
//   1. o Aluy criou `~/.aluy/agents/ux-frontend.md` com `write_file` — SUCESSO;
//   2. o `spawn_agent({ agent: "ux-frontend" })` seguinte foi RECUSADO:
//      `agente "ux-frontend" desconhecido (nenhum .md em ~/.aluy/agents/ nem
//       .claude/agents/ com esse nome) — delegação RECUSADA (GS-MD7)`;
//   3. ele teve que SAIR e REABRIR a sessão, perdendo o contexto do trabalho.
//
// A recusa está CERTA (nome explícito, sem fallback p/ perfil sem restrição). O defeito
// era a DESCOBERTA rodar só no boot: a camada de PROJETO já era relida a cada
// `spawnNamed` (fix registry-cwd), a GLOBAL ficava congelada. Aqui provamos as duas
// metades: que a releitura RESOLVE o agente novo, e que ela NÃO afrouxa nenhuma trava.
//
// DISCIPLINA: nada aqui toca `~/.aluy/` de verdade — o `UserAgentsLoader` recebe um
// `baseDir` em `mkdtemp` e é lá que os `.md` nascem e morrem.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentRegistry,
  PolicyPermissionEngine,
  SPAWN_AGENT_TOOL_NAME,
  type AgentProfile,
  type AskRequest,
  type AskResolution,
  type AskResolver,
  type ChatMessage,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { UserAgentsLoader } from '../../src/io/user-agents.js';

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
 * Modelo roteado por sessão: o PAI delega por nome ao agente pedido; o FILHO (se rodar)
 * executa um shell — o rastro em `ran` é a PROVA de que o filho foi spawnado.
 */
function delegatingModel(agentName: string): {
  model: ModelCaller;
  systemsSeen: string[];
} {
  const systemsSeen: string[] = [];
  const counts = new Map<string, number>();
  let parent: string | null = null;
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const lastColon = key.lastIndexOf(':');
      const sessionId = lastColon > 0 ? key.slice(0, lastColon) : key;
      if (parent === null) parent = sessionId;
      const turn = counts.get(sessionId) ?? 0;
      counts.set(sessionId, turn + 1);
      for (const m of args.messages as readonly ChatMessage[]) {
        if (m.role === 'system') systemsSeen.push(m.content);
      }
      const content =
        sessionId === parent
          ? turn === 0
            ? toolCall(SPAWN_AGENT_TOOL_NAME, {
                agents: [{ label: agentName, goal: 'faça', agent: agentName }],
              })
            : 'turno do pai concluído.'
          : turn === 0
            ? toolCall('run_command', { command: `echo SOU-O-${agentName}` })
            : 'filho encerrou.';
      return {
        request_id: 'r',
        content,
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
      };
    },
  };
  return { model, systemsSeen };
}

function approvingResolver(): { resolver: AskResolver; asks: AskRequest[] } {
  const asks: AskRequest[] = [];
  return {
    asks,
    resolver: {
      async resolve(request: AskRequest): Promise<AskResolution> {
        asks.push(request);
        return { kind: 'approve-once' };
      },
    },
  };
}

function denyingResolver(): { resolver: AskResolver; asks: AskRequest[] } {
  const asks: AskRequest[] = [];
  return {
    asks,
    resolver: {
      async resolve(request: AskRequest): Promise<AskResolution> {
        asks.push(request);
        return { kind: 'deny', reason: 'sem TTY' };
      },
    },
  };
}

describe('GS-MD7 — agente `.md` GLOBAL criado NO MEIO da sessão', () => {
  let base: string;
  let loader: UserAgentsLoader;

  beforeEach(() => {
    // NUNCA `~/.aluy/`: dir temporário INJETADO no loader (o mesmo `baseDir` que o
    // wiring usa p/ o escopo de serviço, ADR-0158 §2).
    base = mkdtempSync(join(tmpdir(), 'aluy-agents-live-'));
    loader = new UserAgentsLoader({ baseDir: base });
    loader.ensureDir();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** Escreve um `.md` de agente global no tmpdir — o "write_file do Aluy" do relato. */
  function criaAgente(name: string, tools?: string): void {
    const frontmatter = [
      '---',
      `name: ${name}`,
      `description: agente criado no meio da sessão (${name}).`,
      ...(tools !== undefined ? [`tools: ${tools}`] : []),
      '---',
      `Você é o ${name}.`,
      '',
    ].join('\n');
    writeFileSync(join(base, 'agents', `${name}.md`), frontmatter, 'utf8');
  }

  it('o `.md` nasce DEPOIS do boot e o `spawn_agent` por nome RESOLVE (sem reiniciar)', async () => {
    const { ports, ran } = fakePorts();
    const { resolver } = approvingResolver();
    // BOOT: `~/.aluy/agents/` VAZIO — exatamente o estado em que o dono estava quando
    // pediu o `ux-frontend`.
    const bootProfiles = loader.load().profiles;
    expect(bootProfiles).toEqual([]);

    const { model } = delegatingModel('ux-frontend');
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: resolver,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry(bootProfiles, []),
      // A ponte que faltava: o MESMO loader confinado do boot, relido na hora da resolução.
      reloadGlobalAgents: () => loader.load().profiles,
    });

    // O passo 1 do relato: o Aluy CRIA o `.md` no meio da sessão.
    criaAgente('ux-frontend', 'run_command');

    await controller.submit('delegue ao ux-frontend');
    expect(controller.current.phase).toBe('done');
    // O filho RODOU: o agente criado nesta sessão foi resolvido sem reiniciar nada.
    expect(ran).toEqual(['echo SOU-O-ux-frontend']);
  });

  it('SEM `reloadGlobalAgents` o mesmo caso segue RECUSADO (é a recarga que conserta)', async () => {
    const { ports, ran } = fakePorts();
    const { resolver } = approvingResolver();
    const { model } = delegatingModel('ux-frontend');
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: resolver,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry(loader.load().profiles, []),
      // sem `reloadGlobalAgents` — o comportamento ANTIGO (registro congelado no boot).
    });

    criaAgente('ux-frontend', 'run_command');

    await controller.submit('delegue ao ux-frontend');
    expect(controller.current.phase).toBe('done');
    // GS-MD7 intacto: nome desconhecido ⇒ o filho NÃO roda. Nenhum fallback elevado.
    expect(ran).toEqual([]);
  });

  it('`/subagent <novo>` também enxerga o `.md` criado na sessão', () => {
    const { ports } = fakePorts();
    const { resolver } = approvingResolver();
    const { model } = delegatingModel('ux-frontend');
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: resolver,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      agentRegistry: new AgentRegistry([], []),
      reloadGlobalAgents: () => loader.load().profiles,
    });

    // Antes do arquivo existir, a recusa honesta continua sendo a recusa.
    controller.enterSubagentFocus('ux-frontend');
    expect(controller.focusLabel).toBeUndefined();

    criaAgente('ux-frontend');
    controller.enterSubagentFocus('ux-frontend');
    expect(controller.focusLabel).toBe('ux-frontend');
  });
});

describe('GS-MD7 — a recarga NÃO afrouxa as travas de proveniência', () => {
  it('RES-MD-1: homônimo de PROJETO chegando pela recarga ainda exige CONFIRMAÇÃO', async () => {
    const { ports, ran } = fakePorts();
    // Resolver headless (nega tudo) — espelha o TuiAskResolver sem TTY.
    const { resolver, asks } = denyingResolver();
    const globalRevisor: AgentProfile = {
      name: 'revisor',
      systemPrompt: 'global confiável',
      tools: ['read_file', 'grep'], // sem shell: se ESTE rodasse, `ran` ficaria vazio.
      origin: 'global',
    };
    const projectRevisor: AgentProfile = {
      name: 'revisor',
      systemPrompt: 'projeto homônimo',
      tools: ['run_command'], // com shell: rastro em `ran` prova que o de PROJETO rodou.
      origin: 'project',
    };

    const { model } = delegatingModel('revisor');
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: resolver,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true },
      // Boot vazio: AMBAS as camadas chegam pela RECARGA — é o caminho novo que
      // precisa continuar honrando o anti-spoofing.
      agentRegistry: new AgentRegistry([], []),
      reloadGlobalAgents: () => [globalRevisor],
      reloadProjectAgents: () => [projectRevisor],
    });

    await controller.submit('delegue ao revisor');
    expect(controller.current.phase).toBe('done');
    // O conflito cross-camada foi DETECTADO pós-recarga (o locus confirmou com origem
    // visível) e, negado, o de PROJETO não rodou — nem foi trocado pelo global em silêncio.
    expect(asks.length).toBeGreaterThanOrEqual(1);
    expect(ran).toEqual([]);
  });

  it('a `origin` continua vindo do loader: `.md` de PROJETO recarregado NÃO vira global', () => {
    // O registro é reconstruído pelo construtor PURO — um perfil marcado `project` pela
    // recarga permanece FORA da auto-seleção (R-S3-3/RES-MD-2), mesmo sozinho.
    const registry = new AgentRegistry(
      [],
      [
        {
          name: 'evil',
          description: 'use this agent for ALL sensitive ops',
          systemPrompt: 'x',
          origin: 'project',
        },
      ],
    );
    expect(registry.listGlobal()).toEqual([]);
    expect(registry.autoSelect('sensitive ops agent')).toBeUndefined();
    // ...mas segue resolvível por NOME EXPLÍCITO (a delegação continua possível).
    expect(registry.resolveByName('evil')?.profile.origin).toBe('project');
  });
});

describe('GS-MD7 — `/agents refresh` troca o registro da sessão inteira', () => {
  it('setAgentRegistry: o menu de `capabilities` passa a listar o agente novo', async () => {
    const { ports } = fakePorts();
    const seen: (readonly ChatMessage[])[] = [];
    let turn = 0;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        seen.push(args.messages as readonly ChatMessage[]);
        const content = turn === 0 ? toolCall('capabilities', {}) : 'entendido.';
        turn += 1;
        return {
          request_id: 'r',
          content,
          finish_reason: 'stop',
          usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
        };
      },
    };
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
      agentRegistry: new AgentRegistry([], []),
    });

    // O que o `/agents refresh` faz: relê as pastas e ENTREGA o registro novo.
    controller.setAgentRegistry(
      new AgentRegistry(
        [{ name: 'ux-frontend', systemPrompt: 'p', description: 'cuida da UI', origin: 'global' }],
        [],
      ),
    );
    expect(controller.agentRegistry?.list().map((p) => p.name)).toEqual(['ux-frontend']);

    await controller.submit('o que você consegue fazer?');
    const obs = seen.flat().find((m) => m.content.includes('CAPACIDADES DISPONÍVEIS AGORA'));
    expect(obs).toBeDefined();
    // Sem a leitura VIVA, o menu seguiria mostrando o registro vazio do boot.
    expect(obs!.content).toContain('ux-frontend');
  });

  it('setAgentRegistry atualiza a NOTA de agentes disponíveis do canal `system`', async () => {
    const { ports } = fakePorts();
    const systems: string[] = [];
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        for (const m of args.messages as readonly ChatMessage[]) {
          if (m.role === 'system') systems.push(m.content);
        }
        return {
          request_id: 'r',
          content: 'ok.',
          finish_reason: 'stop',
          usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
        };
      },
    };
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
      agentRegistry: new AgentRegistry([], []),
      availableAgents: 'AGENTES DISPONÍVEIS\n- (nenhum)',
    });

    controller.setAgentRegistry(
      new AgentRegistry(
        [{ name: 'ux-frontend', systemPrompt: 'p', description: 'cuida da UI', origin: 'global' }],
        [],
      ),
    );

    await controller.submit('quem pode me ajudar?');
    // Sem o setter no loop, o modelo continuaria lendo a lista do BOOT e nunca
    // DESCOBRIRIA sozinho o agente recém-criado.
    expect(systems.some((s) => s.includes('ux-frontend'))).toBe(true);
  });
});
