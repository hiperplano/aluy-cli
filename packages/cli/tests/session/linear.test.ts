// EST-0948 · DoD a11y — modo NÃO-TTY linear: a saída é TEXTO PLANO sem ANSI.
//
// Prova de comportamento do caminho não-interativo (`aluy "objetivo"` piped/CI):
// `runLinear` subscreve o controller, roda o loop e imprime cada bloco numa linha
// rotulada — sem box, sem códigos de escape ANSI. Cobre os eventos principais
// (you/aluy-delta/tool/deny/broker-error) e o caminho "sem objetivo".
//
// Usamos um controller-fake que só implementa o contrato que `runLinear` toca
// (`subscribe` + `submit`), emitindo uma sequência de estados — assim o teste é
// da serialização linear, não do loop real (já coberto pelo controller.test.ts).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import {
  runLinear,
  linearize,
  runHeadlessPrint,
  type LinearOut,
} from '../../src/session/linear.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';
import type { SessionBlock, SessionState } from '../../src/session/model.js';

/** Detecta QUALQUER sequência de escape ANSI (CSI / OSC) — prova "sem ANSI". */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*[A-Za-z]|\][^]*/;

function makeState(blocks: readonly SessionBlock[], phase: SessionState['phase']): SessionState {
  return {
    blocks,
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    phase,
  };
}

/** Coletor de saída — guarda o que foi escrito p/ asserção. */
function makeOut(): { out: LinearOut; written: string[]; text(): string } {
  const written: string[] = [];
  return {
    out: { write: (c) => void written.push(c) },
    written,
    text: () => written.join(''),
  };
}

/**
 * Controller-fake: ao `submit`, dispara uma SEQUÊNCIA de snapshots de estado
 * (incremental, como o controller real publica). `runLinear` imprime cada bloco
 * novo. Só implementa `subscribe`/`submit` (o que `runLinear` usa).
 */
function fakeController(steps: readonly (readonly SessionBlock[])[]): SessionController {
  let observer: ((s: SessionState) => void) | null = null;
  const ctrl = {
    subscribe(obs: (s: SessionState) => void): () => void {
      observer = obs;
      obs(makeState([], 'idle')); // snapshot inicial (igual ao real)
      return () => {
        observer = null;
      };
    },
    async submit(): Promise<void> {
      for (let i = 0; i < steps.length; i++) {
        const phase = i === steps.length - 1 ? 'done' : 'streaming';
        observer?.(makeState(steps[i]!, phase));
      }
    },
  };
  return ctrl as unknown as SessionController;
}

describe('linearize — serializa cada bloco em texto plano rotulado (sem ANSI)', () => {
  const cases: { block: SessionBlock; expects: string }[] = [
    { block: { kind: 'you', text: 'explique o repo' }, expects: '[você] explique o repo' },
    {
      block: { kind: 'aluy', text: 'é um monorepo.', streaming: false },
      expects: '[aluy] é um monorepo.',
    },
    {
      block: { kind: 'tool', verb: 'read', target: 'README.md', result: '48 linhas', status: 'ok' },
      expects: '[tool] read README.md — 48 linhas ok',
    },
    {
      block: { kind: 'tool', verb: 'bash', target: '$ ls', result: 'falhou', status: 'err' },
      expects: '[tool] bash $ ls — falhou erro',
    },
    {
      block: { kind: 'deny', verb: 'bash', exact: '$ rm -rf /' },
      expects: '[negado] bash $ rm -rf /',
    },
    // EST-0958 — bloco `bang` (`!comando`) no não-TTY: linha `[shell]` rotulada.
    {
      block: { kind: 'bang', command: 'git status', status: 'ok', output: 'limpo' },
      expects: '[shell] $ git status — ok\nlimpo',
    },
    {
      block: { kind: 'bang', command: 'rm -rf build', status: 'blocked', output: 'negado' },
      expects: '[shell] $ rm -rf build — bloqueado\nnegado',
    },
    {
      block: { kind: 'broker-error', message: 'broker fora', status: 502 },
      expects: '[erro de broker] broker fora (502)',
    },
  ];

  for (const { block, expects } of cases) {
    it(`${block.kind} ⇒ "${expects}"`, () => {
      const line = linearize(block);
      expect(line).toBe(expects);
      expect(ANSI.test(line)).toBe(false);
    });
  }

  it('turno aluy vazio ⇒ linha vazia (não imprime rótulo)', () => {
    expect(linearize({ kind: 'aluy', text: '   ', streaming: false })).toBe('');
  });
});

describe('runLinear — modo não-TTY: saída linear sem ANSI, cobre os eventos', () => {
  it('imprime os blocos NOVOS a cada snapshot, em texto plano sem ANSI', async () => {
    const { out, text } = makeOut();
    const controller = fakeController([
      [{ kind: 'you', text: 'liste e leia' }],
      [
        { kind: 'you', text: 'liste e leia' },
        { kind: 'tool', verb: 'read', target: 'a.ts', result: '10 linhas', status: 'ok' },
      ],
      [
        { kind: 'you', text: 'liste e leia' },
        { kind: 'tool', verb: 'read', target: 'a.ts', result: '10 linhas', status: 'ok' },
        { kind: 'aluy', text: 'pronto.', streaming: false },
      ],
    ]);

    await runLinear(controller, 'liste e leia', out);

    const full = text();
    // texto linear esperado, cada bloco numa linha rotulada
    expect(full).toContain('[você] liste e leia\n');
    expect(full).toContain('[tool] read a.ts — 10 linhas ok\n');
    expect(full).toContain('[aluy] pronto.\n');
    // a11y/DoD: NENHUM código de escape ANSI na saída inteira
    expect(ANSI.test(full)).toBe(false);
    // cada bloco impresso UMA vez (sem reimprimir os anteriores a cada snapshot)
    expect(full.match(/\[você\] liste e leia/g)).toHaveLength(1);
  });

  it('EST-0987 — RESPIRO entre turnos: traço curto ANTES de cada [você] (menos o 1º)', async () => {
    const { out, text } = makeOut();
    // Histórico com DOIS turnos (dois `[você]`): o separador sutil aparece ANTES do
    // 2º `[você]`, nunca antes do 1º. Texto puro (sem ANSI) — equivalente linear da
    // divisória sutil da TUI.
    const controller = fakeController([
      [
        { kind: 'you', text: 'primeiro' },
        { kind: 'aluy', text: 'resposta um.', streaming: false },
        { kind: 'you', text: 'segundo' },
        { kind: 'aluy', text: 'resposta dois.', streaming: false },
      ],
    ]);

    await runLinear(controller, 'primeiro', out);

    const full = text();
    expect(full).toContain('[você] primeiro\n');
    expect(full).toContain('[você] segundo\n');
    // o separador aparece UMA vez (entre os 2 turnos), e ANTES do 2º [você].
    const sep = '-'.repeat(12);
    expect(full.match(new RegExp(sep, 'g')) ?? []).toHaveLength(1);
    const idxSep = full.indexOf(sep);
    expect(idxSep).toBeGreaterThan(full.indexOf('[você] primeiro'));
    expect(idxSep).toBeLessThan(full.indexOf('[você] segundo'));
    // a saída NÃO começa com o separador (nada antes do 1º turno).
    expect(full.startsWith(sep)).toBe(false);
    expect(ANSI.test(full)).toBe(false);
  });

  it('cobre ask negado (deny por fail-safe não-TTY) e erro de broker', async () => {
    const { out, text } = makeOut();
    const controller = fakeController([
      [
        { kind: 'you', text: 'rode algo perigoso' },
        { kind: 'deny', verb: 'bash', exact: '$ rm -rf node_modules' },
        { kind: 'broker-error', message: 'broker fora' },
      ],
    ]);

    await runLinear(controller, 'rode algo perigoso', out);

    const full = text();
    expect(full).toContain('[negado] bash $ rm -rf node_modules\n');
    expect(full).toContain('[erro de broker] broker fora\n');
    expect(ANSI.test(full)).toBe(false);
  });

  it('sem objetivo ⇒ orienta o uso e NÃO submete', async () => {
    const { out, text } = makeOut();
    let submitted = false;
    const controller = {
      subscribe() {
        return () => {};
      },
      async submit() {
        submitted = true;
      },
    } as unknown as SessionController;

    await runLinear(controller, '   ', out);

    expect(submitted).toBe(false);
    expect(text()).toContain('sem objetivo e sem TTY');
    expect(ANSI.test(text())).toBe(false);
  });
});

// ── FLUXO REAL (regressão do E2E não-TTY): o bug não era de FORMATO, era de
// SUBSCRIÇÃO. O bloco `aluy` é empurrado VAZIO no onStart e MUTADO IN-PLACE a
// cada delta até onDone — imprimir "o que é novo por índice" pegava o bloco vazio
// e nunca via os deltas. Estes testes rodam o `runLinear` contra um SessionController
// REAL (não o fake síncrono) com um caller que emite start→delta→delta→done de
// forma ASSÍNCRONA (Promise tick entre deltas), e capturam o stdout DE VERDADE
// pra provar que a fala do modelo ("pong") sai no não-TTY. ─────────────────────

/** Portas em memória (nada de fs/child_process real). */
function memPorts(files: Record<string, string> = {}): ToolPorts {
  const fs: FileSystemPort = {
    async readFile(p) {
      if (p in files) return files[p]!;
      throw new Error(`não existe: ${p}`);
    },
    async writeFile() {},
    async exists(p) {
      return p in files;
    },
  };
  const shell: ShellPort = {
    async exec(command) {
      return { stdout: `ran: ${command}`, stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

/**
 * Caller de STREAMING scriptado: emite cada resposta caractere-a-caractere no
 * sink, com um `await Promise.resolve()` ANTES de cada delta — reproduz a chegada
 * ASSÍNCRONA dos tokens (o ponto exato onde o subscribe-por-índice falhava).
 */
function streamingCaller(responses: readonly string[], sink: StreamSink): ModelCaller {
  let turn = 0;
  return {
    async call(): Promise<ModelCallResult> {
      const content = responses[Math.min(turn, responses.length - 1)] ?? '';
      turn += 1;
      sink.onStart?.();
      for (const ch of content) {
        await Promise.resolve(); // tick: o delta chega DEPOIS do snapshot do onStart
        sink.onDelta(ch);
      }
      sink.onUsage?.({ request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 });
      sink.onDone?.();
      return { request_id: 'r', content, finish_reason: 'stop' };
    },
  };
}

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

/** Controller REAL fiado com o caller scriptado (circularidade via sink-proxy). */
function realController(
  responses: readonly string[],
  files: Record<string, string> = {},
): SessionController {
  let ctrlRef: SessionController | null = null;
  const sink: StreamSink = {
    onStart: () => ctrlRef?.sink.onStart?.(),
    onDelta: (c) => ctrlRef?.sink.onDelta(c),
    onUsage: (u) => ctrlRef?.sink.onUsage?.(u),
    onDone: () => ctrlRef?.sink.onDone?.(),
  };
  const controller = new SessionController({
    model: streamingCaller(responses, sink),
    permission: new PolicyPermissionEngine(),
    ports: memPorts(files),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
  });
  ctrlRef = controller;
  return controller;
}

describe('runLinear — FLUXO REAL não-TTY: a fala STREAMADA do modelo SAI no stdout', () => {
  it('start→delta("po")→delta("ng")→done ⇒ "pong" aparece no stdout capturado', async () => {
    const { out, text } = makeOut();
    const controller = realController(['pong']);

    await runLinear(controller, 'diga pong', out);

    const full = text();
    // a captura do stdout REAL prova os deltas (não só o formato do linearize):
    expect(full).toContain('[você] diga pong\n');
    expect(full).toContain('[aluy] pong\n'); // ← a fala do modelo, montada dos deltas
    // sai UMA vez (não reimprime parcial a cada delta):
    expect(full.match(/\[aluy\] pong/g)).toHaveLength(1);
    // não vaza placeholder vazio nem ANSI:
    expect(full).not.toContain('[aluy] \n');
    expect(ANSI.test(full)).toBe(false);
  });

  it('multi-token livre vira UMA linha [aluy] com o texto completo', async () => {
    const { out, text } = makeOut();
    const controller = realController(['é um monorepo com dois pacotes.']);

    await runLinear(controller, 'explique', out);

    const full = text();
    expect(full).toContain('[aluy] é um monorepo com dois pacotes.\n');
    expect(full.match(/\[aluy\]/g)).toHaveLength(1);
  });

  it('tool-call: ESCONDE o bloco cru, mostra a prosa + a linha [tool] + a fala final', async () => {
    const { out, text } = makeOut();
    const controller = realController(
      [
        `Vou ler o arquivo agora.\n${toolCall('read_file', { path: 'README.md' })}`,
        'O arquivo tem 3 linhas. Pronto.',
      ],
      { 'README.md': 'l1\nl2\nl3\n' },
    );

    await runLinear(controller, 'leia o readme', out);

    const full = text();
    // #2 — o bloco CRU do protocolo NÃO vaza no stdout:
    expect(full).not.toContain('ALUY_TOOL_CALL');
    // a prosa legítima em volta do bloco É preservada:
    expect(full).toContain('[aluy] Vou ler o arquivo agora.\n');
    // a linha de tool aparece (a ação fica visível pela ⏺/[tool], não pelo JSON):
    expect(full).toContain('[tool] read README.md');
    // a fala FINAL do modelo (2º turno) sai:
    expect(full).toContain('Pronto.');
    expect(ANSI.test(full)).toBe(false);
  });
});

// ── EST-0947 — BUDGET HEADLESS: o StopReason do AgentRunResult é a fonte correta
// da parada por limite no headless (não o observer de pendingBudget). Este teste
// monta um controller REAL com maxIterations=1 e um modelo que devolve um tool-call
// (força 2ª iteração → budget gate para → stop.kind='limit'). Prova que
// `runHeadlessPrint` retorna `ok:false` com diagnóstico de budget. ───────────

describe('EST-0947 runHeadlessPrint — parada por budget exposta via lastRunResult.stop', () => {
  it('com maxIterations=1, devolve ok:false com diagnóstico de budget', async () => {
    // Mesma fiação do realController mas com teto de iterações em 1.
    // O modelo devolve um tool-call (read_file) p/ disparar outra iteração e o
    // budget gate PARAR antes da 2ª chamada ao broker.
    let ctrlRef: SessionController | null = null;
    const sink: StreamSink = {
      onStart: () => ctrlRef?.sink.onStart?.(),
      onDelta: (c) => ctrlRef?.sink.onDelta(c),
      onUsage: (u) => ctrlRef?.sink.onUsage?.(u),
      onDone: () => ctrlRef?.sink.onDone?.(),
    };
    const controller = new SessionController({
      model: streamingCaller(
        [`<thinking>Vou ler o README.\n${toolCall('read_file', { path: 'README.md' })}`],
        sink,
      ),
      permission: new PolicyPermissionEngine(),
      ports: memPorts({ 'README.md': 'conteúdo do readme' }),
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      limits: { maxIterations: 1, maxToolCalls: 10 },
    });
    ctrlRef = controller;

    // quiet:true p/ não emitir progresso no stderr (mantém o output dos testes limpo).
    const res = await runHeadlessPrint(controller, 'leia o readme', { quiet: true });

    expect(res.ok).toBe(false);
    expect(res.diagnostic).toBeDefined();
    expect(res.diagnostic!).toContain('parado por limite de budget');
    // O diagnostic contém o motivo vindo do BudgetGate.reasonFor('iterations').
    expect(res.diagnostic!).toMatch(/iterações|iterations/);
    expect(res.result).toBe('');
  });
});
