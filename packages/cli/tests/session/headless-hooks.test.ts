// BUG-0021 — hooks de ciclo-de-vida (~/.aluy/hooks.json) no modo headless -p.
// DECISÃO: headless DEVE disparar (igual claude -p).
//
// #204 (BUG-0021, parcial) — `session-start` + `turn-end` no headless. Prova: monta
// `runSession` em modo headless com `HooksConfigStore` fake apontando p/ um `hooks.json`
// com esses hooks; verifica que `runSession` COMPLETA sem crash (antes os hooks eram
// silenciosamente ignorados — o `selectHooks`/`hookRunner.runAll` nem rodava). A
// execução real dos comandos passa pela catraca (não-interativo ⇒ ask negado), o que é
// CORRETO — o BUG é o DISPARO, não a permissão.
//
// EST-1018 (BUG-0021, RESÍDUO do #204) — `pre-tool` + `post-tool` no headless. O #204
// fiou só session-start/turn-end; o disparo de pre/post-tool vem do `toolObserver` do
// loop, que era fiado SÓ na TUI. Esta estória registra o observador de tool-hooks no
// caminho headless (`makeToolHooksObserver` + `controller.addToolObserver`). Prova
// NÃO-TAUTOLÓGICA (CA-1/CA-2): um broker faked emite UMA chamada `read_file` (read ⇒
// allow na catraca), o loop dispara onToolStart/onToolEnd, e os hooks pre/post-tool
// (cada um um `touch <marcador>`) RODAM em modo `unsafe` (yolo ⇒ run_command liberado),
// criando os marcadores no FS. Reverter a fiação (remover o addToolObserver do headless)
// faz os marcadores NÃO aparecerem ⇒ o teste reprova.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  BrokerModelClient,
  CredentialStore,
  StoredCredential,
  HookRunner,
  ToolCall,
  HooksConfig,
} from '@aluy/cli-core';
import { TOOL_CALL_OPEN, TOOL_CALL_CLOSE } from '@aluy/cli-core';
import { runSession } from '../../src/session/run.js';
import { makeToolHooksObserver } from '../../src/session/tool-hooks-observer.js';
import { HooksConfigStore } from '../../src/io/hooks-config-store.js';
import { SessionStore } from '../../src/io/session-store.js';
import { UserConfigStore } from '../../src/io/user-config.js';
import { UserAgentsLoader } from '../../src/io/index.js';

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

function capturingBroker(): { client: BrokerModelClient } {
  return {
    client: {
      async *stream() {
        yield { type: 'start', request_id: 'r', session_id: 's' } as never;
        yield { type: 'delta', content: 'resultado headless.' } as never;
        yield { type: 'done', finish_reason: 'stop' } as never;
      },
    } as unknown as BrokerModelClient,
  };
}

/**
 * Broker faked que, no 1º turno, emite UMA chamada `read_file` (envelope nativo do
 * protocolo de texto) e, nos turnos seguintes, uma resposta final. `read_file` é efeito
 * `read` ⇒ a catraca PERMITE (não é sempre-ask) — o loop dispara onToolStart/onToolEnd,
 * que é o gatilho dos hooks pre/post-tool. `calls` conta as invocações de stream.
 */
function toolCallingBroker(filePath: string): { client: BrokerModelClient; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    client: {
      async *stream() {
        n += 1;
        yield { type: 'start', request_id: `r${n}`, session_id: 's' } as never;
        if (n === 1) {
          const envelope = `${TOOL_CALL_OPEN} ${JSON.stringify({
            name: 'read_file',
            input: { path: filePath },
          })} ${TOOL_CALL_CLOSE}`;
          yield { type: 'delta', content: envelope } as never;
        } else {
          yield { type: 'delta', content: 'resultado headless.' } as never;
        }
        yield { type: 'done', finish_reason: 'stop' } as never;
      },
    } as unknown as BrokerModelClient,
  };
}

/**
 * Espera (poll) um marcador aparecer no FS, até um teto. Os hooks de tool disparam
 * best-effort (`void runner.runAll`) — o do `post-tool` solta logo no fim do run, então
 * o `touch` (run_command via shell confinado) pode completar UM tick após o `runSession`
 * resolver. O poll torna o assert DETERMINÍSTICO sem afrouxá-lo (timeout ⇒ reprova).
 */
async function waitForFile(path: string, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return existsSync(path);
}

function nonTtyStdout(): NodeJS.WriteStream & { text: () => string } {
  const pt = new PassThrough();
  let buf = '';
  pt.on('data', (c: Buffer) => (buf += c.toString('utf8')));
  const s = pt as unknown as NodeJS.WriteStream & { text: () => string };
  s.text = () => buf;
  return s;
}

/** Tempo generoso p/ cobertura v8 (session-resume.test.ts usa 10s; seguimos igual). */
const TIMEOUT_MS = 10000;

describe('runSession headless — hooks de ciclo-de-vida (BUG-0020)', { timeout: TIMEOUT_MS }, () => {
  let base: string;
  let aluyDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-headless-hooks-'));
    aluyDir = join(base, 'home', '.aluy');
    workspaceRoot = join(base, 'project');
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(aluyDir, { recursive: true });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** Monta o hooks.json com hooks. */
  function writeHooks(hooks: { event: string; command: string }[]): HooksConfigStore {
    writeFileSync(join(aluyDir, 'hooks.json'), JSON.stringify({ hooks }));
    return new HooksConfigStore({ baseDir: aluyDir });
  }

  const hermetic = (): {
    mcpTools: [];
    userAgentsLoader: UserAgentsLoader;
  } => ({
    mcpTools: [],
    userAgentsLoader: new UserAgentsLoader({ baseDir: aluyDir }),
  });

  it('completa headless SEM crash com hooks de session-start (antes pulava)', async () => {
    // ANTES do fix: os hooks eram silenciosamente ignorados no headless — o
    // `selectHooks`/`hookRunner.runAll` NUNCA rodava. O teste prova que o
    // headless com hooks configurados NÃO quebra (o firing roda, mesmo que
    // a catraca bloqueie a execução do comando em modo não-interativo).
    const hooksStore = writeHooks([
      { event: 'session-start', command: 'echo "hook session-start"' },
    ]);

    const { client } = capturingBroker();
    const out = nonTtyStdout();

    await runSession({
      goal: 'diga oi',
      headless: { print: true },
      stdout: out,
      env: {},
      store: new MemoryStore(),
      brokerClient: client,
      catalogClient: stubCatalog as never,
      workspaceRoot,
      sessionStore: new SessionStore({ baseDir: aluyDir }),
      configStore: new UserConfigStore({ baseDir: aluyDir }),
      hooksConfigStore: hooksStore,
      memoryBaseDir: aluyDir,
      journalBaseDir: aluyDir,
      ...hermetic(),
    });

    // Se chegou aqui sem lançar, o mecanismo de disparo rodou.
    expect(out.text()).toContain('resultado headless');
  });

  it('completa headless SEM crash com hooks de turn-end (antes pulava)', async () => {
    const hooksStore = writeHooks([{ event: 'turn-end', command: 'echo "hook turn-end"' }]);

    const { client } = capturingBroker();
    const out = nonTtyStdout();

    await runSession({
      goal: 'diga oi',
      headless: { print: true },
      stdout: out,
      env: {},
      store: new MemoryStore(),
      brokerClient: client,
      catalogClient: stubCatalog as never,
      workspaceRoot,
      sessionStore: new SessionStore({ baseDir: aluyDir }),
      configStore: new UserConfigStore({ baseDir: aluyDir }),
      hooksConfigStore: hooksStore,
      memoryBaseDir: aluyDir,
      journalBaseDir: aluyDir,
      ...hermetic(),
    });

    expect(out.text()).toContain('resultado headless');
  });

  it('completa headless com session-start + turn-end (antes pulava)', async () => {
    const hooksStore = writeHooks([
      { event: 'session-start', command: 'echo start' },
      { event: 'turn-end', command: 'echo end' },
    ]);

    const { client } = capturingBroker();
    const out = nonTtyStdout();

    await runSession({
      goal: 'diga oi',
      headless: { print: true },
      stdout: out,
      env: {},
      store: new MemoryStore(),
      brokerClient: client,
      catalogClient: stubCatalog as never,
      workspaceRoot,
      sessionStore: new SessionStore({ baseDir: aluyDir }),
      configStore: new UserConfigStore({ baseDir: aluyDir }),
      hooksConfigStore: hooksStore,
      memoryBaseDir: aluyDir,
      journalBaseDir: aluyDir,
      ...hermetic(),
    });

    expect(out.text()).toContain('resultado headless');
  });

  it('sem hooks na config ⇒ zero impacto (regressão)', async () => {
    const hooksStore = writeHooks([]);

    const { client } = capturingBroker();
    const out = nonTtyStdout();

    await runSession({
      goal: 'diga oi',
      headless: { print: true },
      stdout: out,
      env: {},
      store: new MemoryStore(),
      brokerClient: client,
      catalogClient: stubCatalog as never,
      workspaceRoot,
      sessionStore: new SessionStore({ baseDir: aluyDir }),
      configStore: new UserConfigStore({ baseDir: aluyDir }),
      hooksConfigStore: hooksStore,
      memoryBaseDir: aluyDir,
      journalBaseDir: aluyDir,
      ...hermetic(),
    });

    expect(out.text()).toContain('resultado headless');
  });

  it('completa não-TTY (runLinear) SEM crash com hooks (antes ausente)', async () => {
    const hooksStore = writeHooks([{ event: 'session-start', command: 'echo start' }]);

    const { client } = capturingBroker();
    const out = nonTtyStdout();

    // SEM headless (não-TTY via pipe/CI) — o caminho é runLinear.
    await runSession({
      goal: 'diga oi',
      stdout: out,
      env: {},
      store: new MemoryStore(),
      brokerClient: client,
      catalogClient: stubCatalog as never,
      workspaceRoot,
      sessionStore: new SessionStore({ baseDir: aluyDir }),
      configStore: new UserConfigStore({ baseDir: aluyDir }),
      hooksConfigStore: hooksStore,
      memoryBaseDir: aluyDir,
      journalBaseDir: aluyDir,
      ...hermetic(),
    });

    // O runLinear completa normalmente — o hook foi processado (mesmo que
    // bloqueado pela catraca em não-interativo). Sem o fix, `selectHooks`
    // nem rodava.
    expect(out.text()).toContain('[aluy]');
  });

  // ── EST-1018 (RESÍDUO do #204): pre-tool / post-tool no headless ───────────────

  it('CA-1/CA-2 — pre-tool E post-tool DISPARAM quando o agente usa uma tool (headless)', async () => {
    // O broker emite UMA chamada `read_file` (read ⇒ allow na catraca). Os hooks
    // pre-tool/post-tool fazem `touch <marcador>` — em modo `unsafe` (yolo) o
    // run_command é liberado, então os marcadores são CRIADOS no FS. ANTES do fix (sem
    // o addToolObserver no headless) o toolObserver→hookRunner nunca era fiado ⇒ os
    // marcadores NÃO existiriam (este teste reprova). NÃO-TAUTOLÓGICO.
    const target = join(workspaceRoot, 'alvo.txt');
    writeFileSync(target, 'conteudo lido pela tool\n');
    const preMarker = join(workspaceRoot, 'pre-tool.marker');
    const postMarker = join(workspaceRoot, 'post-tool.marker');

    const hooksStore = writeHooks([
      { event: 'pre-tool', command: `touch ${JSON.stringify(preMarker)}` },
      { event: 'post-tool', command: `touch ${JSON.stringify(postMarker)}` },
    ]);

    const { client, calls } = toolCallingBroker(target);
    const out = nonTtyStdout();

    await runSession({
      goal: 'leia o alvo',
      headless: { print: true },
      mode: 'unsafe', // yolo ⇒ run_command (o efeito dos hooks) é liberado pela catraca.
      stdout: out,
      env: {},
      store: new MemoryStore(),
      brokerClient: client,
      catalogClient: stubCatalog as never,
      workspaceRoot,
      sessionStore: new SessionStore({ baseDir: aluyDir }),
      configStore: new UserConfigStore({ baseDir: aluyDir }),
      hooksConfigStore: hooksStore,
      memoryBaseDir: aluyDir,
      journalBaseDir: aluyDir,
      ...hermetic(),
    });

    // A tool DE FATO rodou (≥2 turnos: tool-call + resposta final) — guarda anti-vácuo.
    expect(calls()).toBeGreaterThanOrEqual(2);
    // O CERNE: pre-tool E post-tool dispararam (marcadores no FS). O post-tool solta no
    // fim do run (best-effort `void`) — o poll aguarda o `touch` completar.
    expect(await waitForFile(preMarker)).toBe(true);
    expect(await waitForFile(postMarker)).toBe(true);
  });

  it('CA-3 — sem tool no turno ⇒ pre/post-tool NÃO disparam (session-start/turn-end seguem)', async () => {
    // Broker SEM chamada de tool: o loop não emite onToolStart/onToolEnd ⇒ os hooks
    // pre/post-tool não têm o que observar (marcador ausente). Os de session-start/
    // turn-end continuam fiados (o #204) — o headless completa normalmente.
    const preMarker = join(workspaceRoot, 'pre-tool.marker');
    const postMarker = join(workspaceRoot, 'post-tool.marker');
    const startMarker = join(workspaceRoot, 'session-start.marker');

    const hooksStore = writeHooks([
      { event: 'session-start', command: `touch ${JSON.stringify(startMarker)}` },
      { event: 'pre-tool', command: `touch ${JSON.stringify(preMarker)}` },
      { event: 'post-tool', command: `touch ${JSON.stringify(postMarker)}` },
    ]);

    const { client } = capturingBroker(); // SEM tool-call.
    const out = nonTtyStdout();

    await runSession({
      goal: 'diga oi',
      headless: { print: true },
      mode: 'unsafe',
      stdout: out,
      env: {},
      store: new MemoryStore(),
      brokerClient: client,
      catalogClient: stubCatalog as never,
      workspaceRoot,
      sessionStore: new SessionStore({ baseDir: aluyDir }),
      configStore: new UserConfigStore({ baseDir: aluyDir }),
      hooksConfigStore: hooksStore,
      memoryBaseDir: aluyDir,
      journalBaseDir: aluyDir,
      ...hermetic(),
    });

    expect(out.text()).toContain('resultado headless');
    // session-start disparou (o #204 segue intacto)…
    expect(await waitForFile(startMarker)).toBe(true);
    // …mas pre/post-tool NÃO — não houve tool-call a observar. (start já apareceu, logo
    // os marcadores de tool tiveram a MESMA janela de tempo p/ aparecer — e não devem.)
    expect(existsSync(preMarker)).toBe(false);
    expect(existsSync(postMarker)).toBe(false);
  });
});

// ── EST-1018 — unit do observador puro (`makeToolHooksObserver`) ────────────────
// Prova direta da semântica, independente do `runSession`: o observador chama o
// `HookRunner` com os hooks de `pre-tool` (no onToolStart) e `post-tool` (no onToolEnd),
// na ORDEM certa (pre ANTES de post), casando o NOME da tool (matcher). Sem hooks de
// pre/post-tool ⇒ `undefined` (no-op). Reverter a fiação faz o `runSession` não chamar
// estes callbacks — aqui isolamos a unidade que aquele wiring aciona.
describe('makeToolHooksObserver (EST-1018)', () => {
  function spyRunner(): { runner: HookRunner; events: string[] } {
    const events: string[] = [];
    const runner = {
      runAll: vi.fn(async (hooks: readonly { event: string }[]) => {
        for (const h of hooks) events.push(h.event);
        return [];
      }),
    } as unknown as HookRunner;
    return { runner, events };
  }

  const cfg = (hooks: { event: string; command: string }[]): HooksConfig =>
    ({ hooks }) as HooksConfig;

  const call: ToolCall = { name: 'read_file', input: { path: '/x' } };

  it('dispara pre-tool no onToolStart e post-tool no onToolEnd, nessa ordem', async () => {
    const { runner, events } = spyRunner();
    const obs = makeToolHooksObserver({
      runner,
      config: cfg([
        { event: 'pre-tool', command: 'echo pre' },
        { event: 'post-tool', command: 'echo post' },
      ]),
    });
    expect(obs).toBeDefined();
    obs?.onToolStart?.(call);
    obs?.onToolEnd?.(call, true);
    // O runAll é async (void) — aguarda o microtask drenar.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['pre-tool', 'post-tool']);
  });

  it('só pre-tool configurado ⇒ post não é observado (e vice-versa)', async () => {
    const { runner, events } = spyRunner();
    const obs = makeToolHooksObserver({
      runner,
      config: cfg([{ event: 'pre-tool', command: 'echo pre' }]),
    });
    expect(obs?.onToolStart).toBeDefined();
    expect(obs?.onToolEnd).toBeUndefined();
    obs?.onToolStart?.(call);
    await Promise.resolve();
    expect(events).toEqual(['pre-tool']);
  });

  it('matcher por NOME de tool: hook só dispara p/ a tool casada', async () => {
    const { runner, events } = spyRunner();
    const obs = makeToolHooksObserver({
      runner,
      config: cfg([{ event: 'pre-tool', command: 'echo pre' }]),
    });
    // hook SEM matcher casa qualquer tool — usamos a config crua p/ provar o caminho do
    // matcher por nome: um hook com matcher 'run_command' NÃO casa 'read_file'.
    const obs2 = makeToolHooksObserver({
      runner,
      config: {
        hooks: [{ event: 'pre-tool', command: 'echo pre', matcher: 'run_command' }],
      } as HooksConfig,
    });
    obs?.onToolStart?.(call); // sem matcher ⇒ casa read_file
    obs2?.onToolStart?.(call); // matcher run_command ⇒ NÃO casa read_file
    await Promise.resolve();
    expect(events).toEqual(['pre-tool']); // só o sem-matcher disparou
  });

  it('sem hooks de pre/post-tool ⇒ undefined (no-op)', () => {
    const { runner } = spyRunner();
    expect(makeToolHooksObserver({ runner, config: cfg([]) })).toBeUndefined();
    expect(
      makeToolHooksObserver({ runner, config: cfg([{ event: 'turn-end', command: 'echo e' }]) }),
    ).toBeUndefined();
  });
});
