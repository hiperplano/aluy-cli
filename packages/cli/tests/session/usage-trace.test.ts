/* eslint-disable @typescript-eslint/no-explicit-any -- linhas JSONL lidas em teste */
// Rastro de uso por request (`ALUY_DEBUG_USAGE`): opt-in, custo zero desligado, só tamanhos/nomes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelClient, ModelStreamEvent, StreamCallArgs } from '@hiperplano/aluy-cli-core';
import { makeUsageTracer, traceClient, withTraceLabel } from '../../src/session/usage-trace.js';

const SEGREDO = 'CONTEUDO-SECRETO-NAO-PODE-VAZAR-123';
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aluy-usage-'));
  file = join(dir, 'sub', 'usage.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fake = (usage?: Record<string, unknown>): ModelClient => ({
  async *stream(): AsyncGenerator<ModelStreamEvent> {
    yield { type: 'start', request_id: 'r' };
    yield { type: 'delta', content: 'ok' };
    if (usage) yield { type: 'usage', usage: { request_id: 'r', tier: 't', ...usage } as never };
    yield { type: 'done', finish_reason: 'stop' };
  },
  async call() {
    return {
      request_id: 'r',
      content: 'ok',
      finish_reason: 'stop',
      usage: { request_id: 'r', tier: 't', tokens_in: 7, tokens_out: 3 },
    } as never;
  },
});
const req = (system: string, extra = 0, tools = true): StreamCallArgs['request'] =>
  ({
    tier: 'aluy-flux',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${SEGREDO} pedido` },
      ...Array.from({ length: extra }, () => ({ role: 'assistant', content: `${SEGREDO} resp` })),
      { role: 'tool', content: `${SEGREDO} resultado`, tool_call_id: 'c1' },
    ],
    ...(tools
      ? {
          tools: [
            { type: 'function', function: { name: 'read_file', description: 'x', parameters: {} } },
            { type: 'function', function: { name: 'edit_file', description: 'y', parameters: {} } },
          ],
        }
      : {}),
  }) as never;
const drain = async (c: ModelClient, r: StreamCallArgs['request']): Promise<void> => {
  for await (const _ of c.stream({ request: r })) void _;
};
const lines = (): Record<string, any>[] =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

describe('usage-trace', () => {
  it('DESLIGADO: devolve o PRÓPRIO client e não cria arquivo (custo zero)', async () => {
    const c = fake();
    expect(traceClient(c, () => 'x', {})).toBe(c);
    expect(makeUsageTracer({})).toBeUndefined();
    expect(makeUsageTracer({ ALUY_DEBUG_USAGE: '  ' })).toBeUndefined();
    await drain(c, req('S'));
    expect(existsSync(file)).toBe(false);
  });

  it('LIGADO: uma linha por request com tamanhos, nomes e uso reportado — SEM conteúdo', async () => {
    const c = traceClient(
      fake({
        tokens_in: 1000,
        tokens_cached: 800,
        tokens_out: 50,
        tokens_reasoning: 10,
        provider: 'openrouter',
        model: 'glm',
      }),
      () => 'task t1',
      { ALUY_DEBUG_USAGE: file },
    );
    await drain(c, req('SYS'.repeat(100)));
    const [l] = lines();
    expect(l).toMatchObject({
      session: 'task t1',
      request: 1,
      provider: 'openrouter',
      model: 'glm',
      messages: 3,
      last_role: 'tool',
      tool_names: ['read_file', 'edit_file'],
      usage: {
        prompt_tokens: 1000,
        cached_tokens: 800,
        completion_tokens: 50,
        reasoning_tokens: 10,
      },
    });
    expect(l!['chars'].system).toBe(300);
    expect(l!['chars'].tools).toBeGreaterThan(50);
    expect(l!['chars'].history).toBe(`${SEGREDO} pedido`.length);
    expect(l!['chars'].last).toBe(`${SEGREDO} resultado`.length);
    expect(typeof l!['ts']).toBe('string');
    // nada de conteúdo, chave ou cabeçalho no arquivo
    expect(readFileSync(file, 'utf8')).not.toContain(SEGREDO);
    expect(readFileSync(file, 'utf8')).not.toContain('SYSSYS');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('índice por sessão; prefixo (tools+system) estável vs. mudado entre requests', async () => {
    const c = traceClient(fake({ tokens_in: 1, tokens_out: 1 }), () => 'task t1', {
      ALUY_DEBUG_USAGE: file,
    });
    await drain(c, req('A'.repeat(500)));
    await drain(c, req('A'.repeat(500), 2)); // histórico cresceu; prefixo igual
    await drain(c, req('A'.repeat(100) + 'B'.repeat(400))); // system mudou no meio
    const ls = lines();
    expect(ls.map((l) => l['request'])).toEqual([1, 2, 3]);
    expect(ls[0]!['prefix_same_chars']).toBeUndefined();
    expect(ls[1]!['prefix_same_chars']).toBe(ls[1]!['prefix_prev_chars']); // idêntico ⇒ cache acerta
    expect(ls[2]!['prefix_same_chars']).toBeLessThan(ls[2]!['prefix_prev_chars']); // quebrou
    expect(ls[1]!['head_hash']).toBe(ls[0]!['head_hash']);
    expect(ls[2]!['head_hash']).not.toBe(ls[0]!['head_hash']);
  });

  it('sub-agente: rótulo `<sessão>/sub:<nome>` e contador próprio; `call` também é rastreado', async () => {
    const tracer = makeUsageTracer({ ALUY_DEBUG_USAGE: file })!;
    const c = tracer(fake({ tokens_in: 1, tokens_out: 1 }), () => 'task t2');
    const caller = withTraceLabel(
      { call: async () => drain(c, req('S')) } as { call: (...a: never[]) => Promise<void> },
      'fix',
    );
    await drain(c, req('S'));
    await caller.call();
    await caller.call();
    await c.call({ request: req('S', 0, false) });
    const ls = lines();
    expect(ls.map((l) => `${l['session']}#${l['request']}`)).toEqual([
      'task t2#1',
      'task t2/sub:fix#1',
      'task t2/sub:fix#2',
      'task t2#2',
    ]);
    expect(ls[3]!['usage']).toMatchObject({ prompt_tokens: 7, completion_tokens: 3 });
    expect(ls[3]!['tool_names']).toEqual([]);
  });

  it('erro de escrita nunca derruba a sessão', async () => {
    writeFileSync(join(dir, 'arquivo'), 'x'); // um ARQUIVO no lugar da pasta ⇒ ENOTDIR
    const c = traceClient(fake(), () => 'x', {
      ALUY_DEBUG_USAGE: join(dir, 'arquivo', 'usage.jsonl'),
    });
    await expect(drain(c, req('S'))).resolves.toBeUndefined();
  });
});
