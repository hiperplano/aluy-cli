// BUG-GAP-CRESCENTE — resize INLINE (não fullscreen) com histórico GRANDE: a
// DISTÂNCIA (gap) entre a área de saída (histórico no <Static>) e o composer
// CRESCIA a cada resize. Mecanismo CONFIRMADO por este teste (bytes reais do
// Ink, mesma técnica de `resize-static-dup.test.tsx`, agora no regime "cabe" —
// `outputHeight < rows`, o caso cotidiano que o F196 NÃO cobre): o resize-effect
// debounced (90ms) chamava `clearScreen()` incondicionalmente a cada settle, que
// (a) escreve `\x1b[H\x1b[2J\x1b[3J` cru e (b) BUMPA a `staticKey`, remontando o
// `<Static>` — o Ink então trata TODOS os itens já commitados como NOVOS e os
// reescreve por INTEIRO (`stdout.write(staticOutput)`). Com histórico GRANDE
// isso é custo O(histórico) A CADA SETTLE, e o `fullStaticOutput` do Ink (que
// ele NUNCA reseta — ver F196) acumula mais uma cópia completa por resize —
// uma BOMBA LATENTE: se a sessão depois cruzar (mesmo que só transitoriamente)
// o caminho `outputHeight >= rows`, o Ink despeja o buffer INTEIRO de uma vez,
// com N cópias acumuladas de cada resize anterior.
//
// FIX (App.tsx, resize-effect inline, comentário "BUG-GAP-CRESCENTE"): reduz a
// FREQUÊNCIA do remonte caro SEM eliminar sua garantia de correção (avaliamos e
// descartamos "clear cru sem remontar" — PIORA: o composer pula pro topo da
// tela com um vazio permanente abaixo, provado pelo mesmo harness de bytes,
// pois o remonte é o que REPREENCHE a tela após o `\x1b[H`; o `<Static>` do Ink
// não suporta reemitir só a cauda). Os dois mecanismos safe:
//   1. resize que muda só ROWS (largura igual) NUNCA precisa de repaint — o
//      reflow que deixa órfãos exige uma LARGURA nova pra rewrapear texto já
//      pintado.
//   2. COOLDOWN entre remontes forçados — limita a TAXA mesmo se o terminal
//      disparar `resize` em rajada espaçada (> 90ms entre eventos, furando a
//      coalescência do drag — o padrão de terminal que REFLOWA, ex. conhost).
//
// Este teste prova (1) width-only muda sempre dispara (comportamento existente
// preservado) e (2) uma sequência de resizes DENTRO do cooldown NÃO multiplica
// o header a cada um — a contagem cresce no máximo 1× por janela de cooldown,
// nunca 1× por resize (o "sem limite" que caracterizava o bug).

import React from 'react';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { render } from 'ink';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type SearchPort,
  type ShellPort,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const HEADER = 'Aluy Cli'; // item 0 do <Static> (header pinado, EST-0989)

// stdout FAKE: EventEmitter com columns/rows mutáveis + captura CRUA de cada write.
class FakeStdout extends EventEmitter {
  private _cols: number;
  private _rows: number;
  readonly writes: string[] = [];
  readonly isTTY = true;
  constructor(cols: number, rows: number) {
    super();
    this._cols = cols;
    this._rows = rows;
  }
  get columns(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
  }
  write(s: string, enc?: unknown, cb?: unknown): boolean {
    this.writes.push(String(s));
    if (typeof enc === 'function') (enc as () => void)();
    else if (typeof cb === 'function') (cb as () => void)();
    return true;
  }
  resize(cols: number, rows: number): void {
    this._cols = cols;
    this._rows = rows;
    this.emit('resize');
  }
}
class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): null {
    return null;
  }
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

/** Caller INSTANTÂNEO (sem pausa) — resolve na hora, o turno vira `done` (→ Static). */
function instantCaller(replyOf: (goal: string) => string): ModelCaller {
  return {
    async call(req): Promise<ModelCallResult> {
      const goal = req.messages.at(-1)?.content ?? '';
      const text = replyOf(String(goal));
      return { request_id: `r-${Math.random()}`, content: text, finish_reason: 'stop' };
    },
  };
}

function buildController(replyOf: (goal: string) => string): SessionController {
  return new SessionController({
    model: instantCaller(replyOf),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await sleep(5);
  }
}

/** Conta quantas vezes o HEADER aparece na CONCATENAÇÃO de todos os writes dados. */
function headerCount(writes: readonly string[]): number {
  const all = writes.join('');
  return all.split(HEADER).length - 1;
}

async function buildBigHistorySession(): Promise<{
  inst: ReturnType<typeof render>;
  fake: FakeStdout;
  before: number;
}> {
  // Histórico GRANDE: várias trocas concluídas (cada `submit()` resolve na hora
  // e vira turno `done` → migra p/ o <Static>, nunca mais re-renderizado).
  const controller = buildController((goal) => `resposta para: ${goal}`);

  // Terminal ALTO o bastante p/ a região viva (idle) caber em `rows` sem
  // estourar — o regime "cabe" que o F196 NÃO cobre (aquele é só p/
  // `outputHeight >= rows`).
  const fake = new FakeStdout(100, 40);
  const stdout = fake as unknown as NodeJS.WriteStream;
  const stdin = new FakeStdin() as unknown as NodeJS.ReadStream;
  const theme = resolveTheme({ env: ENV });
  const inst = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
    { stdout, stdin, patchConsole: false },
  );
  controller.dismissBoot();
  await sleep(40);

  // Constrói histórico GRANDE: 25 turnos concluídos sequenciais.
  for (let i = 0; i < 25; i++) {
    await controller.submit(`pergunta número ${i + 1} sobre o projeto`);
    await waitFor(() => controller.state.phase === 'idle' || controller.state.phase === 'done');
  }
  await sleep(60);

  const before = headerCount(fake.writes);
  expect(before).toBeGreaterThanOrEqual(1);
  return { inst, fake, before };
}

describe('App — RESIZE INLINE (regime "cabe") não reemite o histórico sem limite — BUG-GAP-CRESCENTE', () => {
  it('resizes DENTRO do cooldown (rajada espaçada, ex. terminal que reflowa) NÃO multiplicam o header 1:1', async () => {
    const { inst, fake, before } = await buildBigHistorySession();

    // N resizes espaçados 150ms (> debounce de 90ms, cada um "assenta" sozinho —
    // sem isto, TODOS cairiam no mesmo debounce e nunca provariam o cooldown),
    // mas DENTRO do cooldown de 500ms entre remontes forçados — simula uma
    // rajada de `resize` do terminal (drag rápido com settles intermediários,
    // ou um terminal que reflowa e reporta várias dimensões em sequência).
    const dims: Array<[number, number]> = [
      [95, 40],
      [90, 38],
      [100, 42],
      [85, 36],
      [100, 40],
    ];
    const countsAfterEachResize: number[] = [];
    for (const [cols, rows] of dims) {
      fake.resize(cols, rows);
      await sleep(150);
      countsAfterEachResize.push(headerCount(fake.writes));
    }

    // ANTES do fix: cada resize reemitia o histórico inteiro ⇒ contagem crescia
    // 1:1 a cada resize (2→3→4→5→6→7 — SEM LIMITE, medido nesta investigação).
    // Com o fix: o cooldown de 500ms barra os remontes que caem dentro da janela
    // do último — a contagem cresce NO MÁXIMO 1× a cada ~500ms, não 1× por resize.
    const last = countsAfterEachResize.at(-1)!;
    const totalGrowth = last - before;
    // 5 resizes em ~750ms de janela total, cooldown 500ms ⇒ no máximo 2 remontes
    // forçados cabem nessa janela (não 5). Growth estritamente MENOR que o nº de
    // resizes prova que o cooldown está ativo (o bug antigo dava growth === 5).
    expect(totalGrowth).toBeLessThan(dims.length);
    expect(totalGrowth).toBeGreaterThanOrEqual(0);

    // A contagem NUNCA deve DECRESCER (write é append-only) nem saltar mais que
    // 1 header por resize individual (nenhum resize isolado duplica internamente).
    let prevCount = before;
    for (const c of countsAfterEachResize) {
      expect(c).toBeGreaterThanOrEqual(prevCount);
      expect(c - prevCount).toBeLessThanOrEqual(1);
      prevCount = c;
    }

    inst.unmount();
  }, 30_000);

  it('resizes SEPARADOS por mais que o cooldown cada um dispara seu próprio repaint (correção preservada)', async () => {
    const { inst, fake, before } = await buildBigHistorySession();

    // 2 resizes bem espaçados (> cooldown de 500ms) — cada um é uma ação de
    // redimensionar GENUÍNA e distinta; o repaint de limpeza de órfãos (EST-1015)
    // continua valendo para AMBOS — não é um "nunca mais repinta" disfarçado.
    fake.resize(95, 40);
    await sleep(700);
    const afterFirst = headerCount(fake.writes);
    expect(afterFirst).toBe(before + 1);

    fake.resize(100, 42);
    await sleep(700);
    const afterSecond = headerCount(fake.writes);
    expect(afterSecond).toBe(before + 2);

    inst.unmount();
  }, 30_000);
});
