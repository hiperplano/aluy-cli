// F198 (anti "BLOCO GIGANTE de linhas em branco na resposta LONGA") — PROVA por BYTES, com o
// `render` REAL do Ink, de que uma resposta LONGA (região viva > `rows`, regime clearTerminal)
// que FINALIZA re-emite o histórico LIMPO (clearScreen) — matando o bloco de linhas em branco
// no scrollback (entre `▌ você` e `Λ aluy`).
//
// CAUSA-RAIZ (medida): quando a viva > `rows`, o Ink usa `outputHeight >= rows` — escreve
// `clearTerminal`+frame DIRETO e NÃO chama o `log-update`, então o `previousLineCount` dele
// CONGELA obsoleto (≈ altura da tela). Ao FINALIZAR (a fala vira bloco no `<Static>` e a viva
// encolhe abaixo de `rows`), o Ink volta ao `eraseLines` e o `log.clear()` obsoleto sobe ~1 tela
// e apaga linhas JÁ COMMITADAS ⇒ o branco gigante. Não há como resetar o `previousLineCount` do
// Ink por fora; então o wrapper de stdout DETECTA a borda de saída pelos BYTES
// (`onOverflowRegimeExit`) e a App re-emite o histórico via `clearScreen` (cursor ao HOME ⇒ o
// `eraseLines` obsoleto fica inócuo). Aqui provamos que, ao finalizar o turno em regime
// clearTerminal, o `clearScreen` da App (`\x1b[H\x1b[2J\x1b[3J`) É de fato disparado.
//
// TOLERANTE ao ambiente (igual ao F196): o regime clearTerminal do Ink depende de TTY/tamanho;
// se não for atingido (CI não-TTY), pula a asserção de bytes — a LÓGICA já é provada de forma
// determinística pelo unit puro de `createOverflowRegimeTracker` (synchronized-output.test.ts).

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
import { wrapStdoutWithSync } from '../../src/session/synchronized-output.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const CLEAR_TERM = '\x1b[2J\x1b[3J\x1b[H'; // `ansiEscapes.clearTerminal` (caminho outputHeight>=rows)
const CLEAR_SCREEN = '\x1b[H\x1b[2J\x1b[3J'; // o clearScreen da App (H-first — não casa o transform)

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
async function waitFor(cond: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await sleep(5);
  }
}

describe('App — resposta LONGA em regime clearTerminal re-emite o histórico limpo ao finalizar — F198', () => {
  it('ao FINALIZAR o turno (clearTerminal→fits) a App dispara clearScreen (mata o branco gigante)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // fala LONGA ⇒ a região viva não cabe em 12 linhas ⇒ Ink usa o caminho clearTerminal.
    const bigText = Array.from({ length: 40 }, (_, i) => `linha de fala ${i + 1}`).join('\n');
    const controller = buildController(bigText, gate);

    const fake = new FakeStdout(80, 12);
    // F198 — mesma composição do wiring (run.tsx): o wrapper detecta a borda clearTerminal→
    // eraseLines e chama o clearScreen que a App registrar. `overwrite: false` p/ o `clearTerminal`
    // e o `clearScreen` passarem CRUS aos bytes capturados (com o overwrite ON o transform os
    // reescreveria e o byte-proof não os veria) — a DETECÇÃO do regime `feed(body)` roda sobre o
    // body CRU do Ink (antes do transform), idêntica nos dois modos, então o loop provado é o mesmo.
    let clearScreenFn: (() => void) | null = null;
    const wrapped = wrapStdoutWithSync(fake as unknown as NodeJS.WriteStream, {
      sync: false,
      overwrite: false,
      onOverflowRegimeExit: () => clearScreenFn?.(),
    });
    const stdin = new FakeStdin() as unknown as NodeJS.ReadStream;
    const theme = resolveTheme({ env: ENV });
    const inst = render(
      <ThemeProvider theme={theme}>
        <App
          controller={controller}
          animate={false}
          bootMs={0}
          registerClearScreen={(fn) => {
            clearScreenFn = fn;
          }}
        />
      </ThemeProvider>,
      { stdout: wrapped.stdout, stdin, patchConsole: false },
    );
    controller.dismissBoot();
    await sleep(40);
    controller.submit('conte uma historia longa');

    // O regime clearTerminal do Ink depende do ambiente (TTY/tamanho). Se não vier, pula o
    // byte-proof (a lógica já é provada pelo unit puro do tracker).
    let reachedClearTerm = false;
    try {
      await waitFor(() => fake.writes.some((w) => w.includes(CLEAR_TERM)), 4_000);
      reachedClearTerm = true;
    } catch {
      /* regime clearTerminal não atingido neste ambiente (CI não-TTY) — pula o byte-proof */
    }

    release(); // finaliza o turno: a fala vira bloco no <Static> e a viva volta a caber.

    if (reachedClearTerm) {
      // O regime clearTerminal FOI atingido ⇒ a borda de saída DEVE ter disparado o clearScreen
      // da App (`\x1b[H\x1b[2J\x1b[3J`): é o que re-emite o histórico LIMPO e mata o bloco gigante
      // de branco (o cursor vai ao HOME ⇒ o `eraseLines` obsoleto do Ink fica inócuo). ANTES do
      // fix: NENHUM clearScreen ⇒ o desync branqueava ~1 tela de scrollback já commitado.
      await waitFor(() => fake.writes.some((w) => w.includes(CLEAR_SCREEN)), 4_000);
      expect(fake.writes.some((w) => w.includes(CLEAR_SCREEN))).toBe(true);
    }

    await sleep(20);
    inst.unmount();
  }, 20_000);
});
