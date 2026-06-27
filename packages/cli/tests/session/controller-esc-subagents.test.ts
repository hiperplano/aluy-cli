// EST-0982 · ADR-0063 — SEMÂNTICA DE PARADA refinada (decisão de produto do Tiago):
//
//   • esc (interrupt) para SÓ O TURNO DO PAI — os SUB-AGENTES CONTINUAM trabalhando
//     (não-cascata), cercados pelos MESMOS tetos (SharedBudget/iterações/heartbeat —
//     E-A2, sem runaway órfão); os desfechos viram DADO do PRÓXIMO turno (pendingSeed).
//   • F8 / painel Ctrl+T→P / encerrar a sessão = PARAR TUDO (pai + todos os filhos,
//     inclusive os DESACOPLADOS por um esc anterior).
//
// FRUGAL: tudo com ModelCaller MOCK — nenhuma chamada de modelo real.

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
import type { NoteBlock, SubAgentsBlock } from '../../src/session/model.js';

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

const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Último bloco `subagents` do estado. */
function subAgentsBlock(controller: SessionController): SubAgentsBlock | undefined {
  const blocks = controller.current.blocks;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === 'subagents') return b;
  }
  return undefined;
}

/** Todas as notas (kind: 'note') do estado, concatenadas p/ asserção de texto. */
function notesText(controller: SessionController): string {
  return controller.current.blocks
    .filter((b): b is NoteBlock => b.kind === 'note')
    .map((n) => `${n.title}: ${n.lines.join(' ')}`)
    .join('\n');
}

/**
 * Harness do cenário: o PAI delega 2 filhos (`a` e `b`) no 1º turno. Cada filho
 * PENDURA num gate próprio (OU no abort do PRÓPRIO signal — como o caller real do
 * broker, que cancela in-flight). Liberado, devolve `relatório-<label>`. O modelo
 * registra TODAS as mensagens vistas (p/ provar a semente do próximo turno).
 */
function buildScenario(): {
  model: ModelCaller;
  release: (label: 'a' | 'b') => void;
  captured: { role: string; content: string }[];
} {
  const gates = new Map<string, { p: Promise<void>; release: () => void }>();
  for (const label of ['a', 'b']) {
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    gates.set(label, { p, release });
  }
  const captured: { role: string; content: string }[] = [];
  const counts = new Map<string, number>();
  let parent: string | null = null;
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const sessionId = key.slice(0, key.lastIndexOf(':'));
      if (parent === null) parent = sessionId;
      const turn = counts.get(sessionId) ?? 0;
      counts.set(sessionId, turn + 1);
      for (const m of args.messages) captured.push({ role: m.role, content: m.content });
      const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 };
      if (sessionId === parent) {
        const content =
          turn === 0
            ? toolCall(SPAWN_AGENT_TOOL_NAME, {
                agents: [
                  { label: 'a', goal: 'g-a' },
                  { label: 'b', goal: 'g-b' },
                ],
              })
            : 'entendi.';
        return { request_id: 'r', content, finish_reason: 'stop', usage };
      }
      // FILHO: identifica-se pelo goal nas mensagens; pendura no gate OU no abort.
      const text = args.messages.map((m) => m.content).join('\n');
      const label = text.includes('g-a') ? 'a' : 'b';
      const gate = gates.get(label)!;
      await Promise.race([
        gate.p,
        new Promise<void>((res) => {
          if (args.signal?.aborted) return res();
          args.signal?.addEventListener('abort', () => res(), { once: true });
        }),
      ]);
      // Como o caller real: signal abortado ⇒ a chamada in-flight CAI (lança).
      if (args.signal?.aborted) throw new Error('chamada cancelada (abort)');
      return { request_id: 'r', content: `relatório-${label}.`, finish_reason: 'stop', usage };
    },
  };
  return { model, release: (l) => gates.get(l)!.release(), captured };
}

function buildController(model: ModelCaller): SessionController {
  const { ports } = fakePorts();
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports,
    askResolver: approveAll,
    meta,
    subAgents: { enabled: true, maxConcurrency: 2, timeoutMs: 60_000 },
  });
}

describe('EST-0982 — esc para SÓ o pai: os sub-agentes CONTINUAM e o desfecho vira DADO', () => {
  it('esc com 2 filhos vivos ⇒ pai cessa (idle), filhos NÃO abortados, terminam, e o resultado semeia o PRÓXIMO turno', async () => {
    const { model, release, captured } = buildScenario();
    const controller = buildController(model);

    const done = controller.submit('delegue a e b');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );

    // esc — para SÓ o turno do pai.
    controller.interrupt();

    // O turno do PAI cessou LIMPO (sem esperar os filhos): volta ao composer.
    await done;
    expect(controller.current.phase).toBe('idle');
    expect(controller.drillInFlow('root')!.phase).toBe('cancelled');

    // Os FILHOS NÃO foram abortados: seguem vivos na árvore E `running` no bloco.
    const liveKids = controller
      .flowOverview()
      .filter((n) => n.kind === 'subagent' && n.phase !== 'cancelled' && n.phase !== 'failed');
    expect(liveKids).toHaveLength(2);
    const block = subAgentsBlock(controller)!;
    expect(block.children.every((c) => c.status === 'running')).toBe(true);

    // A NOTA honesta apareceu: o esc parou só o pai; F8 para tudo.
    const notes = notesText(controller);
    expect(notes).toContain('turno interrompido');
    expect(notes).toContain('F8');

    // Auditoria: o esc é um `cancel` do nó RAIZ (não um cancel-all).
    expect(controller.controlLog().some((e) => e.verb === 'cancel' && e.targetId === 'root')).toBe(
      true,
    );
    expect(controller.controlLog().some((e) => e.verb === 'cancel-all')).toBe(false);

    // Os filhos TERMINAM o trabalho em segundo plano…
    release('a');
    release('b');
    await waitFor(() => {
      const b = subAgentsBlock(controller);
      return b !== undefined && b.children.every((c) => c.status === 'done');
    });
    // …e o desfecho vira DADO PENDENTE (nota + pendingSeed).
    await waitFor(() => notesText(controller).includes('sub-agentes concluíram'));

    // PRÓXIMO turno: o agente VÊ os resultados como OBSERVAÇÃO (dado), nunca system.
    captured.length = 0;
    await controller.submit('e aí?');
    const userMsgs = captured.filter((m) => m.role === 'user');
    const seeded = userMsgs.find(
      (m) => m.content.includes('relatório-a.') && m.content.includes('relatório-b.'),
    );
    expect(seeded).toBeDefined();
    expect(seeded!.content).toContain('sub-agente'); // rótulo de origem (CLI-SEC-9)
    const systemMsgs = captured.filter((m) => m.role === 'system');
    expect(systemMsgs.some((m) => m.content.includes('relatório-a.'))).toBe(false);
  });

  it('TETOS PRESERVADOS (E-A2): filhos pós-esc seguem cercados pelo budget agregado — param SOZINHOS no teto', async () => {
    // Filhos em "loop produtivo" (read_file sem parar): após o esc, NINGUÉM os aborta
    // — quem os para é o SharedBudget agregado (sem runaway órfão).
    const counts = new Map<string, number>();
    let parent: string | null = null;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const key = args.idempotencyKey;
        const sessionId = key.slice(0, key.lastIndexOf(':'));
        if (parent === null) parent = sessionId;
        const turn = counts.get(sessionId) ?? 0;
        counts.set(sessionId, turn + 1);
        const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 };
        if (sessionId === parent && turn === 0) {
          return {
            request_id: 'r',
            content: toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [
                { label: 'a', goal: 'loop-a' },
                { label: 'b', goal: 'loop-b' },
              ],
            }),
            finish_reason: 'stop',
            usage,
          };
        }
        // FILHO em loop "produtivo" — um pequeno delay por chamada p/ o esc do teste
        // aterrissar com os filhos AINDA trabalhando (senão o mock instantâneo esgota
        // o teto antes do interrupt e o turno do pai cai no gate de budget).
        await new Promise((r) => setTimeout(r, 10));
        return {
          request_id: 'r',
          content: toolCall('read_file', { path: 'x' }), // nunca finaliza sozinho
          finish_reason: 'stop',
          usage,
        };
      },
    };
    const { ports } = fakePorts();
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      // Teto AGREGADO apertado: pai + filhos compartilham (E-A2).
      limits: { maxIterations: 12, maxToolCalls: 100, maxTokens: 1_000_000 },
      subAgents: { enabled: true, maxConcurrency: 2, timeoutMs: 60_000 },
    });

    const done = controller.submit('delegue e rode');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );
    controller.interrupt(); // esc — os filhos seguem
    await done;
    expect(controller.current.phase).toBe('idle');

    // SEM F8, SEM abort: os filhos PARAM no teto agregado (stop=limit, não runaway).
    await waitFor(() => {
      const b = subAgentsBlock(controller);
      return b !== undefined && b.children.every((c) => c.status !== 'running');
    });
    const block = subAgentsBlock(controller)!;
    for (const c of block.children) expect(c.stop).toBe('limit');
  });
});

describe('EST-0982 — F8 / PARAR-TUDO / exit derrubam TUDO (pai + filhos + desacoplados)', () => {
  it('PARAR-TUDO (o caminho do F8/painel) com filhos vivos aborta pai E filhos', async () => {
    const { model } = buildScenario();
    const controller = buildController(model);
    const done = controller.submit('delegue a e b');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );

    controller.cancelAllFlows(); // F8 (sem abrir o painel) — TUDO cai
    await done;

    expect(controller.drillInFlow('root')!.phase).toBe('cancelled');
    // Os filhos foram ABORTADOS de verdade (o gate nunca foi liberado): o sinal do nó
    // matou o loop deles e o bloco os marca `cancelled` (cessar≠falha).
    await waitFor(() => {
      const b = subAgentsBlock(controller);
      return b !== undefined && b.children.every((c) => c.status === 'cancelled');
    });
    // Auditado actor_type=cli (CLI-SEC-10).
    expect(
      controller.controlLog().some((e) => e.verb === 'cancel-all' && e.actorType === 'cli'),
    ).toBe(true);
    // PARAR-TUDO explícito NÃO vira semente do próximo turno.
    await new Promise((r) => setTimeout(r, 20));
    expect(notesText(controller)).not.toContain('sub-agentes concluíram');
  });

  it('F8 PÓS-esc alcança os filhos DESACOPLADOS (sem órfão imune ao freio)', async () => {
    const { model } = buildScenario();
    const controller = buildController(model);
    const done = controller.submit('delegue a e b');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );

    controller.interrupt(); // esc — desacopla (filhos seguem)
    await done;
    const block0 = subAgentsBlock(controller)!;
    expect(block0.children.every((c) => c.status === 'running')).toBe(true);

    controller.cancelAllFlows(); // F8 depois do esc — os desacoplados TAMBÉM caem
    await waitFor(() => {
      const b = subAgentsBlock(controller);
      return b !== undefined && b.children.every((c) => c.status === 'cancelled');
    });
    // E o desfecho pós-F8 NÃO semeia o próximo turno (o usuário mandou parar tudo).
    await new Promise((r) => setTimeout(r, 20));
    expect(notesText(controller)).not.toContain('sub-agentes concluíram');
  });

  it('encerrar a sessão (dispose, o caminho do Ctrl+C×2 / unmount) MATA tudo — sem órfão', async () => {
    const { model } = buildScenario();
    const controller = buildController(model);
    const done = controller.submit('delegue a e b');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );

    controller.dispose(); // o cleanup do unmount da App chama isto
    await done;
    await waitFor(() => {
      const b = subAgentsBlock(controller);
      return b !== undefined && b.children.every((c) => c.status === 'cancelled');
    });
  });

  it('dispose PÓS-esc também mata os desacoplados (exit nunca deixa filho rodando)', async () => {
    const { model } = buildScenario();
    const controller = buildController(model);
    const done = controller.submit('delegue a e b');
    await waitFor(
      () => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );
    controller.interrupt(); // esc — desacopla
    await done;
    controller.dispose(); // sair do aluy
    await waitFor(() => {
      const b = subAgentsBlock(controller);
      return b !== undefined && b.children.every((c) => c.status === 'cancelled');
    });
  });
});
