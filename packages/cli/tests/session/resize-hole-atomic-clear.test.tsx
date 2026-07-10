// BURACO-NO-MEIO-RESIZE (achado do dono: "aparece um bloco de espaço VAZIO no meio da
// tela" ao AUMENTAR a largura da janela, no modo INLINE, pior com histórico grande).
//
// CAUSA-RAIZ (diagnosticada em App.tsx, `clearScreen()`): o repaint de resize (branch de
// LARGURA MUDANDO, EST-1015/RESIZE-FIX) fazia um write SÍNCRONO e CRU
// `stdout.write('\x1b[H\x1b[2J\x1b[3J')` (apaga tela+scrollback) e SÓ DEPOIS chamava
// `setStaticKey(k+1)` — o repaint REAL (Ink remontando `<Static>` + reemitindo o histórico
// inteiro) é ASSÍNCRONO, no PRÓXIMO write do Ink. Dois writes SEPARADOS no tempo: o
// terminal pode pintar o meio-termo "só apagado, nada ainda" entre eles — o buraco.
//
// FIX (`SyncStdout.primeClearOnNextFrame`, synchronized-output.ts + `App.armAtomicClear`):
// em vez do write cru imediato, o `clearScreen()` ARMA o hard-clear para ser PREPENDED ao
// PRÓXIMO write de frame do Ink (o mesmo que o `setStaticKey` dispara) — os dois viram UM
// write só, dentro do MESMO envelope `?2026`. Zero write "só apagado" ⇒ zero buraco.
//
// PROVA POR BYTES (mesma técnica de `resize-inline-gap.test.tsx`/`resize-static-dup.test.tsx`
// — `render` REAL do Ink sobre um `stdout` FAKE que captura os bytes CRUS, agora envelopado
// por `wrapStdoutWithSync` — o caminho de produção de verdade, ver `run.tsx`): construímos
// histórico GRANDE, disparamos um resize que AUMENTA a LARGURA, e afirmamos que NENHUM write
// capturado é um "clear puro" (hard-clear sem conteúdo algum) — o assinante byte a byte do
// buraco. Um segundo cenário (SEM `armAtomicClear`, reproduzindo o código ANTIGO — o
// `clearScreen()` cai no fallback de write cru quando a prop está ausente) PROVA que o
// harness de fato DETECTA o bug quando ele existe (não é um teste que passaria de qualquer
// jeito).

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

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const HEADER = 'Aluy Cli'; // item 0 do <Static> (header pinado, EST-0989)
/** O hard-clear que `clearScreen()` emite — mesma ordem H;2J;3J do F58. */
const HARD_CLEAR = '\x1b[H\x1b[2J\x1b[3J';
const BEGIN_SYNC = '\x1b[?2026h';
const END_SYNC = '\x1b[?2026l';

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
  readonly ts: number[] = [];
  write(s: string, enc?: unknown, cb?: unknown): boolean {
    this.writes.push(String(s));
    this.ts.push(Date.now());
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

/** Despe o envelope `?2026` (BSU…ESU) de um write, se presente. */
function stripSync(write: string): string {
  let s = write;
  if (s.startsWith(BEGIN_SYNC)) s = s.slice(BEGIN_SYNC.length);
  if (s.endsWith(END_SYNC)) s = s.slice(0, -END_SYNC.length);
  return s;
}

/**
 * O BYTE-PROOF central: existe algum write, no trecho `writes` fornecido, que seja um
 * "clear PURO" — o `HARD_CLEAR` (com ou sem o envelope `?2026`) SEM nenhum conteúdo real
 * junto? É EXATAMENTE o write que `clearScreen()` emitia sozinho ANTES do fix — o frame
 * "só apagado, nada ainda" que fica visível como o buraco entre o erase e o repaint.
 */
function hasBareClearWrite(writes: readonly string[]): boolean {
  return writes.some((w) => stripSync(w) === HARD_CLEAR);
}

/**
 * Monta uma sessão com histórico GRANDE (25 turnos concluídos → `<Static>` grande) sobre um
 * stdout ENVELOPADO por `wrapStdoutWithSync` (o caminho de produção real — ver `run.tsx`).
 * `wireArmAtomicClear` liga (ou não) a prop `armAtomicClear` da App ao
 * `sync.primeClearOnNextFrame` — `false` reproduz o comportamento ANTIGO (fallback de write
 * cru), p/ provar que o harness detecta a regressão quando o fix está ausente.
 */
async function buildBigHistorySession(wireArmAtomicClear: boolean): Promise<{
  inst: ReturnType<typeof render>;
  fake: FakeStdout;
  before: number;
}> {
  const controller = buildController((goal) => `resposta para: ${goal}`);

  // Terminal ALTO o bastante p/ a região viva (idle) caber em `rows` — o regime "cabe"
  // (o cotidiano; F196 é só p/ `outputHeight >= rows`, cenário diferente/já coberto).
  const fake = new FakeStdout(80, 40);
  const sync = wrapStdoutWithSync(fake as unknown as NodeJS.WriteStream, {
    sync: true,
    overwrite: true,
  });
  const stdin = new FakeStdin() as unknown as NodeJS.ReadStream;
  const theme = resolveTheme({ env: ENV });
  const inst = render(
    <ThemeProvider theme={theme}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        {...(wireArmAtomicClear
          ? { armAtomicClear: () => sync.primeClearOnNextFrame() }
          : {})}
      />
    </ThemeProvider>,
    { stdout: sync.stdout, stdin, patchConsole: false },
  );
  controller.dismissBoot();
  await sleep(40);

  // Constrói histórico GRANDE: 25 turnos concluídos sequenciais — a mesma escala do
  // BUG-GAP-CRESCENTE (`resize-inline-gap.test.tsx`), onde o gap PIORA com o histórico.
  for (let i = 0; i < 25; i++) {
    await controller.submit(`pergunta número ${i + 1} sobre o projeto`);
    await waitFor(() => controller.state.phase === 'idle' || controller.state.phase === 'done');
  }
  await sleep(60);

  const before = fake.writes.length;
  expect(fake.writes.join('').includes(HEADER)).toBe(true);
  return { inst, fake, before };
}

describe('App — resize INLINE não deixa BURACO em branco entre o erase e o repaint', () => {
  it('AUMENTAR a largura com histórico grande: nenhum write é um clear PURO (sem conteúdo)', async () => {
    const { inst, fake, before } = await buildBigHistorySession(true);

    // Redimensiona AUMENTANDO a largura (o caso relatado pelo dono) — mantém a altura
    // (só a LARGURA muda ⇒ bate no branch de resize que faz o repaint, EST-1015).
    fake.resize(140, 40);
    // Debounce do resize-effect é 90ms; dá folga generosa p/ o settle + o write do Ink.
    await sleep(300);

    const resizeWrites = fake.writes.slice(before);
    expect(resizeWrites.length).toBeGreaterThan(0); // o resize de fato disparou writes.

    // O BYTE-PROOF: nenhum write é um "clear puro" — o erase SEMPRE vem fundido com
    // conteúdo real (o repaint), nunca sozinho. É a prova de que a janela em branco
    // (o buraco) não existe mais: erase e conteúdo são o MESMO write atômico.
    expect(hasBareClearWrite(resizeWrites)).toBe(false);

    // Confirma que o resize REALMENTE disparou o hard-clear (não é um falso-positivo por
    // "o clearScreen nunca rodou").
    const writesWithClear = resizeWrites.filter((w) => stripSync(w).includes('\x1b[2J'));
    expect(writesWithClear.length).toBeGreaterThan(0);
    for (const w of writesWithClear) {
      const body = stripSync(w);
      // O `HARD_CLEAR` vem SEMPRE fundido NO INÍCIO do write — nunca como write próprio
      // (ver `hasBareClearWrite` acima) — e o `armAtomicClear` some após o 1º write, então
      // só existe UM write com o prefixo por resize-settle (a fusão é 1x, não N).
      expect(body.startsWith(HARD_CLEAR)).toBe(true);

      // O PROVA-CHAVE do "zero buraco": o CONTEÚDO real (histórico remontado, marcado pelo
      // HEADER) chega no MESMO commit síncrono do React/Ink que o erase — sem `await`/timer
      // mensurável entre eles. Isso pode se manifestar de DUAS formas, ambas válidas para o
      // fix (a fusão total é o caso IDEAL, ainda mais atômica que a fusão em dois writes):
      //   (a) o Ink funde o HEADER NO PRÓPRIO write do HARD_CLEAR (`body` já contém o
      //       HEADER) — gap = 0, nem precisa de write posterior; OU
      //   (b) o HEADER chega num write POSTERIOR, mas em ~0ms (mesmo tick de JS) — bem
      //       diferente da lacuna ASSÍNCRONA do bug antigo (write cru imediato → setState →
      //       reconciliação → PRÓXIMO write, tipicamente vários ms depois, PIOR com histórico
      //       grande).
      // Em ambos os casos, zero gap temporal mensurável ⇒ o terminal nunca tem chance de
      // pintar o meio-termo "só apagado" entre o erase e o conteúdo.
      if (!body.includes(HEADER)) {
        const idx = resizeWrites.indexOf(w);
        const nextContentIdx = resizeWrites.findIndex(
          (cand, i) => i > idx && stripSync(cand).includes(HEADER),
        );
        expect(nextContentIdx).toBeGreaterThan(idx); // existe um write com conteúdo real depois.
        const gapMs = fake.ts[before + nextContentIdx]! - fake.ts[before + idx]!;
        // Folga generosa (50ms) — bem abaixo de qualquer debounce/timer da App (90ms/500ms);
        // um gap desse tamanho só é possível se os writes forem SÍNCRONOS entre si.
        expect(gapMs).toBeLessThan(50);
      }
      // Caso `body.includes(HEADER)` seja verdadeiro, a fusão total já prova gap = 0 — nada
      // mais a checar para este write.
    }

    inst.unmount();
  }, 30_000);

  it('CONTROLE — sem armAtomicClear (código antigo) o harness DETECTA o clear puro (prova que o teste não é vácuo)', async () => {
    const { inst, fake, before } = await buildBigHistorySession(false);

    fake.resize(140, 40);
    await sleep(300);

    const resizeWrites = fake.writes.slice(before);
    // Reproduz o bug: sem a fusão, o `clearScreen()` cai no write cru imediato — um write
    // que é SÓ o hard-clear, sem nenhum conteúdo — exatamente o frame "buraco" reportado.
    expect(hasBareClearWrite(resizeWrites)).toBe(true);

    inst.unmount();
  }, 30_000);
});
