/* eslint-disable @typescript-eslint/no-explicit-any -- linhas JSONL lidas em teste */
// ADR 0006 — "aprovar sempre nesta tarefa" pela fiação REAL da sessão de tarefa (buildSession),
// não só pela engine isolada: a flag ligada via `/a!` tem de valer para as próximas
// ferramentas do MESMO turno, inclusive as de sub-agentes da tarefa.

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK_EXCLUDED_TOOLS } from '@hiperplano/aluy-cli-core';
import { buildSession } from '../../src/session/wiring.js';
import { ConciergeRuntime, type ConversationSink } from '../../src/session/concierge-runtime.js';

const OPEN = '<<<ALUY_TOOL_CALL';
const CLOSE = 'ALUY_TOOL_CALL>>>';
const tool = (name: string, input: Record<string, unknown>): string =>
  `${OPEN}\n${JSON.stringify({ name, input })}\n${CLOSE}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor: prazo');
    await sleep(10);
  }
}

const store = {
  async get() {
    return {
      kind: 'pat',
      pat: 'aluy_pat_teste_nao_real',
      organization_id: 'org-t',
      scopes: ['assistant:session', 'llm:call'],
      v: 1,
    };
  },
  async set() {},
  async clear() {},
};

function sse(text: string) {
  const ev = [
    { event: 'start', data: { request_id: 'r', session_id: 's' } },
    ...text.split('').map((ch) => ({ event: 'delta', data: { content: ch } })),
    { event: 'usage', data: { request_id: 'r', tier: 'aluy-flux', tokens_in: 5, tokens_out: 9 } },
    { event: 'done', data: { finish_reason: 'stop' } },
  ]
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: {
      async *[Symbol.asyncIterator]() {
        yield ev;
      },
    },
    json: async () => ({}),
    text: async () => '',
  };
}

describe('"aprovar sempre nesta tarefa" na fiação real da sessão', () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'aluy-always-'));
    writeFileSync(
      join(ws, 'calc.py'),
      'def add(a, b):\n    return a - b\n\ndef sub(a, b):\n    return a + b\n',
    );
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  async function run(outputs: string[]): Promise<ConciergeRuntime> {
    let n = 0;
    const sink = {
      pushConciergeEcho() {},
      pushConciergeLine() {},
      conciergeReplyStart() {},
      conciergeReplyEnd() {},
      cancelAllFlows() {},
    } as ConversationSink;
    const mk = () =>
      buildSession({
        workspaceRoot: ws,
        store,
        brokerFetch: (async (url: string) =>
          url.endsWith('/v1/chat')
            ? sse(outputs[Math.min(n++, outputs.length - 1)]!)
            : { ...sse(''), body: undefined, json: async () => ({}) }) as never,
        mode: 'normal',
        subAgents: { enabled: true, maxConcurrency: 1 },
        env: {
          ALUY_MEM0_URL: 'http://127.0.0.1:1',
          ALUY_BROKER_URL: 'https://broker.mock.local',
          ALUY_IDENTITY_URL: 'https://id.mock.local',
        },
      });
    const rt = new ConciergeRuntime({
      sink,
      model: { call: async () => ({ request_id: 'x', content: 'ok', finish_reason: 'stop' }) },
      createHeadless: () => mk().controller,
    });
    rt.engine.start(rt.registry.create({ goal: 'corrige calc.py', kind: 'main' }));
    return rt;
  }

  const finishes = async (rt: ConciergeRuntime): Promise<void> => {
    await waitFor(
      () => rt.registry.get('t1')?.status === 'done' || rt.pendingApprovals().length > 0,
    );
    expect(rt.pendingApprovals().map((p) => p.summary)).toEqual([]);
    expect(rt.registry.get('t1')!.status).toBe('done');
  };

  it('agente principal: edit/edit/write/run_command/run_tests NÃO perguntam de novo após /a!', async () => {
    const rt = await run([
      tool('read_file', { path: 'calc.py' }),
      tool('edit_file', {
        path: 'calc.py',
        old_string: 'return a - b',
        new_string: 'return a + b',
      }),
      tool('edit_file', {
        path: 'calc.py',
        old_string: 'return a + b\n\ndef',
        new_string: 'return a - b\n\ndef',
      }),
      tool('write_file', { path: 'test_calc.py', content: 'print(1)\n' }),
      tool('run_command', { command: 'python3 -c "print(1)"' }),
      tool('run_tests', { command: 'python3 -c "print(2)"' }),
      'tudo certo.',
    ]);
    await waitFor(() => rt.pendingApprovals().length === 1); // edit_file #1
    expect(rt.pendingApprovals()[0]!.effect?.tool).toBe('edit_file');
    rt.approve('t1', 'always');
    expect(rt.engine.isAllowAll('t1')).toBe(true);
    await finishes(rt);
    expect(readFileSync(join(ws, 'test_calc.py'), 'utf8')).toBe('print(1)\n');
  });

  it('SUB-AGENTE da tarefa: o /a! feito num pedido do filho vale para os próximos do filho', async () => {
    const rt = await run([
      tool('spawn_agent', { agents: [{ label: 'fix', goal: 'corrige calc.py' }], wait: true }),
      // filho:
      tool('read_file', { path: 'calc.py' }),
      tool('edit_file', {
        path: 'calc.py',
        old_string: 'return a - b',
        new_string: 'return a + b',
      }),
      tool('edit_file', {
        path: 'calc.py',
        old_string: 'return a + b\n\ndef',
        new_string: 'return a - b\n\ndef',
      }),
      tool('run_command', { command: 'python3 -c "print(1)"' }),
      'filho terminou.',
      // pai:
      'consolidei.',
    ]);
    await waitFor(() => rt.pendingApprovals().length === 1);
    rt.approve('t1', 'always');
    await finishes(rt);
  });

  it('sessão de TAREFA não manda ao modelo as tools de UI/sala/monitor (menos tokens por chamada)', async () => {
    const seen: string[][] = [];
    const run1 = async (exclude: readonly string[] | undefined): Promise<string[]> => {
      const names: string[] = [];
      const b = buildSession({
        workspaceRoot: ws,
        store,
        brokerFetch: (async (url: string, init?: { body?: string }) => {
          if (!url.endsWith('/v1/chat'))
            return { ...sse(''), body: undefined, json: async () => ({}) };
          const body = JSON.parse(init?.body ?? '{}') as {
            tools?: { function: { name: string } }[];
          };
          for (const t of body.tools ?? []) names.push(t.function.name);
          return sse('pronto.');
        }) as never,
        mode: 'normal',
        subAgents: { enabled: true, maxConcurrency: 1 },
        ...(exclude !== undefined ? { excludeTools: exclude } : {}),
        env: {
          ALUY_MEM0_URL: 'http://127.0.0.1:1',
          ALUY_BROKER_URL: 'https://broker.mock.local',
          ALUY_IDENTITY_URL: 'https://id.mock.local',
        },
      });
      await b.controller.submit('oi');
      return names;
    };
    const full = await run1(undefined);
    const task = await run1(TASK_EXCLUDED_TOOLS);
    seen.push(full, task);
    // (`headroom_retrieve` só existe com o proxy configurado; as demais vêm sempre)
    for (const t of TASK_EXCLUDED_TOOLS) {
      if (t !== 'headroom_retrieve') expect(full).toContain(t);
      expect(task).not.toContain(t);
    }
    // o necessário para trabalhar continua lá
    for (const t of [
      'read_file',
      'edit_file',
      'write_file',
      'run_command',
      'run_tests',
      'grep',
      'spawn_agent',
    ])
      expect(task).toContain(t);
    expect(task.length).toBeLessThan(full.length);
  });

  it('rastro de uso (ALUY_DEBUG_USAGE): tarefa e sub-agente saem rotulados, sem conteúdo; desligado não escreve', async () => {
    const trace = join(ws, 'trace', 'usage.jsonl');
    const outputs = [
      tool('spawn_agent', {
        agents: [{ label: 'fix', goal: 'LEIA-ME-SECRETO corrige calc.py' }],
        wait: true,
      }),
      'filho terminou.',
      'consolidei.',
    ];
    const mk = (env: Record<string, string>) => {
      let n = 0;
      return buildSession({
        workspaceRoot: ws,
        store,
        brokerFetch: (async (url: string) =>
          url.endsWith('/v1/chat')
            ? sse(outputs[Math.min(n++, outputs.length - 1)]!)
            : { ...sse(''), body: undefined, json: async () => ({}) }) as never,
        mode: 'unsafe',
        subAgents: { enabled: true, maxConcurrency: 1 },
        traceLabel: 'task t1',
        env: {
          ALUY_MEM0_URL: 'http://127.0.0.1:1',
          ALUY_BROKER_URL: 'https://broker.mock.local',
          ALUY_IDENTITY_URL: 'https://id.mock.local',
          ...env,
        },
      });
    };
    // desligado: nada é escrito
    await mk({}).controller.submit('delegue');
    expect(existsSync(trace)).toBe(false);
    // ligado
    await mk({ ALUY_DEBUG_USAGE: trace }).controller.submit('delegue');
    const ls = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, any>);
    const sessions = [...new Set(ls.map((l) => l['session'] as string))].sort();
    expect(sessions).toEqual(['task t1', 'task t1/sub:fix']);
    for (const l of ls) {
      expect(l['tool_names'].length).toBeGreaterThan(0);
      expect(l['chars'].system).toBeGreaterThan(0);
      expect(l['usage']).toMatchObject({ prompt_tokens: 5, completion_tokens: 9 });
    }
    expect(readFileSync(trace, 'utf8')).not.toContain('LEIA-ME-SECRETO');
  });

  it('rastro de uso cobre o Concierge (sessão `concierge`)', async () => {
    const trace = join(ws, 'trace', 'c.jsonl');
    const b = buildSession({
      workspaceRoot: ws,
      store,
      brokerFetch: (async (url: string) =>
        url.endsWith('/v1/chat')
          ? sse('Oi!')
          : { ...sse(''), body: undefined, json: async () => ({}) }) as never,
      mode: 'normal',
      env: {
        ALUY_MEM0_URL: 'http://127.0.0.1:1',
        ALUY_BROKER_URL: 'https://broker.mock.local',
        ALUY_IDENTITY_URL: 'https://id.mock.local',
        ALUY_DEBUG_USAGE: trace,
      },
    });
    await b.conciergeModel.call({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'MENSAGEM-PRIVADA' },
      ],
      idempotencyKey: 'k',
    });
    const [l] = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x) as Record<string, any>);
    expect(l).toMatchObject({ session: 'concierge', request: 1 });
    expect(l!['tool_names']).toEqual(['task_start', 'task_send', 'task_stop', 'task_status']);
    expect(readFileSync(trace, 'utf8')).not.toContain('MENSAGEM-PRIVADA');
  });
});
