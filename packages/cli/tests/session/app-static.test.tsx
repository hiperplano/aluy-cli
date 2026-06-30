// Anti-flicker (DoD) — a App roteia os turnos CONCLUÍDOS p/ o <Static> do Ink e
// mantém só a região VIVA no render dinâmico. Provar isso pela SAÍDA renderizada é
// frágil (a ink-testing-library compõe Static+dinâmico num só `lastFrame`, ao
// contrário do TTY real — ver a prova sob PTY no relatório). Então asseguramos a
// ESTRUTURA: espionamos o `<Static>` do Ink e provamos que (a) os blocos
// concluídos passam por ele (escritos uma vez) e (b) o bloco VIVO (aluy streaming)
// NÃO entra no Static — fica na árvore dinâmica.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// Captura os `items` entregues ao <Static> a cada render. O mock preserva o resto
// do Ink (Box/Text/render/useInput…) e troca só o Static por um coletor.
const staticItemsLog: unknown[][] = [];
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    Static: ({ items }: { items: unknown[]; children: unknown }) => {
      staticItemsLog.push(items);
      return null; // não renderiza no teste; só coletamos os items.
    },
  };
});

import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
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
import type { StreamSink } from '../../src/session/streaming-caller.js';
import type { SessionBlock } from '../../src/session/model.js';

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
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return [];
    },
  };
  return { fs, shell, search };
}

function scriptedCaller(text: string, sink: StreamSink): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      sink.onStart?.();
      for (const ch of text) sink.onDelta(ch);
      sink.onUsage?.({ request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 20 });
      sink.onDone?.();
      return { request_id: 'r', content: text, finish_reason: 'stop' };
    },
  };
}

/** Caller que PAUSA no meio do stream (await `gate`) p/ inspeção determinística. */
function pausableCaller(text: string, sink: StreamSink, gate: Promise<void>): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      sink.onStart?.();
      for (const ch of text) sink.onDelta(ch);
      await gate; // congela COM o turno aberto (streaming=true) p/ a App renderizar
      sink.onUsage?.({ request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 20 });
      sink.onDone?.();
      return { request_id: 'r', content: text, finish_reason: 'stop' };
    },
  };
}

function buildController(text: string, gate?: Promise<void>): SessionController {
  let ctrl: SessionController | null = null;
  const sink: StreamSink = {
    onStart: () => ctrl?.sink.onStart?.(),
    onDelta: (c) => ctrl?.sink.onDelta(c),
    onUsage: (u) => ctrl?.sink.onUsage?.(u),
    onDone: () => ctrl?.sink.onDone?.(),
  };
  const model = gate ? pausableCaller(text, sink, gate) : scriptedCaller(text, sink);
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 }, // flush imediato no teste
  });
  ctrl = controller;
  return controller;
}

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

function asBlocks(items: unknown[]): SessionBlock[] {
  return items as SessionBlock[];
}

/**
 * Espera DETERMINÍSTICA por uma CONDIÇÃO (em vez de `sleep` fixo): faz polling a
 * cada microtask/flush até `cond()` virar true, com teto generoso só p/ não pendurar
 * a suíte. Remove a corrida "asserta logo após N ms" (flake sob CI lento): aqui o
 * teste espera o estado ASSENTAR de fato, não um relógio.
 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('App — turnos concluídos vão p/ o <Static>, vivo fica dinâmico', () => {
  it('o turno do usuário (concluído) entra no Static; o aluy streaming NÃO', async () => {
    staticItemsLog.length = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const controller = buildController('vou responder com bastante texto aqui.', gate);
    const theme = resolveTheme({ env: ENV });
    const { unmount } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();

    // submete e deixa o stream CONGELAR no gate (turno aberto, streaming=true).
    void controller.submit('PERGUNTA_DO_USUARIO');
    // espera a fase VIVA assentar E o React RENDERIZÁ-LA no Static (o `you` concluído
    // já desceu) — sem sleep fixo; assim a leitura do log não corre com o commit.
    await waitFor(
      () =>
        controller.current.phase === 'streaming' &&
        asBlocks(staticItemsLog[staticItemsLog.length - 1] ?? []).some((b) => b.kind === 'you'),
    );
    expect(controller.current.phase).toBe('streaming');

    // o ÚLTIMO render do Static reflete a fase viva.
    const staticDuringStream = asBlocks(staticItemsLog[staticItemsLog.length - 1] ?? []);
    // o `you` (concluído) está no Static…
    expect(staticDuringStream.some((b) => b.kind === 'you')).toBe(true);
    // …e NENHUM bloco aluy streaming entrou no Static (fica no render dinâmico).
    expect(staticDuringStream.some((b) => b.kind === 'aluy' && b.streaming)).toBe(false);

    release(); // libera o stream p/ fechar o turno
    // espera o turno FECHAR de fato antes de desmontar (sem sleep fixo).
    await waitFor(() => controller.current.phase === 'done');
    unmount();
  });

  // EST-0989 — HEADER PINADO NO TOPO: o header é o 1º item do MESMO <Static> que
  // carrega o histórico, então fica ACIMA dos turnos no scrollback (antes era
  // renderizado ABAIXO do Static — espremido entre histórico e input). Provamos a
  // ORDEM pela estrutura dos `items`: o item 0 NÃO é um bloco da sessão (não tem
  // `kind`) — é o sentinela do header — e TODO bloco da conversa vem DEPOIS dele.
  it('o HEADER é o PRIMEIRO item do Static, ACIMA de todo bloco do histórico', async () => {
    staticItemsLog.length = 0;
    const controller = buildController('pronto.');
    const theme = resolveTheme({ env: ENV });
    const { unmount } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await controller.submit('faça'); // gera um turno `you` + `aluy` concluídos
    await waitFor(
      () =>
        controller.current.phase === 'done' &&
        (staticItemsLog[staticItemsLog.length - 1]?.length ?? 0) >= 2,
    );

    const items = staticItemsLog[staticItemsLog.length - 1] ?? [];
    // o item 0 é o sentinela do HEADER — não é um bloco da sessão (sem `kind`).
    const isBlock = (it: unknown): boolean =>
      typeof it === 'object' && it !== null && typeof (it as { kind?: unknown }).kind === 'string';
    expect(isBlock(items[0])).toBe(false); // header no TOPO, antes de tudo
    // há ao menos um bloco `you` no histórico, e ele vem DEPOIS do header (índice ≥ 1).
    const firstBlockIdx = items.findIndex(isBlock);
    expect(firstBlockIdx).toBeGreaterThanOrEqual(1);
    // e NENHUM bloco aparece antes do header (todo bloco está depois do índice 0).
    items.forEach((it, i) => {
      if (isBlock(it)) expect(i).toBeGreaterThanOrEqual(1);
    });
    // o 1º bloco do histórico é o turno do usuário (`you`) — confirma que o header
    // não é confundido com um bloco e que a ordem cronológica segue intacta abaixo.
    expect((items[firstBlockIdx] as { kind?: string }).kind).toBe('you');
    unmount();
  });

  it('ao FECHAR o turno, a fala do aluy (agora imutável) também desce p/ o Static', async () => {
    staticItemsLog.length = 0;
    const controller = buildController('pronto, concluído.');
    const theme = resolveTheme({ env: ENV });
    const { unmount } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await controller.submit('faça');
    // espera o turno FECHAR e o React RENDERIZAR o aluy imutável no Static — sem
    // sleep fixo: poll na CONDIÇÃO rendida, não num relógio.
    await waitFor(
      () =>
        controller.current.phase === 'done' &&
        asBlocks(staticItemsLog[staticItemsLog.length - 1] ?? []).some(
          (b) => b.kind === 'aluy' && !b.streaming,
        ),
    );

    // o último render do Static (turno fechado) contém o aluy NÃO-streaming.
    const finalStatic = asBlocks(staticItemsLog[staticItemsLog.length - 1] ?? []);
    const aluyDone = finalStatic.some((b) => b.kind === 'aluy' && !b.streaming);
    expect(aluyDone).toBe(true);
    expect(controller.current.phase).toBe('done');
    unmount();
  });
});

// #13 (ghost "rodando") — um `!comando` em voo (`running`) NÃO pode ser commitado no
// <Static> enquanto roda, NEM mesmo quando um bloco NÃO-vivo (uma nota `↳ encaixado` /
// `turno interrompido`) é empurrado DEPOIS dele. Antes, a âncora F142 arrastava o bang
// AINDA VIVO p/ o Static ⇒ `○ rodando` escrito UMA vez no scrollback e nunca repintado
// ao resolver = a linha FANTASMA do dono (só um resize a curava). Provamos via a captura
// dos `items` do <Static>: o bang `running` NUNCA entra; ao resolver, o bang TERMINAL
// (err/ok) entra UMA vez — resolução IN-PLACE, sem ghost.
describe('#13 — bang running + nota depois NÃO congela no Static (resolve in-place)', () => {
  function buildBangController(gate: Promise<void>): SessionController {
    const fs: FileSystemPort = {
      async readFile() {
        return '';
      },
      async writeFile() {},
      async exists() {
        return false;
      },
    };
    // shell que BLOQUEIA até o gate liberar ⇒ o bang fica `running` p/ inspeção determinística.
    const shell: ShellPort = {
      async exec() {
        await gate;
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    };
    const search: SearchPort = {
      async search() {
        return [];
      },
    };
    return new SessionController({
      model: inertModelCaller(),
      permission: new PolicyPermissionEngine(),
      ports: { fs, shell, search },
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
    });
  }

  function inertModelCaller(): ModelCaller {
    return {
      async call(): Promise<ModelCallResult> {
        return { request_id: 'r', content: '', finish_reason: 'stop' };
      },
    };
  }

  it('bang `running` fica FORA do Static mesmo com uma nota empurrada depois; resolve in-place', async () => {
    staticItemsLog.length = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const controller = buildBangController(gate);
    const theme = resolveTheme({ env: ENV });
    const { unmount } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();

    // dispara o `!comando` (fica `running` no gate) e, ENQUANTO roda, empurra uma nota —
    // exatamente o que `interrupt()`/`flushInjectNotes` fazem (bloco não-vivo após o vivo).
    // `!ls` ⇒ a catraca abre o AskDialog (phase `asking`); aprovar (como o `a` do dono)
    // executa — e o shell GATEADO o mantém `running` p/ inspeção determinística.
    void controller.runBang('ls');
    await waitFor(() => controller.current.phase === 'asking');
    controller.resolveAsk({ kind: 'approve-once' });
    await waitFor(() =>
      controller.current.blocks.some((b) => b.kind === 'bang' && b.status === 'running'),
    );
    controller.pushNote('↳ encaixado', ['oi durante o bang']);
    // espera o React renderizar o estado com o bang running + a nota.
    await waitFor(() =>
      controller.current.blocks.some((b) => b.kind === 'note' && b.title === '↳ encaixado'),
    );

    // PROVA do bug: NENHUM render do Static jamais conteve o bang em `running`.
    const sawRunningBangInStatic = staticItemsLog.some((items) =>
      asBlocks(items).some((b) => b.kind === 'bang' && b.status === 'running'),
    );
    expect(sawRunningBangInStatic).toBe(false);

    // libera o shell ⇒ o bang resolve (ok). A resolução é IN-PLACE no MESMO bloco.
    release();
    await waitFor(() => {
      const bang = controller.current.blocks.find((b) => b.kind === 'bang');
      return bang !== undefined && bang.kind === 'bang' && bang.status !== 'running';
    });
    // o turno acabou ⇒ o bang TERMINAL desce p/ o Static (escrito uma vez, já resolvido).
    await waitFor(() =>
      asBlocks(staticItemsLog[staticItemsLog.length - 1] ?? []).some(
        (b) => b.kind === 'bang' && b.status !== 'running',
      ),
    );
    const finalStatic = asBlocks(staticItemsLog[staticItemsLog.length - 1] ?? []);
    // o bang no Static está RESOLVIDO (nunca `running`).
    expect(finalStatic.some((b) => b.kind === 'bang' && b.status === 'running')).toBe(false);
    expect(finalStatic.some((b) => b.kind === 'bang' && b.status !== 'running')).toBe(true);
    unmount();
  });
});
