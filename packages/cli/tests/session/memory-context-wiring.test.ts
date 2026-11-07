// ADR 0004 — INTEGRAÇÃO buildSession: o fato `usuario` gravado numa sessão aparece como
// instrução no `system` da sessão SEGUINTE (restart/resume) e já no turno seguinte da mesma.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrokerModelClient, ChatMessage } from '@hiperplano/aluy-cli-core';
import { MEMORY_USER_HEADER, UNTRUSTED_OPEN } from '@hiperplano/aluy-cli-core';
import { buildSession } from '../../src/session/wiring.js';

function broker(): { client: BrokerModelClient; systems: string[] } {
  const systems: string[] = [];
  const client = {
    async *stream(args: { request: { messages: readonly ChatMessage[] } }) {
      const sys = args.request.messages.find((m) => m.role === 'system');
      if (sys) systems.push(sys.content);
      yield { type: 'start', request_id: 'r', session_id: 's' } as never;
      yield { type: 'delta', content: 'pronto.' } as never;
      yield { type: 'done', finish_reason: 'stop' } as never;
    },
  } as unknown as BrokerModelClient;
  return { client, systems };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aluy-memctx-'));
  mkdirSync(join(tmp, 'ws'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
const base = () => ({
  env: {},
  workspaceRoot: join(tmp, 'ws'),
  memoryBaseDir: join(tmp, 'mem'),
  todoBaseDir: join(tmp, 'todo'),
});

describe('memória do dono → system', () => {
  it('remember usuario vale no turno seguinte E numa sessão nova (restart), sem envelope de dado', async () => {
    const a = broker();
    const s1 = buildSession({ ...base(), brokerClient: a.client });
    await s1.controller.submit('turno 1');
    expect(a.systems[0]).not.toContain(MEMORY_USER_HEADER);
    await s1.memory.remember('não implemente, só chame sub-agentes', 'projeto', 'usuario');
    await s1.controller.submit('turno 2');
    expect(a.systems[1]).toContain(MEMORY_USER_HEADER);
    expect(a.systems[1]).toContain('não implemente, só chame sub-agentes');

    const b = broker();
    const s2 = buildSession({ ...base(), brokerClient: b.client });
    await s2.controller.submit('depois do restart');
    expect(b.systems[0]).toContain('não implemente, só chame sub-agentes');
    expect(b.systems[0]).not.toContain(`${UNTRUSTED_OPEN}\nFatos lembrados`);
  });
});
