// BUG A + BUG B (achado do dono — fila/ESC durante o TURNO DO MODELO VIVO).
//
// REGRA DE OURO: o caminho que importa é o TURNO DO MODELO em andamento (thinking/
// streaming/asking-dentro-do-turno), NÃO `!bang`. Aqui o `ModelCaller` FAKE devolve uma
// Promise que o teste RESOLVE manualmente (gate) — segurando um turno root VIVO de
// verdade. O `App` é dirigido pelo `ink-testing-library` (mecânica do type-ahead.test).
//
//   • BUG A: com um turno VIVO, TEXTO PURO + Enter NÃO pode sumir — encaixa via
//     injectInput('root') (fila VIVA) OU enfileira; nunca é descartado em silêncio.
//   • BUG B: com uma msg JÁ na fila E um ask ATIVO (DENTRO do turno vivo), o ESC (mesmo
//     double) NÃO pode limpar a fila + abortar tudo. Deve cancelar SÓ o ask.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  SPAWN_AGENT_TOOL_NAME,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const CR = '\r';
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => (s ?? '').replace(ANSI, '');

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return [];
    },
  };
  return { fs, shell, search };
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Caller FAKE que segura um turno VIVO. Cada chamada do modelo é uma ITERAÇÃO do MESMO
 * turno (`submit` único): a fase fica thinking/streaming o tempo todo (nunca idle entre
 * iterações). `iters` define o conteúdo por iteração; `gates[i]` (se houver) PENDURA
 * ANTES de devolver a iteração i — o teste libera quando quiser.
 */
function buildSession(opts: {
  iters: (turn: number) => string;
  gates?: (turn: number) => Promise<void> | undefined;
  subAgents?: boolean;
}) {
  let controllerRef: SessionController | null = null;
  let turn = 0;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      const sink = controllerRef!.sink;
      sink.onStart?.();
      const t = turn++;
      const g = opts.gates?.(t);
      if (g) await g;
      return { request_id: 'r', content: opts.iters(t), finish_reason: 'stop' };
    },
  };
  const controller = new SessionController({
    model,
    // Default (ask): run_command pede aprovação ⇒ o ask abre DENTRO do turno vivo.
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
    ...(opts.subAgents
      ? { subAgents: { enabled: true, maxConcurrency: 2, timeoutMs: 60_000 } }
      : {}),
  });
  controllerRef = controller;
  controller.dismissBoot();

  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  return { controller, ...r };
}

/**
 * Caller FAKE p/ o cenário de FAN-OUT: o pai delega 2 filhos (a, b) e PENDURA no
 * `await port.spawn` enquanto os filhos esperam os gates. Replica o harness de
 * controller-fanout-inject.test.ts — mas dirige a `App` real.
 */
function buildFanoutSession() {
  const gates = new Map<string, { p: Promise<void>; release: () => void }>();
  for (const label of ['a', 'b']) {
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    gates.set(label, { p, release });
  }
  let controllerRef: SessionController | null = null;
  let parent: string | null = null;
  let parentCalls = 0;
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const sessionId = key.slice(0, key.lastIndexOf(':'));
      if (parent === null) parent = sessionId;
      if (sessionId === parent) {
        controllerRef!.sink.onStart?.();
        parentCalls += 1;
        if (parentCalls === 1) {
          return {
            request_id: 'r',
            content: toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [
                { label: 'a', goal: 'g-a' },
                { label: 'b', goal: 'g-b' },
              ],
            }),
            finish_reason: 'stop',
            usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
          };
        }
        return { request_id: 'r', content: 'ok.', finish_reason: 'stop' };
      }
      // FILHO: pendura no gate próprio até o teste liberar.
      const text = args.messages.map((m) => m.content).join('\n');
      const label = text.includes('g-a') ? 'a' : 'b';
      await gates.get(label)!.p;
      return { request_id: 'r', content: `relatório-${label}.`, finish_reason: 'stop' };
    },
  };
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
    subAgents: { enabled: true, maxConcurrency: 2, timeoutMs: 60_000 },
  });
  controllerRef = controller;
  controller.dismissBoot();

  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  return { controller, release: (l: 'a' | 'b') => gates.get(l)!.release(), ...r };
}

describe('BUG A — texto puro + Enter durante o TURNO VIVO não some', () => {
  it('TEXTO PURO digitado durante streaming é encaixado (injectInput) ou enfileirado — nunca descartado', async () => {
    const g0 = defer();
    const s = buildSession({
      iters: () => 'trabalhando…',
      gates: (t) => (t === 0 ? g0.promise : undefined),
    });
    const injectSpy = vi.spyOn(s.controller, 'injectInput');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('como está o build?'),
      () => plain(s.lastFrame()).includes('como está o build?'),
    );
    await pressUntil(
      () => s.stdin.write(CR),
      () =>
        injectSpy.mock.calls.some((c) => c[0] === 'root' && c[1] === 'como está o build?') ||
        plain(s.lastFrame()).includes('na fila'),
    );

    const encaixou = injectSpy.mock.calls.some(
      (c) => c[0] === 'root' && c[1] === 'como está o build?',
    );
    const naFila = plain(s.lastFrame()).includes('na fila');
    expect(encaixou || naFila).toBe(true);

    g0.resolve();
    injectSpy.mockRestore();
    s.unmount();
  });
});

describe('BUG A (fan-out) — texto puro durante sub-agentes vivos NÃO some da UI', () => {
  it('injetar texto puro com o fan-out VIVO: a mensagem PERMANECE visível (encaixando…/fila), não desaparece', async () => {
    const s = buildFanoutSession();

    void s.controller.submit('delegue a e b');
    // Espera os 2 sub-agentes ficarem VIVOS (o pai BLOQUEIA no fan-out).
    await waitFor(
      () => s.controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2,
    );

    // O dono digita TEXTO PURO + Enter durante o fan-out (o pai está bloqueado nos filhos).
    await pressUntil(
      () => s.stdin.write('como está o progresso?'),
      () => plain(s.lastFrame()).includes('como está o progresso?'),
    );
    s.stdin.write(CR);

    // A mensagem foi aceita (encaixou via injectInput → "encaixando…"). Espera aparecer.
    await waitFor(() => {
      const f = plain(s.lastFrame());
      return (
        f.includes('encaixando') || f.includes('na fila') || s.controller.current.pendingInjects.length > 0
      );
    });

    // ── Agora espera o PUMP do fan-out rodar (FANOUT_INJECT_DRAIN_MS=150ms): ele move
    //    liveInjected → pendingInjected E ZERA os ecos ⇒ o indicador "encaixando…" some.
    //    A mensagem fica INVISÍVEL (não há "na fila", não há "encaixando…") embora
    //    preservada em pendingInjected — é o "minha msg sumiu" do dono. ──
    await new Promise((r) => setTimeout(r, 400));

    const frame = plain(s.lastFrame());

    // DECISÃO DO DONO: a mensagem NÃO pode sumir — deve seguir VISÍVEL (encaixando…/fila)
    // até ser de fato processada. O bug: o pump zera o indicador e ela some da tela.
    const aindaVisivel =
      frame.includes('encaixando') ||
      frame.includes('na fila') ||
      s.controller.current.pendingInjects.length > 0;
    expect(aindaVisivel).toBe(true);

    s.release('a');
    s.release('b');
    s.unmount();
  });
});

describe('BUG B — ESC sob ask com fila pendente NÃO limpa a fila + aborta', () => {
  it('double-ESC sob o ask com `!bang` na fila: a fila SOBREVIVE e o turno NÃO é abortado', async () => {
    const g0 = defer();
    const s = buildSession({
      // iter 0: read_file (allow, SEM ask) + gate ⇒ o turno fica VIVO e multi-iteração
      //   (NÃO finaliza), dando janela p/ enfileirar o bang sem o turno cair em repouso.
      // iter 1: run_command destrutivo ⇒ a catraca abre o ask DENTRO do MESMO turno vivo,
      //   com a fila ainda cheia. iter 2+: encerra.
      iters: (t) =>
        t === 0
          ? toolCall('read_file', { path: 'x' })
          : t === 1
            ? toolCall('run_command', { command: 'rm -rf build' })
            : 'pronto.',
      gates: (t) => (t === 0 ? g0.promise : undefined),
    });
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');
    // Mocka o runBang p/ apenas REGISTRAR a chamada (sem abrir o ask do próprio bang,
    // que penduraria o teste) — o que importa é provar que a fila NÃO foi descartada.
    const bangSpy = vi.spyOn(s.controller, 'runBang').mockResolvedValue();

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    // ── Enfileira um `!bang` (AÇÃO ⇒ FICA na fila; não encaixa como texto). ──
    await pressUntil(
      () => s.stdin.write('!echo segundo'),
      () => plain(s.lastFrame()).includes('!echo segundo'),
    );
    await pressUntil(
      () => s.stdin.write(CR),
      () => plain(s.lastFrame()).includes('na fila'),
    );
    expect(plain(s.lastFrame())).toContain('na fila');

    // ── Libera a iter 0 ⇒ a iter 1 dispara o run_command ⇒ o ask abre (turno VIVO,
    //    fila ainda com o `!echo segundo`). ──
    g0.resolve();
    await waitFor(() => s.controller.current.phase === 'asking');
    // a fila NÃO foi drenada (bang espera o repouso) — ainda visível.
    expect(plain(s.lastFrame())).toContain('na fila');

    // ── double-ESC sob o ask: os DOIS ESC no MESMO tick (antes do deny do 1º propagar a
    //    fase p/ fora de `asking`), p/ ambos caírem no HANDLER DO ASK ⇒ dispara o ramo
    //    double-ESC (App.tsx 1953-1955) que faz interrupt()+clearQueue(). É o gesto que o
    //    dono diz NÃO poder abortar/limpar a fila. ──
    s.stdin.write(ESC);
    s.stdin.write(ESC);
    await new Promise((r) => setTimeout(r, 120));

    // DECISÃO DO DONO: ESC sob ask com fila pendente cancela SÓ o ask — NUNCA aborta o
    // turno NEM DESCARTA a fila. O bug (App.tsx ~1953-1955): o ramo double-ESC chamava
    //   controller.interrupt()  ⇒ ABORTA o trabalho (RED: interrupt=1)
    //   clearQueue()            ⇒ DESCARTA a fila (RED: o `!echo segundo` SUMIA — runBang
    //                              jamais chamado, fila perdida)
    // Com o fix: a fila SOBREVIVE e o `!echo segundo` é DE FATO PROCESSADO (runBang
    // chamado) quando o turno repousa — sem abort, sem descarte.
    expect(interruptSpy).not.toHaveBeenCalled(); // (1) o trabalho NÃO foi abortado
    await waitFor(() => bangSpy.mock.calls.some((c) => c[0] === 'echo segundo'));
    expect(bangSpy.mock.calls.some((c) => c[0] === 'echo segundo')).toBe(true); // (2) a fila NÃO foi descartada — processou

    bangSpy.mockRestore();
    interruptSpy.mockRestore();
    s.unmount();
  });

  it('ESC sob ask + ESC logo depois (timing real do tmux: 1º nega o ask, 2º cai no handler PRINCIPAL): a fila SOBREVIVE', async () => {
    // CASO QUE O TMUX PEGOU — os dois ESC NÃO no mesmo tick: o 1º ESC NEGA o ask (a fase
    // sai de `asking`); o 2º ESC, ~100ms depois, cai no HANDLER PRINCIPAL. Como `lastEscRef`
    // é COMPARTILHADO, o 2º ESC era lido como "double-ESC" (<500ms) ⇒ interrupt()+clearQueue()
    // no handler principal (App.tsx ~2300) — ABORTAVA + LIMPAVA a fila mesmo o dono tendo só
    // negado o ask. Fix: negar o ask COM fila reseta o relógio ⇒ o 2º ESC é single-ESC (preserva).
    const g0 = defer();
    const g2 = defer();
    const s = buildSession({
      iters: (t) =>
        t === 0
          ? toolCall('read_file', { path: 'x' })
          : t === 1
            ? toolCall('run_command', { command: 'rm -rf build' })
            : 'pronto.',
      // iter 2 GATEADA: após negar o ask, o turno SEGUE VIVO (streaming) — espelha o
      // tmux (a fila NÃO drena na hora). Assim o 2º ESC cai no handler PRINCIPAL com o
      // turno VIVO e a fila AINDA presente — a condição exata do vazamento entre handlers.
      gates: (t) => (t === 0 ? g0.promise : t === 2 ? g2.promise : undefined),
    });
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');
    const bangSpy = vi.spyOn(s.controller, 'runBang').mockResolvedValue();

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('!echo segundo'),
      () => plain(s.lastFrame()).includes('!echo segundo'),
    );
    await pressUntil(
      () => s.stdin.write(CR),
      () => plain(s.lastFrame()).includes('na fila'),
    );

    g0.resolve();
    await waitFor(() => s.controller.current.phase === 'asking');
    expect(plain(s.lastFrame())).toContain('na fila');

    // 1º ESC: nega o ask. Espera a fase SAIR de `asking` (o deny propagou; o turno SEGUE
    // VIVO em streaming pela iter 2 gateada) ANTES do 2º ESC, p/ o 2º cair no handler
    // PRINCIPAL — exatamente o timing do tmux.
    s.stdin.write(ESC);
    await waitFor(() => s.controller.current.phase === 'streaming');
    // 2º ESC ~100ms depois (dentro da janela de 500ms do double-ESC) — NO HANDLER PRINCIPAL,
    // turno VIVO, fila presente. SEM o fix: `lastEscRef` compartilhado ⇒ lido como double-ESC
    // ⇒ interrupt()+clearQueue() (App.tsx ~2300) ⇒ ABORTA + LIMPA a fila.
    await new Promise((r) => setTimeout(r, 100));
    expect(plain(s.lastFrame())).toContain('na fila'); // a fila ainda está lá antes do 2º ESC
    s.stdin.write(ESC);
    await new Promise((r) => setTimeout(r, 120));

    // O 2º ESC NÃO pode ser lido como hard-stop: o turno NÃO aborta e a fila SOBREVIVE.
    expect(interruptSpy).not.toHaveBeenCalled();
    expect(plain(s.lastFrame())).toContain('na fila'); // a fila NÃO foi descartada

    // Libera a iter 2 ⇒ o turno repousa ⇒ a fila drena ⇒ o `!echo segundo` PROCESSA.
    g2.resolve();
    await waitFor(() => bangSpy.mock.calls.some((c) => c[0] === 'echo segundo'));
    expect(bangSpy.mock.calls.some((c) => c[0] === 'echo segundo')).toBe(true);

    bangSpy.mockRestore();
    interruptSpy.mockRestore();
    s.unmount();
  });
});
