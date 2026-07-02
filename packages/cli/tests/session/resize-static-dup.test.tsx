// F196 (anti "espaço em branco GIGANTESCO no resize") — PROVA por BYTES de que
// redimensionar uma sessão VIVA que NÃO cabe em `rows` (Ink no caminho `outputHeight >=
// rows`) NÃO faz o Ink DUPLICAR o `fullStaticOutput` a cada resize.
//
// CAUSA-RAIZ (provada por captura): quando a região viva ≥ `rows`, o Ink reescreve
// `clearTerminal + fullStaticOutput + output` a CADA frame. O `clearScreen()` do resize
// remontava o `<Static>` (staticKey++), e o Ink ANEXA o histórico ao `fullStaticOutput`
// (buffer que ele NUNCA reseta) — então a cada redimensionar o repaint passava a reescrever
// 2×, 3×, … N× o scrollback (o "branco gigante" que só cresce e nunca encolhe). O fix: o
// <App> PULA o clearScreen nesse regime (o próprio Ink já repinta tudo via clearTerminal).
//
// A PROVA aqui usa o `render` REAL do Ink com um `stdout` FAKE que captura os BYTES CRUS
// (a ink-testing-library COMPÕE frames e não expõe o caminho `clearTerminal`; um stdout cru
// reproduz exatamente o que o terminal receberia). Forçamos o regime (terminal BAIXO 70×12 +
// turno em streaming), redimensionamos várias vezes, e afirmamos que NENHUM write de repaint
// (clearTerminal) contém o HEADER da sessão mais de UMA vez. ANTES do fix: 2×, 3×, … a cada resize.

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
import type { StreamSink } from '../../src/session/streaming-caller.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const CLEAR_TERM = '\x1b[2J\x1b[3J\x1b[H'; // `ansiEscapes.clearTerminal` do Ink (caminho outputHeight>=rows)
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

/** Caller que PAUSA no meio do stream (streaming=true) p/ a região viva ficar renderizada. */
function pausableCaller(text: string, getSink: () => StreamSink, gate: Promise<void>): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      const sink = getSink();
      sink.onStart?.();
      for (const ch of text) sink.onDelta(ch);
      await gate;
      sink.onDone?.();
      return { request_id: 'r', content: text, finish_reason: 'stop' };
    },
  };
}

function buildController(text: string, gate: Promise<void>): SessionController {
  let ctrl: SessionController | null = null;
  const sink: StreamSink = {
    onStart: () => ctrl?.sink.onStart?.(),
    onDelta: (c) => ctrl?.sink.onDelta(c),
    onUsage: (u) => ctrl?.sink.onUsage?.(u),
    onDone: () => ctrl?.sink.onDone?.(),
  };
  const controller = new SessionController({
    model: pausableCaller(text, () => sink, gate),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  ctrl = controller;
  return controller;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// F196 — timeout GENEROSO (10s): o render Ink real + stream de deltas + resize é
// timing-sensível; 2s passava local mas estourava no CI saturado (waitFor não assentava).
// Local ainda assenta em ~ms (o deadline só dá folga p/ a máquina de CI sob carga).
async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await sleep(5);
  }
}

/** Máximo de ocorrências do HEADER num ÚNICO write de repaint (clearTerminal). */
function maxHeaderPerClearTerm(writes: readonly string[]): number {
  let max = 0;
  for (const w of writes) {
    if (!w.includes(CLEAR_TERM)) continue;
    const n = w.split(HEADER).length - 1;
    if (n > max) max = n;
  }
  return max;
}

describe('App — RESIZE não duplica o fullStaticOutput do Ink (regime clearTerminal) — F196', () => {
  it('vários resizes em tela BAIXA/viva NÃO acumulam cópias do histórico no repaint', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // fala LONGA ⇒ a região viva não cabe em 12 linhas ⇒ Ink usa o caminho clearTerminal.
    const bigText = Array.from({ length: 30 }, (_, i) => `linha de fala ${i + 1}`).join('\n');
    const controller = buildController(bigText, gate);

    const stdout = new FakeStdout(70, 12) as unknown as NodeJS.WriteStream;
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
    controller.submit('conte uma historia');

    const fake = stdout as unknown as FakeStdout;
    // regime clearTerminal ativo? (região viva > 12 linhas)
    await waitFor(() => fake.writes.some((w) => w.includes(CLEAR_TERM)));

    // Redimensiona a LARGURA várias vezes (mantendo 12 linhas — segue no regime clearTerminal).
    const before = fake.writes.length;
    for (const w of [68, 66, 64, 62, 60]) {
      fake.resize(w, 12);
      await sleep(30);
    }
    await sleep(150); // deixa qualquer clearScreen (debounce 90ms) que fosse disparar

    // ANTES do fix: o header aparecia 2×, 3×, … num MESMO write de clearTerminal (fullStaticOutput
    // duplicado, crescendo a cada resize). Com o fix (pular o clearScreen nesse regime): sempre 1.
    const dupAfter = maxHeaderPerClearTerm(fake.writes.slice(before));
    expect(dupAfter).toBeLessThanOrEqual(1);

    release();
    await sleep(20);
    inst.unmount();
    // F196 — timeout de teste GENEROSO (20s): render Ink real + stream + 5 resizes com
    // sleeps + waitFor até 10s pode passar dos 5s default do vitest no CI sob carga.
  }, 20_000);
});
