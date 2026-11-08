// ADR 0006 — Concierge na TUI.
//   • a resposta do Concierge é o bloco `┃ Λluy` NORMAL, em stream, token a token;
//   • a conversa NUNCA espera o trabalho (mensagem durante tarefa é respondida na hora);
//   • o trabalho das tarefas NUNCA entra na transcrição: vai ao painel do rodapé;
//   • a conclusão aparece UMA vez na conversa (linha dim), nunca duplicada;
//   • Esc não para tarefa; aprovação é caixa de entrada; espaçamento ≤ 1 linha em branco;
//   • sub-agentes (clássico) saem da conversa e moram no rodapé, com uma linha ao terminar;
//   • modo clássico inalterado.

import { parseFrases } from '../../src/session/frases-espera.js';
import { resolveText } from '../../src/i18n/translate.js';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ConciergeModel,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { ConciergeRuntime } from '../../src/session/concierge-runtime.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { taskDetailRoomFor, LIVE_OVERHEAD_ROWS } from '../../src/ui/components/ConciergeTasks.js';
import {
  aluyNeedsLeadingBlank,
  blankAfterInject,
  blockEndsWithBlankLine,
} from '../../src/session/block-rhythm.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const CR = '\r';
const DOWN = `${ESC}[B`;
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => (s ?? '').replace(ANSI, '');

const ports = (): ToolPorts => ({
  fs: { readFile: async () => '', writeFile: async () => {}, exists: async () => false },
  shell: { exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }) },
  search: { search: async () => [] },
});
const defer = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function type(s: { stdin: { write(x: string): void } }, text: string): Promise<void> {
  s.stdin.write(text);
  await sleep(40);
  s.stdin.write(CR);
}
const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
const toolCall = (name: string, input: Record<string, unknown>): string =>
  `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;

const mkController = (model: ModelCaller): SessionController => {
  const c = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: ports(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPort: 0 } as never,
    flush: { intervalMs: 0 },
  });
  c.dismissBoot();
  return c;
};

/** Uma sessão de TAREFA (headless): modelo com fases controladas por `iters`/`gates`. */
function taskSession(opts: {
  iters: (turn: number) => string;
  gates?: (turn: number) => Promise<void> | undefined;
}): SessionController {
  let ref: SessionController | null = null;
  let turn = 0;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      const sink = ref!.sink;
      sink.onStart?.();
      sink.onDelta?.('');
      const t = turn++;
      const content = opts.iters(t);
      // Como o caller real: a fala é transmitida pelo sink (tool-call em texto não é fala).
      if (!content.includes(TOOL_OPEN)) sink.onDelta?.(content);
      const g = opts.gates?.(t);
      if (g) await g;
      return { request_id: 'r', content, finish_reason: 'stop' };
    },
  };
  ref = mkController(model);
  return ref;
}

const text = (content: string, calls: ModelCallResult['tool_calls'] = []): ModelCallResult => ({
  request_id: 'c',
  content,
  finish_reason: 'stop',
  ...(calls.length ? { tool_calls: calls } : {}),
});

interface BuildOpts {
  mode: 'concierge' | 'classic';
  tasks?: SessionController[]; // sessões entregues às tarefas, em ordem (t1, t2…)
  concierge: (msg: string) => ModelCallResult;
  /** Pausa entre palavras do stream do Concierge (para observar o crescimento). */
  wordGate?: (i: number) => Promise<void> | undefined;
  classicModel?: ModelCaller;
  statusline?: 'full' | 'compact' | 'hidden';
  ownerBusy?: () => boolean;
  reportSettleMs?: number;
}

function build(opts: BuildOpts) {
  const conversation = mkController(
    opts.classicModel ?? {
      async call() {
        return { request_id: 'r', content: 'classic', finish_reason: 'stop' };
      },
    },
  );
  const conciergeCalls: string[] = [];
  const queue = [...(opts.tasks ?? [])];
  // O modelo do Concierge FAZ STREAM pelo sink do controller (como o StreamingModelCaller real).
  const cmodel: ConciergeModel = {
    call: async ({ messages }) => {
      const last = String(messages[messages.length - 1]!.content);
      const msg = /Mensagem do dono: (.*)$/s.exec(last)?.[1] ?? last;
      conciergeCalls.push(msg);
      const out = opts.concierge(msg);
      const sink = conversation.sink;
      sink.onStart?.();
      const words = out.content.split(/(?<= )/);
      for (let i = 0; i < words.length; i += 1) {
        sink.onDelta(words[i]!);
        const g = opts.wordGate?.(i);
        if (g) await g;
      }
      sink.onDone?.();
      return out;
    },
  };
  const rt = new ConciergeRuntime({
    sink: conversation,
    model: cmodel,
    createHeadless: () => queue.shift() ?? null,
    ...(opts.ownerBusy ? { ownerBusy: opts.ownerBusy } : {}),
    reportRetryMs: 20,
    ...(opts.reportSettleMs ? { reportSettleMs: opts.reportSettleMs } : {}),
  });
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: ENV })}>
      <App
        controller={conversation}
        animate={false}
        bootMs={0}
        concierge={rt}
        initialConversation={opts.mode}
        {...(opts.statusline ? { initialStatusline: opts.statusline } : {})}
      />
    </ThemeProvider>,
  );
  const frame = (): string => plain(r.lastFrame() ?? '');
  return { conversation, rt, conciergeCalls, frame, ...r };
}

/** Dono pede trabalho ⇒ task_start; evento automático de fim de tarefa ⇒ só relata. */
const ownerStartsTask = (m: string): ModelCallResult =>
  /EVENTO AUTOMÁTICO/.test(m) ? text('Resumo: tudo certo.') : text('Iniciei.', startTask());
const startTask = (goal = 'fazer o trabalho') => [{ id: '1', name: 'task_start', input: { goal } }];
const blocksOf = (c: SessionController, kind: string) =>
  c.current.blocks.filter((b) => b.kind === kind);

describe('Resposta do Concierge = o bloco `┃ Λluy` normal, em stream', () => {
  it('cresce token a token no MESMO bloco aluy (um bloco por resposta) e assenta com markdown', async () => {
    const gate = defer();
    const s = build({
      mode: 'concierge',
      concierge: () => text('Oi, **tudo** certo por aqui, e com você?'),
      wordGate: (i) => (i === 2 ? gate.promise : undefined),
    });
    await type(s, 'oi');
    await waitFor(() => blocksOf(s.conversation, 'aluy').length === 1);
    // Parcial: o bloco existe, está em stream, e já mostra as primeiras palavras.
    await waitFor(() => plain(s.frame()).includes('Oi,'));
    const mid = blocksOf(s.conversation, 'aluy')[0] as { text: string; streaming: boolean };
    expect(mid.streaming).toBe(true);
    expect(mid.text).toContain('Oi,');
    expect(mid.text).not.toContain('com você');
    gate.resolve();
    await waitFor(
      () => (blocksOf(s.conversation, 'aluy')[0] as { streaming: boolean }).streaming === false,
    );
    const done = blocksOf(s.conversation, 'aluy') as { text: string }[];
    expect(done).toHaveLength(1); // UM bloco por resposta
    expect(done[0]!.text).toBe('Oi, **tudo** certo por aqui, e com você?');
    expect(blocksOf(s.conversation, 'note')).toHaveLength(0); // nada de nota `◕ Λluy`
    expect(s.frame()).not.toContain('**'); // markdown renderizado
    s.unmount();
  });

  it('erro/cota (nada transmitido) entra como UM bloco aluy, não como nota', async () => {
    const conversation = mkController({
      call: async () => ({ request_id: 'r', content: '', finish_reason: 'stop' }),
    });
    const rt = new ConciergeRuntime({
      sink: conversation,
      model: {
        call: async () => {
          throw Object.assign(new Error('quota exceeded'), { code: 'quota' });
        },
      },
    });
    await rt.handleOwnerMessage('oi');
    const aluy = blocksOf(conversation, 'aluy') as { text: string }[];
    expect(aluy).toHaveLength(1);
    expect(aluy[0]!.text).toContain('sem cota');
    expect(blocksOf(conversation, 'note')).toHaveLength(0);
  });
});

describe('A conversa nunca espera o trabalho; o trabalho nunca entra na conversa', () => {
  it('mensagem durante tarefa viva é respondida na hora; a tarefa segue; nada vai à fila', async () => {
    const g0 = defer();
    const task = taskSession({
      iters: () => 'pronto.',
      gates: (t) => (t === 0 ? g0.promise : undefined),
    });
    const s = build({
      mode: 'concierge',
      tasks: [task],
      concierge: (m) =>
        /trabalho/.test(m)
          ? text('Iniciei.', startTask())
          : text('Está rodando, t1 em chamada ao modelo.'),
    });
    await type(s, 'faça o trabalho');
    await waitFor(() => task.current.phase === 'streaming');
    expect(s.rt.registry.get('t1')!.status).toBe('running');
    await type(s, 'como está?');
    await waitFor(() => s.frame().includes('Está rodando, t1'));
    expect(task.current.phase).toBe('streaming');
    expect(s.frame()).not.toContain('na fila');
    g0.resolve();
    await waitFor(() => s.rt.registry.get('t1')?.status === 'done');
    s.unmount();
  });

  it('NENHUM bloco da tarefa na transcrição; conclusão = UMA linha dim; resultado não se repete', async () => {
    const task = taskSession({ iters: () => 'RESULTADO-UNICO-DA-TAREFA' });
    const s = build({
      mode: 'concierge',
      tasks: [task],
      concierge: ownerStartsTask,
    });
    await type(s, 'faça o trabalho');
    await waitFor(() => s.rt.registry.get('t1')?.status === 'done');
    await waitFor(() => blocksOf(s.conversation, 'inject').length === 1);
    const kinds = new Set(s.conversation.current.blocks.map((b) => b.kind));
    // Só conversa: você / Λluy / a linha de conclusão. Sem tool, sem testrun, sem subagents.
    for (const k of kinds) expect(['you', 'aluy', 'inject']).toContain(k);
    const line = blocksOf(s.conversation, 'inject')[0] as { text: string; plain?: boolean };
    expect(line.plain).toBe(true);
    expect(line.text).toMatch(/^✔ t1 concluída — RESULTADO-UNICO-DA-TAREFA/);
    // O resultado aparece UMA vez (a linha), não duas (resposta da tarefa + relato).
    expect(s.frame().split('RESULTADO-UNICO-DA-TAREFA').length - 1).toBe(1);
    // O transcrito completo segue acessível na vista de detalhe (sessão da tarefa).
    expect(task.current.blocks.some((b) => b.kind === 'aluy')).toBe(true);
    s.unmount();
  });

  it('o rodapé mostra a ferramenta em curso da tarefa (`bash ls -la`), não a conversa', async () => {
    const g = defer();
    const task = taskSession({
      iters: (t) => (t === 0 ? toolCall('run_command', { command: 'ls -la' }) : 'ok'),
      gates: (t) => (t === 1 ? g.promise : undefined),
    });
    const s = build({
      mode: 'concierge',
      tasks: [task],
      concierge: () => text('Iniciei.', startTask()),
    });
    await type(s, 'faça o trabalho');
    await waitFor(() => task.current.phase === 'asking');
    // aprovação na caixa de entrada (rodapé), com o comando visível
    await waitFor(() => s.frame().includes('t1 pede aprovação') && /\$ ls -la/.test(s.frame()));
    expect(s.conversation.current.phase).not.toBe('asking'); // a conversa NÃO é bloqueada
    await type(s, '/a');
    await waitFor(() => task.current.phase !== 'asking');
    g.resolve();
    await waitFor(() => s.rt.registry.get('t1')?.status === 'done');
    s.unmount();
  });

  it('Esc NUNCA interrompe a tarefa: só limpa o rascunho', async () => {
    const g0 = defer();
    const task = taskSession({
      iters: () => 'pronto.',
      gates: (t) => (t === 0 ? g0.promise : undefined),
    });
    const s = build({
      mode: 'concierge',
      tasks: [task],
      concierge: () => text('Iniciei.', startTask('g')),
    });
    const spyTask = vi.spyOn(task, 'interrupt');
    const spyConv = vi.spyOn(s.conversation, 'interrupt');
    await type(s, 'faça o trabalho');
    await waitFor(() => task.current.phase === 'streaming');
    s.stdin.write(ESC);
    await sleep(150);
    s.stdin.write('rascunho qualquer');
    await sleep(60);
    s.stdin.write(ESC);
    await sleep(150);
    expect(spyTask).not.toHaveBeenCalled();
    expect(spyConv).not.toHaveBeenCalled();
    expect(task.current.phase).toBe('streaming');
    expect(s.rt.registry.get('t1')!.status).toBe('running');
    expect(s.frame()).not.toContain('rascunho qualquer');
    g0.resolve();
    await waitFor(() => s.rt.registry.get('t1')?.status === 'done');
    s.unmount();
  });

  it('correção vai à tarefa certa pelo task_send (fila de injeção da sessão dela)', async () => {
    const g0 = defer();
    const task = taskSession({
      iters: () => 'pronto.',
      gates: (t) => (t === 0 ? g0.promise : undefined),
    });
    const s = build({
      mode: 'concierge',
      tasks: [task],
      concierge: (m) =>
        /async/.test(m)
          ? text('Enviei à t1.', [
              {
                id: '2',
                name: 'task_send',
                input: { task_id: 't1', message: 'usar async/await (correção)' },
              },
            ])
          : text('Iniciei.', startTask('g')),
    });
    const inj = vi.spyOn(task, 'injectInput');
    await type(s, 'faça o trabalho');
    await waitFor(() => task.current.phase === 'streaming');
    await type(s, 'use async');
    await waitFor(() => inj.mock.calls.length > 0);
    expect(inj).toHaveBeenCalledWith('root', 'usar async/await (correção)');
    expect(s.conciergeCalls).toContain('use async');
    g0.resolve();
    s.unmount();
  });
});

describe('Painel de tarefas do rodapé', () => {
  async function three() {
    const gs = [defer(), defer(), defer()];
    const tasks = gs.map((g) =>
      taskSession({ iters: () => 'ok', gates: (t) => (t === 0 ? g.promise : undefined) }),
    );
    let n = 0;
    const s = build({
      mode: 'concierge',
      tasks,
      concierge: () =>
        text(`Iniciei ${++n}.`, [
          { id: String(n), name: 'task_start', input: { goal: `tarefa ${n}` } },
        ]),
    });
    for (const m of ['um', 'dois', 'tres']) {
      await type(s, m);
      await waitFor(() => s.conciergeCalls.includes(m));
      await sleep(80);
    }
    await waitFor(() => s.rt.registry.live().length === 3);
    return { s, gs, tasks };
  }

  it('3 tarefas: com espaço, as TAREFAS aparecem na linha dos agentes; ↓ expande (dica); enter abre o detalhe (nota no histórico)', async () => {
    const { s, gs } = await three();
    await sleep(200);
    await waitFor(() => s.frame().includes('3 tarefas:'));
    expect(s.frame()).toContain('[t1 tarefa 1]');
    expect(s.frame()).toContain('herdado');
    expect(s.frame()).not.toContain('enter detalhes'); // não expandido
    s.stdin.write(DOWN);
    await waitFor(() => s.frame().includes('enter detalhes'));
    await sleep(300);
    const alturaAntes = ((): number => {
      const l = s.frame().split('\n');
      return l.length - l.findIndex((x) => x.includes('❯'));
    })();
    s.stdin.write(CR);
    // INLINE: o detalhe vai como UMA nota no histórico (vista que crescesse deixaria um buraco).
    await waitFor(() => blocksOf(s.conversation, 'note').length > 0);
    await sleep(200);
    expect(s.frame()).not.toContain('esc fecha'); // não há overlay a fechar
    // A região viva (do composer p/ baixo) tem a MESMA altura antes e depois: nada cresce, logo
    // nada vira buraco em branco ao fechar.
    const vivo = (f: string): number => {
      const l = f.split('\n');
      return l.length - l.findIndex((x) => x.includes('❯'));
    };
    expect(vivo(s.frame())).toBe(alturaAntes);
    expect(
      blocksOf(s.conversation, 'note').some(
        (n) => (n as { title: string }).title === 't3 · detalhe',
      ),
    ).toBe(true);
    gs.forEach((g) => g.resolve());
    s.unmount();
  });

  it('/task show t1 abre o detalhe; hidden = só a linha-resumo', async () => {
    const { s, gs } = await three();
    await type(s, '/task show t1');
    await waitFor(() => s.frame().includes('t1 · detalhe'));
    gs.forEach((g) => g.resolve());
    s.unmount();
  });
});

describe('Espaçamento (block-rhythm)', () => {
  it('entre eco → resposta → linha de conclusão há no máximo UMA linha em branco', async () => {
    const task = taskSession({ iters: () => 'feito.' });
    const s = build({
      mode: 'concierge',
      tasks: [task],
      concierge: ownerStartsTask,
    });
    await type(s, 'faça o trabalho');
    await waitFor(() => s.rt.registry.get('t1')?.status === 'done');
    await waitFor(() => blocksOf(s.conversation, 'inject').length === 1);
    await sleep(100);
    const lines = s.frame().split('\n');
    const at = (needle: string): number => lines.findIndex((l) => l.includes(needle));
    const echo = at('faça o trabalho');
    const head = lines.findIndex((l, i) => i > echo && l.includes('Λluy'));
    const body = at('Iniciei.');
    const done = at('✔ t1 concluída');
    expect(echo).toBeGreaterThanOrEqual(0);
    expect(head - echo).toBeLessThanOrEqual(2); // você → Λluy: ≤ 1 em branco
    expect(body - head).toBe(1); // cabeçalho colado ao corpo
    expect(done - body).toBeLessThanOrEqual(2); // resposta → conclusão: ≤ 1 em branco
    s.unmount();
  });

  it('regra pura: para qualquer par de blocos da conversa, o respiro soma 0 ou 1 linha', () => {
    const kinds = ['you', 'aluy', 'inject'] as const;
    for (const prev of kinds) {
      for (const next of kinds) {
        const trailing = blockEndsWithBlankLine(prev) ? 1 : 0;
        const lead =
          next === 'aluy'
            ? aluyNeedsLeadingBlank(prev)
              ? 1
              : 0
            : blankAfterInject(next, prev)
              ? 1
              : 0;
        expect(trailing + lead).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('Sub-agentes saem da conversa e vão para o rodapé (clássico também)', () => {
  it('o bloco `+ N sub-agentes` não está na transcrição; está no rodapé; ao terminar vira UMA linha', async () => {
    const s = build({ mode: 'classic', concierge: () => text('x') });
    const c = s.conversation as unknown as {
      upsertSubAgentChild(label: string, child: unknown): void;
      patch(p: unknown): void;
    };
    c.upsertSubAgentChild('um', { label: 'um', status: 'running' });
    c.patch({ liveSubagents: [{ label: 'um', phase: 'thinking' }] });
    await waitFor(() => s.frame().includes('[um]'));
    const f = s.frame();
    // aparece UMA vez (no rodapé), não duas (conversa + rodapé)
    expect(f.split('[um]').length - 1).toBe(1);
    c.upsertSubAgentChild('um', { label: 'um', status: 'done', summary: '120 tokens · 12s' });
    await waitFor(() => s.frame().includes('✔ [um] pronto — 120 tokens · 12s'));
    const lines = blocksOf(s.conversation, 'inject') as { text: string }[];
    expect(lines.filter((l) => l.text.startsWith('✔ [um] pronto')).length).toBe(1);
    s.unmount();
  });
});

describe('Modo clássico inalterado', () => {
  it('Esc com tudo vazio INTERROMPE o turno e o Concierge nem é chamado', async () => {
    const g0 = defer();
    const model: ModelCaller = {
      async call() {
        conversationRef!.sink.onStart?.();
        conversationRef!.sink.onDelta?.('');
        await g0.promise;
        return { request_id: 'r', content: 'pronto.', finish_reason: 'stop' };
      },
    };
    let conversationRef: SessionController | null = null;
    const s = build({ mode: 'classic', concierge: () => text('não deveria'), classicModel: model });
    conversationRef = s.conversation;
    const spy = vi.spyOn(s.conversation, 'interrupt');
    void s.conversation.submit('objetivo');
    await waitFor(() => s.conversation.current.phase === 'streaming');
    s.stdin.write(ESC);
    await waitFor(() => spy.mock.calls.length > 0);
    expect(s.conciergeCalls).toEqual([]);
    g0.resolve();
    s.unmount();
  });
});

describe('Ordem do rodapé: composer → statusline → painel; sem linha em branco entre eles', () => {
  async function comTarefa(statusline: 'full' | 'compact' | 'hidden', approval = false) {
    const g = defer();
    const task = taskSession({
      iters: (t) => (approval && t === 0 ? toolCall('run_command', { command: 'echo oi' }) : 'ok'),
      gates: (t) => (t === 0 && !approval ? g.promise : undefined),
    });
    const s = build({
      mode: 'concierge',
      tasks: [task],
      statusline,
      concierge: () => text('Iniciei.', startTask('fazer')),
    });
    await type(s, 'faça');
    await waitFor(() => s.rt.registry.get('t1') !== undefined);
    const marca = statusline === 'full' ? '1 tarefa:' : '1 tarefa ·';
    await waitFor(() => s.frame().includes(marca));
    if (approval) await waitFor(() => s.frame().includes('pede aprovação'));
    await sleep(150);
    return { s, g };
  }
  const idx = (lines: string[], needle: string): number =>
    lines.findIndex((l) => l.includes(needle));

  for (const modo of ['full', 'compact'] as const) {
    it(`statusline ${modo}: painel por ÚLTIMO, colado à statusline (sem linha em branco)`, async () => {
      const { s, g } = await comTarefa(modo);
      const lines = s.frame().split('\n');
      const composer = idx(lines, '❯');
      const painel = idx(lines, modo === 'full' ? '1 tarefa:' : '1 tarefa ·');
      const status = lines.findIndex((l, i) => i > composer && /sessão|janela|comandos/.test(l));
      expect(composer).toBeGreaterThan(-1);
      expect(status).toBeGreaterThan(composer);
      expect(painel).toBeGreaterThan(status); // composer → statusline → painel
      expect(lines[painel - 1]!.trim()).not.toBe(''); // nada em branco entre statusline e painel
      g.resolve();
      s.unmount();
    });
  }

  it('statusline hidden: sem statusline, o painel fica logo sob o composer', async () => {
    const { s, g } = await comTarefa('hidden');
    const lines = s.frame().split('\n');
    const composer = idx(lines, '❯');
    const painel = idx(lines, '1 tarefa ·');
    expect(painel - composer).toBeLessThanOrEqual(3); // barra do composer + painel
    expect(lines.slice(composer, painel).every((l) => !/sessão/.test(l))).toBe(true);
    g.resolve();
    s.unmount();
  });

  it('aprovação pendente aparece no fim do painel, também com o painel recolhido (compact)', async () => {
    const { s } = await comTarefa('compact', true);
    const lines = s.frame().split('\n');
    expect(idx(lines, 't1 pede aprovação')).toBeGreaterThan(idx(lines, '❯'));
    await type(s, '/n');
    s.unmount();
  });

  it('a resposta do Concierge → composer: exatamente UMA linha em branco (com e sem tarefa viva)', async () => {
    for (const comTask of [false, true]) {
      const g = defer();
      const tasks = comTask ? [taskSession({ iters: () => 'ok', gates: () => g.promise })] : [];
      const s = build({
        mode: 'concierge',
        tasks,
        concierge: (m) =>
          comTask && /faça/.test(m) ? text('Iniciei.', startTask()) : text('Certo.'),
      });
      if (comTask) {
        await type(s, 'faça');
        await waitFor(() => s.frame().includes('1 tarefa:'));
      }
      await type(s, 'oi');
      await waitFor(() => s.frame().includes('Certo.'));
      await sleep(250);
      const lines = s.frame().split('\n');
      const resp = idx(lines, 'Certo.');
      const topo = lines.findIndex((l, i) => i > resp && l.includes('┃')); // barra do composer
      const brancos = lines.slice(resp + 1, topo).filter((l) => l.trim() === '').length;
      expect(topo).toBeGreaterThan(resp);
      // Com tarefa rodando a frase de espera ocupa a linha entre a resposta e o composer: um
      // respiro de cada lado dela (2); sem tarefa, só o respiro de sempre (1).
      expect(brancos).toBe(comTask ? 2 : 1);
      g.resolve();
      s.unmount();
    }
  });
});

describe('Atalho de letra nunca dispara enquanto o dono digita', () => {
  async function foco() {
    const g = defer();
    const task = taskSession({ iters: () => 'ok', gates: () => g.promise });
    const s = build({
      mode: 'concierge',
      tasks: [task],
      concierge: () => text('Iniciei.', startTask('g')),
    });
    await type(s, 'faça');
    await waitFor(() => s.frame().includes('1 tarefa:'));
    await sleep(200);
    s.stdin.write(DOWN); // foca/expande o painel (❯ na tarefa)
    await waitFor(() => s.frame().includes('enter detalhes'));
    await sleep(300);
    return { s, g, task };
  }

  it('digitar "parou?" com o painel focado NUNCA para a tarefa e o texto vai inteiro ao composer', async () => {
    const { s, g } = await foco();
    for (const ch of 'parou?') {
      s.stdin.write(ch);
      await sleep(60);
    }
    await sleep(200);
    expect(s.rt.registry.get('t1')!.status).toBe('running');
    expect(s.frame()).toContain('parou?'); // inclusive o `p` inicial
    expect(s.frame()).not.toContain('enter detalhes'); // digitar tira o foco do painel
    g.resolve();
    s.unmount();
  });

  it('parar exige ctrl+k DUAS vezes (confirmação); outra tecla no meio cancela', async () => {
    const { s, g } = await foco();
    s.stdin.write('\x0b'); // ctrl+k: arma
    await waitFor(() => s.frame().includes('ctrl+k de novo PARA t1'));
    expect(s.rt.registry.get('t1')!.status).toBe('running');
    await sleep(300);
    s.stdin.write(DOWN); // outra tecla cancela
    await sleep(500);
    await waitFor(() => !s.frame().includes('ctrl+k de novo PARA'));
    await sleep(300);
    s.stdin.write('\x0b');
    await waitFor(() => s.frame().includes('ctrl+k de novo PARA t1'));
    await sleep(400);
    s.stdin.write('\x0b'); // confirma
    await waitFor(() => s.rt.registry.get('t1')!.status === 'stopped');
    g.resolve();
    s.unmount();
  });
});

describe('Vista de detalhe nunca passa da altura do terminal (senão sobra buraco ao fechar)', () => {
  it('região viva (vista + painel + resto) ≤ rows para qualquer terminal e painel', () => {
    for (let rows = 24; rows <= 80; rows += 2) {
      for (let painel = 0; painel <= 14; painel += 1) {
        const room = taskDetailRoomFor(rows, painel);
        const vivo = room + 3 + painel + LIVE_OVERHEAD_ROWS;
        // terminais muito baixos (piso de 2 linhas de conteúdo) são o único caso fora da regra
        if (rows - LIVE_OVERHEAD_ROWS - painel - 4 >= 2) expect(vivo).toBeLessThan(rows); // ESTRITAMENTE menor
        expect(room).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe('Entre blocos da conversa: exatamente UMA linha em branco (resposta → você)', () => {
  it('Λluy → você tem 1 linha em branco, não 3', async () => {
    const s = build({ mode: 'concierge', concierge: () => text('Certo.') });
    await type(s, 'um');
    await waitFor(() => s.frame().includes('Certo.'));
    await sleep(200);
    await type(s, 'dois');
    await waitFor(() => s.conciergeCalls.includes('dois'));
    await sleep(300);
    const lines = s.frame().split('\n');
    const primeira = lines.findIndex((l) => l.includes('Certo.'));
    const voce = lines.findIndex((l, i) => i > primeira && l.includes('você'));
    expect(voce).toBeGreaterThan(primeira);
    expect(lines.slice(primeira + 1, voce).filter((l) => l.trim() === '').length).toBe(1);
    s.unmount();
  });
});

describe('Relato automático: o Concierge resume o resultado quando a tarefa termina', () => {
  it('done ⇒ turno automático com o resultado; resposta em bloco Λluy normal + marcador curto', async () => {
    const task = taskSession({ iters: () => 'Bug: usa subtração em vez de soma.' });
    const seen: string[] = [];
    const s = build({
      mode: 'concierge',
      tasks: [task],
      concierge: (m) => {
        seen.push(m);
        return /EVENTO AUTOMÁTICO/.test(m)
          ? text('Resumo: a função subtrai quando devia somar.')
          : text('Iniciei.', startTask());
      },
    });
    await type(s, 'explica e abre uma tarefa');
    await waitFor(() => s.frame().includes('Resumo: a função subtrai'));
    const auto = seen.find((m) => /EVENTO AUTOMÁTICO/.test(m))!;
    expect(auto).toContain('Bug: usa subtração em vez de soma.');
    const aluy = blocksOf(s.conversation, 'aluy') as { text: string; streaming?: boolean }[];
    expect(aluy.map((b) => b.text)).toEqual([
      'Iniciei.',
      'Resumo: a função subtrai quando devia somar.',
    ]);
    const marker = blocksOf(s.conversation, 'inject') as { text: string }[];
    expect(marker[0]!.text).toMatch(/^✔ t1 concluída/);
    s.unmount();
  });

  it('só dispara com o dono ocioso: fica na fila enquanto ownerBusy', async () => {
    let busy = true;
    const task = taskSession({ iters: () => 'feito.' });
    const seen: string[] = [];
    const s = build({
      mode: 'concierge',
      tasks: [task],
      ownerBusy: () => busy,
      concierge: (m) => {
        seen.push(m);
        return /EVENTO AUTOMÁTICO/.test(m) ? text('Resumo pronto.') : text('Iniciei.', startTask());
      },
    });
    await type(s, 'faça o trabalho');
    await waitFor(() => s.rt.registry.get('t1')?.status === 'done');
    await sleep(150);
    expect(seen.some((m) => /EVENTO AUTOMÁTICO/.test(m))).toBe(false);
    busy = false;
    await waitFor(() => s.frame().includes('Resumo pronto.'));
    expect(seen.filter((m) => /EVENTO AUTOMÁTICO/.test(m))).toHaveLength(1);
    s.unmount();
  });

  it('várias tarefas que terminam juntas viram UM relato (janela de agrupamento)', async () => {
    const t1 = taskSession({ iters: () => 'primeira.' });
    // t2 termina ~150ms depois de t1: sem a janela de agrupamento sairiam DOIS relatos.
    const t2 = taskSession({ iters: () => 'segunda.', gates: () => sleep(150) });
    const seen: string[] = [];
    const s = build({
      mode: 'concierge',
      tasks: [t1, t2],
      reportSettleMs: 400,
      concierge: (m) => {
        seen.push(m);
        return /EVENTO AUTOMÁTICO/.test(m)
          ? text('Resumo das duas.')
          : text('Iniciei.', [
              ...startTask(),
              { id: '2', name: 'task_start', input: { goal: 'outra' } },
            ]);
      },
    });
    await type(s, 'faça o trabalho');
    await waitFor(() => s.rt.registry.get('t2')?.status === 'done');
    await waitFor(() => s.frame().includes('Resumo das duas.'));
    await sleep(500);
    expect(seen.filter((m) => /EVENTO AUTOMÁTICO/.test(m))).toHaveLength(1);
    s.unmount();
  });

  it('anti-laço: o turno automático não inicia tarefa nova que gere outro relato com tarefas', async () => {
    const t1 = taskSession({ iters: () => 'primeira.' });
    const t2 = taskSession({ iters: () => 'segunda.' });
    const seen: string[] = [];
    const s = build({
      mode: 'concierge',
      tasks: [t1, t2],
      concierge: (m) => {
        seen.push(m);
        // Insiste em abrir tarefa até no relato automático.
        return /EVENTO AUTOMÁTICO/.test(m)
          ? text('Relatei e abri a próxima.', startTask('corrigir'))
          : text('Iniciei.', startTask());
      },
    });
    await type(s, 'faça o trabalho');
    await waitFor(() => s.rt.registry.get('t2')?.status === 'done');
    await sleep(300);
    // t1 (relato livre ⇒ abriu t2) e t2 (relato restrito ⇒ recusa): nada além de t2.
    expect(s.rt.registry.list().map((t) => t.id)).toEqual(['t1', 't2']);
    expect(seen.filter((m) => /EVENTO AUTOMÁTICO/.test(m))).toHaveLength(2);
    s.unmount();
  });
});

describe('Concierge: nenhuma linha `┃` órfã depois da resposta', () => {
  it('"\\n" soltos entre as tool-calls (uma por tarefa) não viram linhas vazias no histórico', async () => {
    const gate = defer();
    const s = build({
      mode: 'concierge',
      tasks: [
        taskSession({ iters: () => 'a.' }),
        taskSession({ iters: () => 'b.' }),
        taskSession({ iters: () => 'c.' }),
      ],
      // o modelo emite quebras de linha depois do texto (antes de cada tool-call)
      concierge: (m) =>
        /EVENTO AUTOMÁTICO/.test(m)
          ? text('Resumo.')
          : text('Iniciei 3 tarefas.\n\n\n', [
              ...startTask('um'),
              { id: '2', name: 'task_start', input: { goal: 'dois' } },
              { id: '3', name: 'task_start', input: { goal: 'tres' } },
            ]),
    });
    void gate;
    await type(s, 'faça tudo');
    await waitFor(() => s.rt.registry.get('t3')?.status === 'done');
    await waitFor(() => s.frame().includes('Resumo.'));
    const aluy = blocksOf(s.conversation, 'aluy') as { text: string }[];
    expect(aluy[0]!.text).toBe('Iniciei 3 tarefas.');
    const linhas = s.frame().split('\n');
    expect(linhas.filter((l) => /^\s*┃\s*$/.test(l)).length).toBeLessThanOrEqual(2); // só a moldura do composer
    s.unmount();
  });
});

describe('Frase de espera: a linha existe com a conversa ociosa e uma tarefa rodando', () => {
  it('mostra uma frase da lista + `em segundo plano` acima do composer; some quando a tarefa acaba', async () => {
    const g = defer();
    const s = build({
      mode: 'concierge',
      tasks: [taskSession({ iters: () => 'ok', gates: () => g.promise })],
      concierge: () => text('Iniciei.', startTask()),
    });
    await type(s, 'faça');
    await waitFor(() => s.frame().includes('em segundo plano'));
    const frases = parseFrases(resolveText('pt-BR', 'working.quips'));
    const linhas = s.frame().split('\n');
    const i = linhas.findIndex((l) => l.includes('em segundo plano'));
    expect(frases.some((f) => linhas[i]!.includes(`${f}…`))).toBe(true);
    expect(i).toBeLessThan(linhas.findIndex((l) => l.includes('❯'))); // acima do composer
    g.resolve();
    await waitFor(() => !s.frame().includes('em segundo plano'));
    s.unmount();
  });
});

describe('Ritmo vertical no Concierge: 1 linha entre blocos, notas coladas, sem corridas', () => {
  it('você → Λluy → notas → Λluy (resumo) → você: exatamente 1 em branco entre blocos; notas sem vão', async () => {
    const task = taskSession({ iters: () => 'feito.' });
    const s = build({
      mode: 'concierge',
      tasks: [task],
      concierge: (m) =>
        /EVENTO AUTOMÁTICO/.test(m) ? text('Resumo: tudo certo.') : text('Iniciei.', startTask()),
    });
    await type(s, 'faça o trabalho');
    await waitFor(() => s.frame().includes('Resumo: tudo certo.'));
    await sleep(80);
    await type(s, 'valeu');
    await waitFor(() => s.conversation.current.blocks.filter((b) => b.kind === 'you').length === 2);
    await waitFor(() => blocksOf(s.conversation, 'aluy').length === 3);
    await sleep(120);
    const lines = s.frame().split('\n');
    const at = (needle: string): number => lines.findIndex((l) => l.includes(needle));
    const blanksBetween = (a: number, b: number): number =>
      lines.slice(a + 1, b).filter((l) => l.trim() === '').length;
    const resumo = at('Resumo: tudo certo.');
    const valeu = lines.findIndex((l, i) => i > resumo && l.includes('valeu'));
    const voce2 = valeu - 1; // cabeçalho `você` logo acima do texto
    expect(lines[voce2]).toContain('você');
    // Λluy (resumo) → você: exatamente 1 linha em branco
    expect(blanksBetween(resumo, voce2)).toBe(1);
    // a conclusão (nota) vem colada, sem vão, e há 1 em branco antes do Λluy seguinte
    const done = at('✔ t1 concluída');
    expect(done).toBeGreaterThan(-1);
    const head = lines.findIndex((l, i) => i > done && l.includes('Λluy'));
    expect(blanksBetween(done, head)).toBe(1);
    // nunca 2 linhas em branco seguidas entre o 1º bloco e o fim da conversa
    const first = at('você');
    const run = lines
      .slice(first, valeu + 6)
      .join('\n')
      .match(/\n[ \t]*\n[ \t]*\n/);
    expect(run).toBeNull();
    s.unmount();
  });
});
