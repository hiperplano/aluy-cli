// `--anonymous` — INTEGRAÇÃO ponta-a-ponta: prova que uma sessão anônima não deixa
// NENHUM rastro em disco (não intenção — arquivo/diretório de verdade), e que SEM a
// flag o comportamento de hoje continua intacto (não-regressão).
//
// `homedir()` é MOCKADO p/ um tmpdir isolado (mesmo padrão de
// `session-command-port-exec.test.ts`/`cron.test.ts`): isto deixa TODA a resolução
// default de `~/.aluy/...` (sessions/memory/config/journal) apontar p/ o tmpdir SEM
// precisar injetar cada store individualmente — o jeito mais fiel de testar o
// caminho REAL que `bin/aluy.ts`→`run.tsx`→`wiring.ts` percorre em produção (a
// suíte NUNCA toca o `~/.aluy/` real do dev).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { testHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  return { testHome: fs.mkdtempSync(path.join(os.tmpdir(), 'aluy-anon-home-')) };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => testHome };
});

import { mkdtempSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  BrokerModelClient,
  ChatMessage,
  CredentialStore,
  StoredCredential,
} from '@hiperplano/aluy-cli-core';
import { runSession } from '../../src/session/run.js';
import { buildSession } from '../../src/session/wiring.js';

void testHome; // referenciado só pelo mock acima (o linter não vê o uso direto).

class MemoryCredStore implements CredentialStore {
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

/** Broker stub: emite um turno final mínimo, SEM tool-call (turno "faça algo"→"feito."). */
function capturingBroker(): { client: BrokerModelClient; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const client: BrokerModelClient = {
    async *stream(args: { request: { messages: readonly ChatMessage[] } }) {
      calls.push([...args.request.messages]);
      yield { type: 'start', request_id: 'r', session_id: 's' } as never;
      yield { type: 'delta', content: 'feito.' } as never;
      yield { type: 'done', finish_reason: 'stop' } as never;
    },
  } as unknown as BrokerModelClient;
  return { client, calls };
}

function nonTtyStdout(): NodeJS.WriteStream & { text: () => string } {
  const pt = new PassThrough();
  let buf = '';
  pt.on('data', (c: Buffer) => (buf += c.toString('utf8')));
  const s = pt as unknown as NodeJS.WriteStream & { text: () => string };
  s.text = () => buf;
  return s;
}

const ALUY_DIR = join(testHome, '.aluy');
const SESSIONS_DIR = join(ALUY_DIR, 'sessions');
const MEMORY_DIR = join(ALUY_DIR, 'memory');

describe('runSession — `--anonymous` não deixa rastro em disco (integração real)', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'aluy-anon-ws-'));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    // limpa o `~/.aluy/` (mockado) ENTRE testes — cada teste começa numa "máquina" limpa.
    rmSync(ALUY_DIR, { recursive: true, force: true });
  });

  it('com --anonymous: NENHUM arquivo aparece em ~/.aluy/sessions/ nem ~/.aluy/memory/', async () => {
    const { client } = capturingBroker();
    const out = nonTtyStdout();
    await runSession({
      goal: 'faça algo',
      stdout: out,
      env: {}, // objeto PRÓPRIO (não process.env) — a mutação de ALUY_MEM_OFF/HEADROOM_OFF
      // do modo anônimo fica confinada a este teste, nunca vaza pro processo real.
      store: new MemoryCredStore(),
      brokerClient: client,
      catalogClient: stubCatalog as never,
      workspaceRoot,
      mcpTools: [],
      anonymous: true,
    });
    // a prova FORTE: nem o DIRETÓRIO nasceu (não só "está vazio").
    expect(existsSync(SESSIONS_DIR)).toBe(false);
    expect(existsSync(MEMORY_DIR)).toBe(false);
  });

  it('SEM --anonymous (não-regressão): o arquivo de sessão É criado como hoje', async () => {
    const { client } = capturingBroker();
    const out = nonTtyStdout();
    await runSession({
      goal: 'faça algo',
      stdout: out,
      // mem0 OFF aqui só p/ não depender de rede real neste teste (ele testa SESSÃO, não
      // memória) — mesmo hermetismo que `session-resume.test.ts` já usa.
      env: { ALUY_MEM_OFF: '1' },
      store: new MemoryCredStore(),
      brokerClient: client,
      catalogClient: stubCatalog as never,
      workspaceRoot,
      mcpTools: [],
      // `anonymous` ausente ⇒ comportamento de hoje.
    });
    expect(existsSync(SESSIONS_DIR)).toBe(true);
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
  });
});

describe('buildSession — `--anonymous` deixa a memória de agente INERTE', () => {
  let workspaceRoot: string;
  let memoryBaseDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'aluy-anon-mem-ws-'));
    memoryBaseDir = mkdtempSync(join(tmpdir(), 'aluy-anon-mem-base-'));
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(memoryBaseDir, { recursive: true, force: true });
  });

  it('anonymous:true — remember() funciona NA SESSÃO mas NADA é escrito em memoryBaseDir', async () => {
    const s = buildSession({
      workspaceRoot,
      memoryBaseDir,
      env: {},
      anonymous: true,
    });
    const outcome = await s.memory.remember('fato que NÃO pode sobrar no disco', 'global', 'usuario');
    expect(outcome.ok).toBe(true); // o modelo/usuário não veem erro dentro da sessão.
    const recalled = await s.memory.recall();
    expect(recalled.length).toBe(1); // e o fato SEGUE visível NESTA sessão (RAM).
    // mas em disco — nada. Nem o diretório nasceu.
    expect(existsSync(join(memoryBaseDir, 'memory'))).toBe(false);
    expect(existsSync(join(memoryBaseDir, 'memory', 'global.md'))).toBe(false);
  });

  it('não-regressão: SEM anonymous, remember() grava global.md de verdade', async () => {
    const s = buildSession({
      workspaceRoot,
      memoryBaseDir,
      env: {},
    });
    const outcome = await s.memory.remember('fato normal', 'global', 'usuario');
    expect(outcome.ok).toBe(true);
    expect(existsSync(join(memoryBaseDir, 'memory', 'global.md'))).toBe(true);
  });
});
