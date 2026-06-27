// EST-0969 · ADR-0057 (E-A1/E-A2/E-A3) · CLI-SEC-11 — integração no @aluy/cli:
// o SessionController liga o loop do PAI ao SubAgentSpawner, compartilhando UM
// budget (E-A2), com `spawn_agent` SÓ no toolset do pai (E-A1), atrás da catraca.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  SPAWN_AGENT_TOOL_NAME,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';
import type { SessionBlock, SubAgentsBlock } from '../../src/session/model.js';
import { splitBlocks } from '../../src/session/render-split.js';
import { linearize } from '../../src/session/linear.js';

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

/** Roteia por sessionId (extraído da idempotency-key `sess:iter`). */
function routingModel(script: (sessionId: string, turn: number) => string): {
  model: ModelCaller;
  sessions: Set<string>;
} {
  const counts = new Map<string, number>();
  const sessions = new Set<string>();
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const lastColon = key.lastIndexOf(':');
      const sessionId = lastColon > 0 ? key.slice(0, lastColon) : key;
      sessions.add(sessionId);
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
  return { model, sessions };
}

describe('EST-0969 · SessionController liga sub-agentes paralelos', () => {
  it('com subAgents.enabled, o PAI delega via spawn_agent e os filhos rodam em paralelo', async () => {
    const { ports } = fakePorts();
    // O PAI (1ª sessão) chama spawn_agent com 3 filhos; depois conclui. Cada FILHO
    // (sessões distintas) conclui de imediato. Distinguimos pai×filho pela ORDEM de
    // chegada: o 1º sessionId visto é o do pai.
    let parentSession: string | null = null;
    const { model, sessions } = routingModel((sessionId, turn) => {
      if (parentSession === null) parentSession = sessionId;
      if (sessionId === parentSession) {
        return turn === 0
          ? toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [
                { label: 'rust', goal: 'pesquise rust' },
                { label: 'go', goal: 'pesquise go' },
                { label: 'zig', goal: 'pesquise zig' },
              ],
            })
          : 'comparei as três linguagens.';
      }
      // filho: conclui imediatamente com um resultado próprio
      return `relatório de ${sessionId.slice(0, 6)}.`;
    });

    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }), // auto-aprova spawn
      ports,
      askResolver: {
        async resolve() {
          return { kind: 'approve-once' };
        },
      },
      meta: { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true, maxConcurrency: 3 },
    });

    await controller.submit('pesquise 3 linguagens em paralelo e compare');

    // O pai + 3 filhos ⇒ 4 sessões distintas (1 pai, 3 filhos).
    expect(sessions.size).toBe(4);
    // terminou com a resposta consolidada do pai (não erro/limite).
    expect(controller.current.phase).toBe('done');
  });

  it('sem subAgents.enabled, spawn_agent NÃO está no toolset do pai (mono-agente)', async () => {
    const { ports } = fakePorts();
    const { model } = routingModel((_s, turn) =>
      turn === 0
        ? toolCall(SPAWN_AGENT_TOOL_NAME, { agents: [{ label: 'x', goal: 'g' }] })
        : 'sigo sozinho.',
    );
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
      // subAgents AUSENTE ⇒ mono-agente
    });

    await controller.submit('delegue');
    // o pai pediu spawn_agent mas a tool é DESCONHECIDA (não registrada) ⇒ vira
    // observação "tool desconhecida", e o pai segue sozinho. Sem erro fatal.
    expect(controller.current.phase).toBe('done');
  });

  it('E-A2: o teto AGREGADO da sessão é compartilhado pai+filhos (não estoura)', async () => {
    const { ports } = fakePorts();
    // Teto baixo. O pai delega 3 filhos que iteram sem parar (sempre read_file).
    // A soma das iterações (pai + filhos) tem de parar no teto — nunca além.
    let parentSession: string | null = null;
    const { model } = routingModel((sessionId, turn) => {
      if (parentSession === null) parentSession = sessionId;
      if (sessionId === parentSession && turn === 0) {
        return toolCall(SPAWN_AGENT_TOOL_NAME, {
          agents: [
            { label: 'a', goal: 'leia em loop' },
            { label: 'b', goal: 'leia em loop' },
            { label: 'c', goal: 'leia em loop' },
          ],
        });
      }
      // todos (pai após spawn, e filhos) sempre pedem uma leitura → loop até o teto
      return toolCall('read_file', { path: 'a' });
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
      subAgents: { enabled: true, maxConcurrency: 3 },
      limits: { maxIterations: 10, maxToolCalls: 100, maxTokens: 1_000_000 },
    });

    await controller.submit('leia tudo em paralelo, sem parar');
    // a sessão parou por budget agregado (não rodou indefinidamente).
    // O teto de iterações é 10 no AGREGADO (pai + filhos), nunca além.
    expect(['budget', 'done']).toContain(controller.current.phase);
  });
});

// ── EST-0969 (display) — o BUG de UX: streams dos filhos paralelos NÃO podem
// interleavar na região viva do pai. O fix é apresentação: um indicador de
// sub-agentes (status por filho) + caller dedicado dos filhos (sem o sink ao vivo).
describe('EST-0969 (display) · indicador de sub-agentes (não interleave de streams)', () => {
  /**
   * Constrói um controller com PAI delegando 3 filhos. O `subAgentModel` é um caller
   * SEPARADO (espelha o wiring de produção): a resposta dos filhos sai por ele, NÃO
   * pelo `model` do pai. Cada filho devolve um texto único e RECONHECÍVEL.
   */
  function buildFanout(childGoalMarkers: Record<string, string>) {
    const { ports } = fakePorts();
    let parentSession: string | null = null;
    // O caller do PAI: 1ª fala + spawn_agent, depois consolida.
    const parent = routingModel((sessionId, turn) => {
      if (parentSession === null) parentSession = sessionId;
      return turn === 0
        ? 'vou pesquisar em paralelo.\n' +
            toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: Object.keys(childGoalMarkers).map((label) => ({
                label,
                goal: `pesquise ${label}`,
              })),
            })
        : 'consolidei os relatórios dos sub-agentes. concluído.';
    });
    // O caller DEDICADO dos FILHOS: devolve o marcador único de cada filho. Roteia
    // pelo goal (a 1ª mensagem do filho contém o goal `pesquise <label>`).
    const childModel: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const text = args.messages.map((m) => m.content).join('\n');
        const hit = Object.entries(childGoalMarkers).find(([label]) =>
          text.includes(`pesquise ${label}`),
        );
        const content = hit ? hit[1] : 'relatório genérico de filho.';
        return {
          request_id: 'rc',
          content,
          finish_reason: 'stop',
          usage: { request_id: 'rc', tier: 'aluy-flux', tokens_in: 600, tokens_out: 600 },
        };
      },
    };
    const controller = new SessionController({
      model: parent.model,
      subAgentModel: childModel,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: {
        async resolve() {
          return { kind: 'approve-once' };
        },
      },
      meta: { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true, maxConcurrency: 3 },
      flush: { intervalMs: 0 }, // determinístico p/ o teste (sem throttle)
    });
    return controller;
  }

  function subAgentsBlock(blocks: readonly SessionBlock[]): SubAgentsBlock | undefined {
    return blocks.find((b): b is SubAgentsBlock => b.kind === 'subagents');
  }

  it('produz UM bloco `subagents` com status por filho — não despeja os tokens crus', async () => {
    const controller = buildFanout({
      rust: 'RELATORIO_RUST_xyz',
      go: 'RELATORIO_GO_xyz',
      zig: 'RELATORIO_ZIG_xyz',
    });
    await controller.submit('pesquise 3 linguagens em paralelo');

    const blocks = controller.current.blocks;
    const sub = subAgentsBlock(blocks);
    expect(sub).toBeDefined();
    // 3 filhos, todos rotulados por origem e CONCLUÍDOS (não `running` no fim).
    expect(sub!.children.map((c) => c.label).sort()).toEqual(['go', 'rust', 'zig']);
    expect(sub!.children.every((c) => c.status === 'done')).toBe(true);
    // resumo curto por filho (tokens · tools), NUNCA o corpo do filho.
    expect(sub!.children.every((c) => /tokens/.test(c.summary ?? ''))).toBe(true);
  });

  it('os tokens CRUS de cada filho NÃO vazam p/ os blocos `aluy` do pai (anti-interleave)', async () => {
    const controller = buildFanout({
      rust: 'RELATORIO_RUST_xyz',
      go: 'RELATORIO_GO_xyz',
      zig: 'RELATORIO_ZIG_xyz',
    });
    await controller.submit('pesquise 3 linguagens em paralelo');

    // NENHUM bloco VISÍVEL do pai (aluy, ou qualquer outro) pode conter os marcadores
    // crus dos filhos — eles foram coletados internamente pelo caller dedicado e
    // voltaram só como DADO (observação) ao pai, nunca despejados token-a-token na
    // região viva. O indicador de sub-agentes mostra STATUS, não o corpo.
    const visible = controller.current.blocks
      .map((b) => {
        if (b.kind === 'aluy' || b.kind === 'you') return b.text;
        if (b.kind === 'subagents')
          return b.children.map((c) => `${c.label} ${c.status} ${c.summary ?? ''}`).join(' ');
        return '';
      })
      .join('\n');
    expect(visible).not.toContain('RELATORIO_RUST_xyz');
    expect(visible).not.toContain('RELATORIO_GO_xyz');
    expect(visible).not.toContain('RELATORIO_ZIG_xyz');
    // O indicador de sub-agentes existe e mostra os 3 filhos concluídos (legível).
    const sub = subAgentsBlock(controller.current.blocks);
    expect(sub?.children.length).toBe(3);
    expect(sub?.children.every((c) => c.status === 'done')).toBe(true);
  });

  it('o bloco de sub-agentes é VIVO enquanto roda e migra p/ o `<Static>` ao concluir', async () => {
    // Captura snapshots durante o fan-out: enquanto um filho roda, o bloco está na
    // região VIVA (live); no fim, todos `done` ⇒ migra p/ `done` (Static).
    const controller = buildFanout({ rust: 'R', go: 'G' });
    let sawLiveSubagents = false;
    const unsub = controller.subscribe((state) => {
      const { live } = splitBlocks(state.blocks);
      if (
        live.some((b) => b.kind === 'subagents' && b.children.some((c) => c.status === 'running'))
      )
        sawLiveSubagents = true;
    });
    await controller.submit('pesquise em paralelo');
    unsub();

    // durante a execução, o indicador esteve VIVO (não foi p/ o Static com filho rodando).
    expect(sawLiveSubagents).toBe(true);
    // no fim, todos concluíram ⇒ o indicador é imutável (não vive mais).
    const { live, done } = splitBlocks(controller.current.blocks);
    expect(live.some((b) => b.kind === 'subagents')).toBe(false);
    expect(done.some((b) => b.kind === 'subagents')).toBe(true);
  });

  it('EST-0982: a LINHA de cada filho mostra o uso PRÓPRIO (1.2k), o RODAPÉ do turno mostra o AGREGADO (pai+filhos)', async () => {
    // Cada filho consome 1200 tokens (childModel: 600 in + 600 out, 1 turno). Antes do
    // fix, cada filho exibiria o AGREGADO (todos iguais, contaminado). Agora: a linha de
    // cada filho = 1.2k PRÓPRIO; o rodapé do turno = pai + 3×1200 (≥ 3600), o total da sessão.
    const controller = buildFanout({
      rust: 'RELATORIO_RUST_xyz',
      go: 'RELATORIO_GO_xyz',
      zig: 'RELATORIO_ZIG_xyz',
    });
    await controller.submit('pesquise 3 linguagens em paralelo');

    const sub = subAgentsBlock(controller.current.blocks);
    expect(sub).toBeDefined();
    // CADA filho mostra o uso PRÓPRIO (1.2k), NÃO o agregado — e todos batem 1.2k
    // porque CADA UM consumiu o mesmo 1200 (não porque leram o total compartilhado).
    expect(sub!.children.every((c) => /1\.2k tokens/.test(c.summary ?? ''))).toBe(true);

    // O RODAPÉ do turno (raiz) reflete o AGREGADO: inclui os 3×1200 dos filhos (≥3600),
    // ESTRITAMENTE maior que o uso PRÓPRIO de qualquer filho isolado (1200). E-A2 vivo.
    const footer = controller.current.turnAccounting;
    expect(footer).toBeDefined();
    expect(footer!.tokens).toBeGreaterThanOrEqual(3600);
    expect(footer!.tokens).toBeGreaterThan(1200);
  });

  it('EST-0973 (hunt-budget): o RODAPÉ do turno NÃO conta os filhos DUAS vezes (totalAccounting sem dobra)', async () => {
    // REGRESSÃO: o nó RAIZ carregava o AGREGADO (pai+filhos) via `setUsage(budget.usage)`,
    // enquanto cada nó FILHO carregava o seu uso PRÓPRIO. Somar raiz(agregada) + filhos no
    // `totalAccounting()` contava os filhos DUAS vezes. O fix faz a raiz carregar só o uso
    // PRÓPRIO do pai (invariante NÃO-SOBREPONENTE da FlowTree); o agregado pai+filhos sai de
    // `totalAccounting()` sem dobra — e o rodapé (`turnAccounting`) passa a ler DAÍ.
    //
    // Contas FECHADAS deste fixture: o caller do PAI emite 1+1=2 tokens/chamada e faz 2
    // chamadas (spawn + consolida) ⇒ 4 PRÓPRIOS. Cada filho: 600+600=1200, 3 filhos ⇒ 3600.
    // Agregado HONESTO = 4 + 3600 = 3604. Com a DOBRA seria 3604 + 3600 = 7204.
    const controller = buildFanout({
      rust: 'RELATORIO_RUST_xyz',
      go: 'RELATORIO_GO_xyz',
      zig: 'RELATORIO_ZIG_xyz',
    });
    await controller.submit('pesquise 3 linguagens em paralelo');

    const overview = controller.flowOverview();
    const root = overview.find((n) => n.kind === 'root');
    const children = overview.filter((n) => n.kind === 'subagent');
    expect(root).toBeDefined();
    expect(children).toHaveLength(3);

    // INVARIANTE: a RAIZ carrega só o uso PRÓPRIO do PAI (4), NÃO o agregado (3604).
    // Antes do fix a raiz mostraria 3604 (= agregado) ⇒ a soma com os filhos DOBRAVA.
    expect(root!.accounting.tokens).toBe(4);
    // Cada filho carrega só o SEU (1200) — não-sobreponente com a raiz.
    expect(children.every((c) => c.accounting.tokens === 1200)).toBe(true);

    // A soma NÃO-SOBREPONENTE (raiz-própria + filhos) é o agregado HONESTO, sem dobra.
    const summed = overview.reduce((acc, n) => acc + n.accounting.tokens, 0);
    expect(summed).toBe(3604);

    // O RODAPÉ do turno reflete EXATAMENTE esse agregado (lê `totalAccounting()`): não os
    // 7204 da dobra, não os 4 só do pai. É a prova observável do fix no caminho que executa.
    const footer = controller.current.turnAccounting;
    expect(footer).toBeDefined();
    expect(footer!.tokens).toBe(3604);
  });

  it('linear (não-TTY): serializa STATUS por filho, NUNCA os tokens crus misturados', () => {
    const block: SubAgentsBlock = {
      kind: 'subagents',
      children: [
        { label: 'rust', status: 'done', summary: '1.2k tokens · 3 tools', stop: 'final' },
        { label: 'go', status: 'fail', summary: '4 tokens', stop: 'timeout' },
        { label: 'zig', status: 'running' },
      ],
    };
    const out = linearize(block);
    expect(out).toContain('[sub-agentes] 3:');
    expect(out).toContain('[rust] pronto · 1.2k tokens · 3 tools');
    expect(out).toContain('[go] timeout · 4 tokens');
    expect(out).toContain('[zig] rodando');
    // não há corpo/stream cru de filho — só linhas de status rotuladas.
    expect(out).not.toMatch(/RELATORIO|token-a-token/);
  });
});

// ── EST-0969 (display) — o ASK de um filho continua VISÍVEL e ROTULADO por origem.
// O indicador é só apresentação; a aprovação de efeitos dos filhos NÃO pode sumir.
describe('EST-0969 (display) · ask de um filho aparece rotulado [sub-agente: <label>]', () => {
  it('um efeito sempre-ask de um filho dispara um ask rotulado pela origem do filho', async () => {
    const { ports } = fakePorts();
    let parentSession: string | null = null;
    const parent = routingModel((sessionId, turn) => {
      if (parentSession === null) parentSession = sessionId;
      return turn === 0
        ? toolCall(SPAWN_AGENT_TOOL_NAME, { agents: [{ label: 'rust', goal: 'pesquise rust' }] })
        : 'pronto.';
    });
    // O filho tenta um efeito que cai em sempre-ask (run_command de rede): o ask DEVE
    // chegar ao resolver, rotulado por origem. Depois conclui.
    const childModel: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const text = args.messages.map((m) => m.content).join('\n');
        // 1ª iteração do filho: pede um efeito; depois conclui.
        const content = text.includes('relatório')
          ? 'relatório do filho.'
          : 'rodando…\n' +
            toolCall('run_command', { command: 'curl https://exemplo.com/relatório' });
        return {
          request_id: 'rc',
          content,
          finish_reason: 'stop',
          usage: { request_id: 'rc', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
        };
      },
    };

    const askReasons: string[] = [];
    const controller = new SessionController({
      model: parent.model,
      subAgentModel: childModel,
      // modo NORMAL: a catraca pergunta nos efeitos (não bypassa). O PAI pergunta no
      // spawn_agent; o FILHO pergunta no run_command — cada um pelo resolver.
      permission: new PolicyPermissionEngine({ mode: 'normal' }),
      ports,
      askResolver: {
        async resolve(request) {
          askReasons.push(request.reason);
          // Aprova o spawn do PAI (p/ os filhos nascerem) e NEGA o efeito do FILHO
          // (não queremos rede no teste). O que importa é que o ask do filho CHEGOU
          // ao resolver, rotulado por origem — visível e atendível.
          if (request.call.name === SPAWN_AGENT_TOOL_NAME) return { kind: 'approve-once' };
          return { kind: 'deny', reason: 'negado no teste' };
        },
      },
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      subAgents: { enabled: true, maxConcurrency: 1 },
    });

    await controller.submit('delegue a pesquisa');

    // O ask do FILHO chegou ao resolver, ROTULADO pela origem (spawner injeta o
    // prefixo `[sub-agente: rust]`). Isso NÃO some com o novo indicador de display.
    expect(askReasons.some((r) => r.includes('[sub-agente: rust]'))).toBe(true);
    // o ask do PAI (spawn_agent) NÃO é rotulado de filho (é o efeito do próprio pai).
    expect(askReasons.some((r) => !r.includes('[sub-agente:'))).toBe(true);
  });
});
