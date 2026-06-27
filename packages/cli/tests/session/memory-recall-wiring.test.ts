// EST-0983 — INTEGRAÇÃO (fix de fiação): a memória ESCRITA numa sessão é RELEMBRADA
// na sessão seguinte (recall ⇒ bootSeed ⇒ chamada de modelo), em TTY e NÃO-TTY, e o
// `/memory` é ROTEADO pelo router (não cai no agente). Monta o wiring REAL
// (`runSession`/`NodeMemoryStore`) com baseDir + workspace temporários.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrokerModelClient, ChatMessage } from '@aluy/cli-core';
import { runSession } from '../../src/session/run.js';
import { buildSession } from '../../src/session/wiring.js';
import { NodeMemoryStore } from '../../src/io/memory-store.js';
import { SessionStore } from '../../src/io/index.js';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { AgentMemory } from '@aluy/cli-core';

/** Broker stub: captura TODO o conteúdo de mensagens (qualquer canal) por chamada. */
function capturingBroker(): { client: BrokerModelClient; calls: string[][] } {
  const calls: string[][] = [];
  const client: BrokerModelClient = {
    async *stream(args: { request: { messages: readonly ChatMessage[] } }) {
      calls.push(args.request.messages.map((m) => m.content));
      yield { type: 'start', request_id: 'r', session_id: 's' } as never;
      yield { type: 'delta', content: 'ok.' } as never;
      yield { type: 'done', finish_reason: 'stop' } as never;
    },
  } as unknown as BrokerModelClient;
  return { client, calls };
}

/** stdout fake (não-TTY) que acumula o texto linear. */
function fakeStdout(): NodeJS.WriteStream & { text: string } {
  const out = {
    text: '',
    isTTY: false,
    write(chunk: string) {
      (out as { text: string }).text += chunk;
      return true;
    },
  } as unknown as NodeJS.WriteStream & { text: string };
  return out;
}

describe('EST-0983 · recall ponta-a-ponta (memória escrita é relembrada)', () => {
  let workspaceRoot: string;
  let memoryBaseDir: string;
  let homeDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'mem-ws-'));
    memoryBaseDir = mkdtempSync(join(tmpdir(), 'mem-base-'));
    // ~/.aluy de sessões/journal/config isolado (a suíte nunca toca o real do dev).
    homeDir = mkdtempSync(join(tmpdir(), 'mem-home-'));
  });
  afterEach(() => {
    for (const d of [workspaceRoot, memoryBaseDir, homeDir]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  /** Escreve um fato de PROJETO direto pela mecânica real (como a tool `remember`). */
  async function seedProjectFact(text: string): Promise<void> {
    const ws = new NodeWorkspace({ root: workspaceRoot });
    const store = new NodeMemoryStore({ workspace: ws, baseDir: memoryBaseDir });
    const mem = new AgentMemory({ store });
    const r = await mem.remember(text, 'projeto', 'usuario');
    expect(r.ok).toBe(true);
  }
  async function seedGlobalFact(text: string): Promise<void> {
    const ws = new NodeWorkspace({ root: workspaceRoot });
    const store = new NodeMemoryStore({ workspace: ws, baseDir: memoryBaseDir });
    const mem = new AgentMemory({ store });
    const r = await mem.remember(text, 'global', 'usuario');
    expect(r.ok).toBe(true);
  }

  const baseOpts = () => ({
    env: { HOME: homeDir, USERPROFILE: homeDir },
    workspaceRoot,
    memoryBaseDir,
    journalBaseDir: join(homeDir, '.aluy'),
    // ISOLA o auto-save da sessão (mesma razão do journal: `os.homedir()` ignora o
    // `env.HOME` injetado ⇒ o `SessionStore` default poluiria o `~/.aluy/` REAL do dev).
    sessionStore: new SessionStore({ baseDir: join(homeDir, '.aluy') }),
    // Hermético: NÃO descobre MCP do `~/.aluy/mcp.json` real do dev (setupMcp usa
    // homedir(), não env.HOME) — a memória/recall independe disso.
    mcpTools: [],
  });

  it('NÃO-TTY: o fato de PROJETO escrito vira contexto da chamada de modelo seguinte', async () => {
    await seedProjectFact('o projeto se chama Vega e usa pnpm');
    const { client, calls } = capturingBroker();
    const out = fakeStdout();
    await runSession({
      ...baseOpts(),
      brokerClient: client,
      stdout: out,
      goal: 'qual o nome do meu projeto?',
    });
    expect(calls.length).toBeGreaterThan(0);
    const allContent = calls.flat().join('\n');
    expect(allContent).toContain('Vega');
  });

  it('NÃO-TTY: o fato GLOBAL escrito também é relembrado', async () => {
    await seedGlobalFact('o usuário se chama Tiago e prefere PT-BR');
    const { client, calls } = capturingBroker();
    const out = fakeStdout();
    await runSession({
      ...baseOpts(),
      brokerClient: client,
      stdout: out,
      goal: 'quem sou eu?',
    });
    const allContent = calls.flat().join('\n');
    expect(allContent).toContain('Tiago');
  });

  it('NÃO-TTY: `/memory` é ROTEADO (lista o fato) e NÃO vira objetivo p/ o agente', async () => {
    await seedProjectFact('o projeto se chama Vega e usa pnpm');
    const { client, calls } = capturingBroker();
    const out = fakeStdout();
    await runSession({
      ...baseOpts(),
      brokerClient: client,
      stdout: out,
      goal: '/memory',
    });
    // O comando foi tratado localmente: o broker NÃO foi chamado com "/memory".
    expect(calls.length).toBe(0);
    // E a listagem saiu, com o fato (não "vazia").
    expect(out.text).toContain('Vega');
    expect(out.text).not.toContain('memória vazia');
  });

  it('recall direto do wiring real (buildSession) devolve o fato escrito', async () => {
    await seedProjectFact('o projeto se chama Vega e usa pnpm');
    const built = buildSession({
      ...baseOpts(),
      brokerClient: capturingBroker().client,
    });
    const seed = await built.memory.recall();
    expect(seed.length).toBe(1);
    expect(seed[0]!.text).toContain('Vega');
  });

  it('TTY (boot recall→seedHistory→submit): o fato escrito chega à chamada de modelo', async () => {
    // Espelha o boot do run.tsx em TTY (recall ⇒ seedHistory ⇒ submit) sem montar Ink.
    await seedProjectFact('o projeto se chama Vega e usa pnpm');
    const { client, calls } = capturingBroker();
    const built = buildSession({ ...baseOpts(), brokerClient: client });
    const seed = await built.memory.recall();
    built.controller.seedHistory([...seed]);
    await built.controller.submit('qual o nome do meu projeto?');
    const allContent = calls.flat().join('\n');
    expect(allContent).toContain('Vega');
  });
});
