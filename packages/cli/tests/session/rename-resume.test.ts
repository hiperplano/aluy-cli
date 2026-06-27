// EST-0972 (rename) — INTEGRAÇÃO do /rename através do `runSession` (não-TTY, sem Ink):
//   - `/rename projeto-x --cor azul` PERSISTE label+cor no record (não chama o broker);
//   - `/rename` (default) deriva a cor determinística do nome;
//   - `--continue` RESTAURA o rótulo+cor na sessão retomada;
//   - cor inválida ⇒ erro ecoado, NADA persistido;
//   - `/rename --limpar` remove o rótulo do record.
//
// Sem rede real (broker stub). ~/.aluy + workspace em tmpdir — NUNCA toca o real.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
import { SessionStore } from '../../src/io/session-store.js';
import { UserConfigStore } from '../../src/io/user-config.js';
import { UserAgentsLoader } from '../../src/io/index.js';
import { hashToSessionColor } from '../../src/ui/theme/session-colors.js';

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

function capturingBroker(): { client: BrokerModelClient; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const client = {
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

// EST-0972 (flake #131) — com o boot hermético (mcpTools:[] + agentes no tmpdir, ver
// `run()`), cada caso roda em ~ms mesmo rodando 2–3 `runSession` em sequência. 10s é
// folga generosa p/ cobertura+contenção sem inflar a ponto de mascarar regressão de
// lentidão (era 20s só p/ absorver o spawn de MCP real, que não acontece mais).
const TIMEOUT = 10000;

describe('runSession — /rename persistência + resume (EST-0972)', { timeout: TIMEOUT }, () => {
  let base: string;
  let aluyDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-rename-int-'));
    aluyDir = join(base, 'home', '.aluy');
    workspaceRoot = join(base, 'project');
    mkdirSync(workspaceRoot, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  async function run(opts: {
    goal: string;
    resume?: { kind: 'continue' };
    store?: SessionStore;
  }): Promise<{
    store: SessionStore;
    calls: ChatMessage[][];
    out: ReturnType<typeof nonTtyStdout>;
  }> {
    const store = opts.store ?? new SessionStore({ baseDir: aluyDir });
    const { client, calls } = capturingBroker();
    const out = nonTtyStdout();
    await runSession({
      goal: opts.goal,
      stdout: out,
      env: {},
      store: new MemoryStore(),
      brokerClient: client,
      catalogClient: stubCatalog as never,
      workspaceRoot,
      sessionStore: store,
      configStore: new UserConfigStore({ baseDir: aluyDir }),
      // EST-0972 (flake crônico de CI #131) — HERMETICIDADE do boot. Sem isto, o
      // `setupMcp` lia o `~/.aluy/mcp.json` REAL e LANÇAVA os servers MCP (`npx -y …`,
      // ~2s de handshake CADA) a cada `runSession` — e estes testes rodam 2–3 deles em
      // sequência ⇒ estouravam o teto de 20s sob cobertura+contenção do runner. `mcpTools:
      // []` curto-circuita o spawn (estes testes cobrem /rename, NÃO MCP) e o loader de
      // agentes aponta p/ o tmpdir (não lê `~/.aluy/agents` real). Boot vira ~ms; nenhuma
      // asserção de /rename/resume muda.
      mcpTools: [],
      userAgentsLoader: new UserAgentsLoader({ baseDir: aluyDir }),
      ...(opts.resume ? { resume: opts.resume } : {}),
    });
    return { store, calls, out };
  }

  it('`/rename projeto-x --cor azul` ⇒ persiste label+cor (NÃO chama o broker)', async () => {
    // 1º: um turno real cria a sessão (com transcrição não-vazia p/ o auto-save gravar).
    const a = await run({ goal: 'objetivo inicial' });
    const id = a.store.list()[0]!.id;
    // 2º: o /rename, retomando a MESMA sessão do cwd.
    const b = await run({
      goal: '/rename projeto-x --cor azul',
      resume: { kind: 'continue' },
      store: a.store,
    });
    // não foi tratado como objetivo p/ o modelo (o broker não viu "/rename …").
    const flat = b.calls
      .flat()
      .map((m) => m.content)
      .join('\n');
    expect(flat).not.toContain('/rename');
    expect(b.out.text()).toContain('rename');
    const rec = b.store.load(id)!;
    expect(rec.label).toBe('projeto-x');
    expect(rec.labelColor).toBe('azul');
  });

  it('`/rename` SEM --cor ⇒ cor DETERMINÍSTICA do nome', async () => {
    const a = await run({ goal: 'oi' });
    await run({ goal: '/rename meu-app', resume: { kind: 'continue' }, store: a.store });
    const rec = a.store.load(a.store.list()[0]!.id)!;
    expect(rec.label).toBe('meu-app');
    expect(rec.labelColor).toBe(hashToSessionColor('meu-app'));
  });

  it('`--continue` RESTAURA o rótulo+cor (sobrevive ao boot da sessão retomada)', async () => {
    const a = await run({ goal: 'oi' });
    await run({
      goal: '/rename projeto-x --cor verde',
      resume: { kind: 'continue' },
      store: a.store,
    });
    // 3º turno --continue: o rótulo continua no record (não é apagado ao retomar).
    const c = await run({ goal: 'segue', resume: { kind: 'continue' }, store: a.store });
    const rec = c.store.load(c.store.list()[0]!.id)!;
    expect(rec.label).toBe('projeto-x');
    expect(rec.labelColor).toBe('verde');
  });

  it('cor INVÁLIDA ⇒ erro ecoado, NADA persistido', async () => {
    const a = await run({ goal: 'oi' });
    const b = await run({
      goal: '/rename proj --cor neon',
      resume: { kind: 'continue' },
      store: a.store,
    });
    expect(b.out.text()).toContain('cor inválida');
    const rec = b.store.load(b.store.list()[0]!.id)!;
    expect(rec.label).toBeUndefined();
  });

  it('`/rename --limpar` ⇒ remove o rótulo do record', async () => {
    const a = await run({ goal: 'oi' });
    await run({ goal: '/rename proj --cor rosa', resume: { kind: 'continue' }, store: a.store });
    expect(a.store.load(a.store.list()[0]!.id)!.label).toBe('proj');
    const c = await run({ goal: '/rename --limpar', resume: { kind: 'continue' }, store: a.store });
    expect(c.store.load(c.store.list()[0]!.id)!.label).toBeUndefined();
  });
});
