// FILHOS DESACOPLADOS: contagem certa depois de um turno novo, e "parado" só quando alguém parou.
//
// Relatos do dono (16/09):
//  · o rodapé dizia "2 sub-agente(s) trabalhando" com um já pronto, e o `agents_status` dizia
//    "pensando (parece travado)" para filhos concluídos. O observador procurava o nó do filho na
//    árvore do turno CORRENTE; depois de um turno novo o fim do filho não era registrado;
//  · três filhos "✘ parado · 8.8s" logo após o ESC. Nenhum ESC cancela filho: a assinatura só
//    fecha com um PARAR-TUDO. Agora a parada diz quem a pediu (F8 × painel), e o `p` na linha
//    da RAIZ do painel age como o ESC em vez de derrubar os filhos.
import { describe, expect, it } from 'vitest';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import {
  PolicyPermissionEngine,
  SPAWN_AGENT_TOOL_NAME,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import type { SessionBlock, SubAgentsBlock } from '../../src/session/model.js';

type NoteBlock = Extract<SessionBlock, { kind: 'note' }>;
const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}
function fakePorts(): ToolPorts {
  return {
    fs: {
      async readFile() {
        return 'x';
      },
      async writeFile() {},
      async exists() {
        return true;
      },
    },
    shell: {
      async exec() {
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return { matches: [], truncated: {} };
      },
    },
  } as ToolPorts;
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
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
function subAgentsBlock(c: SessionController): SubAgentsBlock | undefined {
  const bs = c.current.blocks;
  for (let i = bs.length - 1; i >= 0; i--) {
    const b = bs[i];
    if (b && b.kind === 'subagents') return b;
  }
  return undefined;
}
function notes(c: SessionController): string {
  return c.current.blocks
    .filter((b): b is NoteBlock => b.kind === 'note')
    .map((n) => `${n.title}: ${n.lines.join(' ')}`)
    .join('\n');
}
/** pai: turno 0 spawna labels; depois responde "ok". filhos penduram em gate ou abort. */
function scenario(labels: string[]) {
  const gates = new Map<string, { p: Promise<void>; release: () => void }>();
  for (const l of labels) {
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    gates.set(l, { p, release });
  }
  const counts = new Map<string, number>();
  let parent: string | null = null;
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const sid = key.slice(0, key.lastIndexOf(':'));
      if (parent === null) parent = sid;
      const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 };
      const text = args.messages.map((m) => m.content).join('\n');
      const child = labels.find((l) => text.includes(`goal-${l}`));
      const isParent = sid === parent || !child || text.includes('PARENT');
      if (isParent && !(child && !text.includes('PARENT'))) {
        const turn = counts.get('parent') ?? 0;
        counts.set('parent', turn + 1);
        const content =
          turn === 0
            ? 'PARENT ' +
              toolCall(SPAWN_AGENT_TOOL_NAME, {
                agents: labels.map((l) => ({ label: l, goal: `goal-${l}` })),
              })
            : 'PARENT ok.';
        return { request_id: 'r', content, finish_reason: 'stop', usage };
      }
      const gate = gates.get(child!)!;
      await Promise.race([
        gate.p,
        new Promise<void>((res) => {
          if (args.signal?.aborted) return res();
          args.signal?.addEventListener('abort', () => res(), { once: true });
        }),
      ]);
      if (args.signal?.aborted) throw new Error('chamada cancelada (abort)');
      return { request_id: 'r', content: `relatorio-${child}.`, finish_reason: 'stop', usage };
    },
  };
  return { model, release: (l: string) => gates.get(l)!.release() };
}
function build(model: ModelCaller, extra: Record<string, unknown> = {}) {
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: approveAll,
    meta,
    subAgents: { enabled: true, maxConcurrency: 4, timeoutMs: 60_000 },
    ...extra,
  } as never);
}

const GRACA = 900;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('contagem de desacoplados com turno novo no meio', () => {
  it('um filho desacoplado que termina DEPOIS de um turno novo sai da contagem', async () => {
    const { model, release } = scenario(['a', 'b']);
    const c = build(model);
    const done = c.submit('delegue');
    await waitFor(() => c.flowOverview().filter((n) => n.kind === 'subagent').length === 2);
    c.interrupt();
    await done;
    expect(c.current.detachedSubagents).toBe(2);
    await c.submit('e ai?');
    release('a');
    await waitFor(
      () => subAgentsBlock(c)!.children.find((x) => x.label === 'a')!.status === 'done',
    );
    expect(c.current.detachedSubagents).toBe(1);
    const a = subAgentsBlock(c)!.children.find((x) => x.label === 'a')!;
    expect(a.nodeId).toBe('root/a');
    expect(c.current.liveSubagents?.find((x) => x.label === 'a')?.phase).toBe('done');
    release('b');
    await waitFor(() => subAgentsBlock(c)!.children.every((x) => x.status === 'done'));
    await sleep(GRACA + 100);
    expect(c.current.detachedSubagents).toBeUndefined();
  });

  it('sem turno novo a contagem já cai na hora (controle)', async () => {
    const { model, release } = scenario(['a', 'b']);
    const c = build(model);
    const done = c.submit('delegue');
    await waitFor(() => c.flowOverview().filter((n) => n.kind === 'subagent').length === 2);
    c.interrupt();
    await done;
    release('a');
    await waitFor(
      () => subAgentsBlock(c)!.children.find((x) => x.label === 'a')!.status === 'done',
    );
    expect(c.current.detachedSubagents).toBe(1);
    release('b');
    await waitFor(() => subAgentsBlock(c)!.children.every((x) => x.status === 'done'));
  });

  it('F8 depois de um turno novo marca os desacoplados como parados', async () => {
    const { model } = scenario(['a', 'b']);
    const c = build(model);
    const done = c.submit('delegue');
    await waitFor(() => c.flowOverview().filter((n) => n.kind === 'subagent').length === 2);
    c.interrupt();
    await done;
    await c.submit('e ai?');
    c.cancelAllFlows();
    await waitFor(() => subAgentsBlock(c)!.children.every((x) => x.status !== 'running'));
    expect(subAgentsBlock(c)!.children.map((x) => x.status)).toEqual(['cancelled', 'cancelled']);
  });
});

describe('B — caminhos do ESC não param filhos', () => {
  it('ESC no ask de um filho (deny) + 2º ESC (interrupt) não cancela nenhum filho', async () => {
    const labels = ['a', 'b', 'c'];
    const counts = new Map<string, number>();
    let parent: string | null = null;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const sid = args.idempotencyKey.slice(0, args.idempotencyKey.lastIndexOf(':'));
        if (parent === null) parent = sid;
        const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 };
        const turn = counts.get(sid) ?? 0;
        counts.set(sid, turn + 1);
        if (sid === parent) {
          return {
            request_id: 'r',
            usage,
            finish_reason: 'stop',
            content:
              turn === 0
                ? toolCall(SPAWN_AGENT_TOOL_NAME, {
                    agents: labels.map((l) => ({ label: l, goal: `goal-${l}` })),
                  })
                : 'ok.',
          };
        }
        await new Promise((r) => setTimeout(r, 30));
        if (args.signal?.aborted) throw new Error('abort');
        // 1ª chamada do filho pede um comando (ask); depois finaliza.
        return {
          request_id: 'r',
          usage,
          finish_reason: 'stop',
          content: turn === 0 ? toolCall('run_command', { command: 'rm -rf /tmp/x' }) : 'feito.',
        };
      },
    };
    const ask = new TuiAskResolver({ timeoutMs: 60_000 } as never);
    const c = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'normal' } as never),
      ports: fakePorts(),
      askResolver: ask,
      meta,
      subAgents: { enabled: true, maxConcurrency: 4, timeoutMs: 60_000 },
    } as never);
    const done = c.submit('delegue');
    await waitFor(() => c.current.phase === 'asking', 5000);
    if (c.current.pendingAsk?.request.call.name === SPAWN_AGENT_TOOL_NAME) {
      c.resolveAsk({ kind: 'approve-once' });
      await waitFor(
        () =>
          c.current.phase === 'asking' && c.current.pendingAsk?.request.call.name === 'run_command',
        5000,
      );
    }
    c.resolveAsk({ kind: 'deny', reason: 'cancelado (esc)' }); // 1º ESC no modal
    c.interrupt(); // 2º ESC (hard-stop do modal)
    await done;
    // os outros asks seguem na fila; nega todos como o dono faria com ESC
    await waitFor(() => {
      if (c.current.pendingAsk) c.resolveAsk({ kind: 'deny', reason: 'esc' });
      return (subAgentsBlock(c)?.children ?? []).every((x) => x.status !== 'running');
    }, 5000);
    expect(subAgentsBlock(c)!.children.some((x) => x.status === 'cancelled')).toBe(false);
  });
});

describe('parada de filhos: só um PARAR-TUDO explícito', () => {
  it('assinatura da sessão real: ESC + parar-tudo antes do fim', async () => {
    const { model } = scenario(['a', 'b', 'c']);
    const c = build(model);
    const done = c.submit('delegue');
    await waitFor(() => c.flowOverview().filter((n) => n.kind === 'subagent').length === 3);
    c.interrupt();
    await done;
    c.cancelAllFlows(); // F8 / Ctrl+T→P / dispose
    await waitFor(() => subAgentsBlock(c)!.children.every((x) => x.status !== 'running'));
    await new Promise((r) => setTimeout(r, 30));
    await c.submit('o que vc fez ate agora');
    const lista = (
      c as unknown as { listaFilhosParaGestao(): readonly unknown[] }
    ).listaFilhosParaGestao();
    expect(subAgentsBlock(c)!.children.every((x) => x.status === 'cancelled')).toBe(true);
    expect(lista).toHaveLength(0);
    expect(notes(c)).not.toMatch(/concluíram|fan-out concluído/);
  });

  it('p na raiz = ESC (filhos seguem)', async () => {
    const { model, release } = scenario(['a', 'b']);
    const c = build(model);
    const done = c.submit('delegue');
    await waitFor(() => c.flowOverview().filter((n) => n.kind === 'subagent').length === 2);
    expect(c.cancelFlow('root')).toBe(true);
    await done;
    expect(subAgentsBlock(c)!.children.every((x) => x.status === 'running')).toBe(true);
    release('a');
    release('b');
    await waitFor(() => subAgentsBlock(c)!.children.every((x) => x.status === 'done'));
  });
  it('F8 deixa nota com a origem', async () => {
    const { model } = scenario(['a', 'b', 'c']);
    const c = build(model);
    const done = c.submit('delegue');
    await waitFor(() => c.flowOverview().filter((n) => n.kind === 'subagent').length === 3);
    c.interrupt();
    await done;
    c.cancelAllFlows('panel');
    expect(notes(c)).toContain('3 sub-agentes parados por Ctrl+T → P.');
  });
});
