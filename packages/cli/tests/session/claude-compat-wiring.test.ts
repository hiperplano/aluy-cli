// EST-0979 — INTEGRAÇÃO via `runSession` (não-TTY): COMPAT com o padrão Claude Code
// (e Codex). Prova end-to-end que:
//   • `CLAUDE.md` (e `AGENTS.md`) no workspace ⇒ injetado como instrução no `system`
//     (igual ao `AGENT.md` da EST-0964);
//   • precedência: AGENT.md lidera a composição quando há mais de um;
//   • CONFINAMENTO: a config de PROJETO é lida SÓ do workspace (um CLAUDE.md fora da
//     raiz, apontado por symlink, NÃO é injetado).
//
// Config de projeto = DADO confinado ao workspace; NÃO relaxa a catraca (esta suíte
// foca na DESCOBERTA/precedência/confinamento — o gate MCP é provado em mcp-gate/setup).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  BrokerModelClient,
  ChatMessage,
  CredentialStore,
  StoredCredential,
} from '@hiperplano/aluy-cli-core';
import { PROJECT_INSTRUCTIONS_HEADER } from '@hiperplano/aluy-cli-core';
import { runSession } from '../../src/session/run.js';
import { SessionStore } from '../../src/io/index.js';

class MemoryStore implements CredentialStore {
  cred: StoredCredential | null = null;
  async get(): Promise<StoredCredential | null> {
    return this.cred;
  }
  async set(c: StoredCredential): Promise<void> {
    this.cred = c;
  }
  async clear(): Promise<void> {
    this.cred = null;
  }
}

const stubCatalog = { list: async () => [] };

function capturingBroker(): { client: BrokerModelClient; systems: string[] } {
  const systems: string[] = [];
  const client: BrokerModelClient = {
    async *stream(args: { request: { messages: readonly ChatMessage[] } }) {
      const sys = args.request.messages.find((m) => m.role === 'system');
      if (sys) systems.push(sys.content);
      yield { type: 'start', request_id: 'r', session_id: 's' } as never;
      yield { type: 'delta', content: 'feito.' } as never;
      yield { type: 'done', finish_reason: 'stop' } as never;
    },
  } as unknown as BrokerModelClient;
  return { client, systems };
}

function nonTtyStdout(): NodeJS.WriteStream {
  return new PassThrough() as unknown as NodeJS.WriteStream;
}

describe('EST-0979 · runSession compat Claude Code/Codex (não-TTY)', () => {
  let base: string;
  let workspaceRoot: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-compat-int-'));
    workspaceRoot = join(base, 'project');
    mkdirSync(workspaceRoot, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  async function run(): Promise<string[]> {
    const { client, systems } = capturingBroker();
    // `mcpTools: []` evita a descoberta MCP de disco no teste (foca em instruções).
    await runSession({
      goal: 'faça algo',
      stdout: nonTtyStdout(),
      env: {},
      store: new MemoryStore(),
      brokerClient: client,
      catalogClient: stubCatalog as never,
      workspaceRoot,
      // ISOLA o auto-save da sessão no tmpdir do teste — o `SessionStore` default usa
      // `os.homedir()` (não o `env` injetado) ⇒ sem isto, cada caso grava em
      // `~/.aluy/sessions/` REAL do dev, poluindo o `/history` do usuário.
      sessionStore: new SessionStore({ baseDir: join(base, '.aluy') }),
      mcpTools: [],
    });
    return systems;
  }

  it('CLAUDE.md presente ⇒ injetado como instrução no system (igual ao AGENT.md)', async () => {
    writeFileSync(join(workspaceRoot, 'CLAUDE.md'), '# claude\nrode `pnpm test` no CI.');
    const systems = await run();
    expect(systems.length).toBeGreaterThan(0);
    expect(systems[0]!).toContain(PROJECT_INSTRUCTIONS_HEADER);
    expect(systems[0]!).toContain('rode `pnpm test` no CI');
  });

  it('AGENTS.md presente ⇒ injetado como instrução no system (Codex)', async () => {
    writeFileSync(join(workspaceRoot, 'AGENTS.md'), 'convenções do Codex no repo.');
    const systems = await run();
    expect(systems[0]!).toContain('convenções do Codex no repo');
  });

  it('precedência: AGENT.md + CLAUDE.md ⇒ ambos compõem, AGENT.md primeiro', async () => {
    writeFileSync(join(workspaceRoot, 'AGENT.md'), 'PRIMARIO-NATIVO');
    writeFileSync(join(workspaceRoot, 'CLAUDE.md'), 'COMPAT-CLAUDE');
    const systems = await run();
    const sys = systems[0]!;
    expect(sys).toContain('PRIMARIO-NATIVO');
    expect(sys).toContain('COMPAT-CLAUDE');
    expect(sys.indexOf('PRIMARIO-NATIVO')).toBeLessThan(sys.indexOf('COMPAT-CLAUDE'));
  });

  it('SEM nenhum arquivo de instrução ⇒ system NÃO carrega cabeçalho de projeto', async () => {
    const systems = await run();
    expect(systems[0]!).not.toContain(PROJECT_INSTRUCTIONS_HEADER);
  });

  it('CONFINAMENTO — CLAUDE.md symlink p/ FORA da raiz NÃO é injetado', async () => {
    const secret = join(base, 'outside-CLAUDE.md');
    writeFileSync(secret, 'SEGREDO-FORA-DO-WORKSPACE');
    symlinkSync(secret, join(workspaceRoot, 'CLAUDE.md'));
    const systems = await run();
    expect(systems[0]!).not.toContain('SEGREDO-FORA-DO-WORKSPACE');
    // sem outra fonte ⇒ sem cabeçalho de projeto (o de fora foi rejeitado).
    expect(systems[0]!).not.toContain(PROJECT_INSTRUCTIONS_HEADER);
  });
});
