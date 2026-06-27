// EST-0982 (P1-1 / P1-2) — FLUXO dos pickers: o paste com `@mention` NÃO pode abrir o
// FilePicker mid-turn (preso/in-navegável) e o drain da fila NÃO pode iniciar um turno
// SOB um overlay (nem empilhar pickers). Porte EXECUTÁVEL dos repros da auditoria
// (`pickers-audit-repro.test.tsx`, branch audit-pickers) — aqui ASSERTAM o comportamento
// CORRIGIDO (falha SEM o fix, passa COM).
//
//   P1-1 — `insertPaste`→`syncPicker` só ABRE o `@`-picker em REPOUSO (idle/done). Em
//          fase de TRABALHO (thinking/streaming/retrying) o texto colado entra LITERAL
//          (sem `@` ativo); a resolução do `@` mid-turn é do dreno da fila (#278).
//   P1-2 — `queueAtRest({…, anyPickerOpen})` devolve FALSE com um picker aberto (a fila
//          PAUSA) e TRUE quando ele fecha (a fila drena) — o efeito de auto-submit da App
//          herda esse gate ⇒ o drain não inicia turno sob overlay nem empilha pickers.

import React from 'react';
import { describe, expect, it } from 'vitest';
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
import { PASTE_START, PASTE_END } from '../../src/session/bracketed-paste.js';
import { queueAtRest } from '../../src/session/model.js';
import type { FileIndexPort } from '../../src/io/index.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string | undefined): string {
  return (s ?? '').replace(ANSI, '');
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

/** Promessa adiável — controla quando o turno do modelo TERMINA. */
function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Caller que entra em STREAMING e fica VIVO até o gate resolver (agente "trabalhando"). */
function gatedCaller(opts: {
  sink: () => SessionController['sink'];
  gate: () => Promise<void>;
}): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      const sink = opts.sink();
      sink.onStart?.();
      sink.onDelta('trabalhando…');
      await opts.gate();
      sink.onDone?.();
      return { request_id: 'r', content: 'trabalhando…', finish_reason: 'stop' };
    },
  };
}

// O índice de arquivos do `@`-picker: um path distintivo p/ provar se o overlay abriu.
const PICK_PATH = 'src/xyzzy.ts';
const fileIndex: FileIndexPort = {
  async list() {
    return [PICK_PATH];
  },
};

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function buildSession() {
  const gate = defer();
  let controllerRef: SessionController | null = null;
  const model = gatedCaller({ sink: () => controllerRef!.sink, gate: () => gate.promise });
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  controllerRef = controller;
  controller.dismissBoot();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} fileIndex={fileIndex} />
    </ThemeProvider>,
  );
  return { controller, resolveGate: () => gate.resolve(), ...r };
}

// ── P1-2 — `queueAtRest` cega a picker aberto (drain mid-picker) ────────────────────
describe('EST-0982 P1-2 — queueAtRest considera picker aberto', () => {
  it('SEM picker: idle/done ⇒ atRest=true (não-regressão do drain normal)', () => {
    expect(queueAtRest({ phase: 'idle', cycleActive: false })).toBe(true);
    expect(queueAtRest({ phase: 'done', cycleActive: false })).toBe(true);
    // omitir `anyPickerOpen` = comportamento de antes (compat).
    expect(queueAtRest({ phase: 'idle', cycleActive: false, anyPickerOpen: false })).toBe(true);
  });

  it('COM picker aberto ⇒ atRest=FALSE (a fila PAUSA, não drena sob overlay)', () => {
    // Este é o gate que falta no repro da auditoria: abrir um picker NÃO muda a fase, então
    // sem o sinal a fila drenaria SOB o overlay (turno sob picker) ou empilharia um 2º picker.
    expect(queueAtRest({ phase: 'idle', cycleActive: false, anyPickerOpen: true })).toBe(false);
    expect(queueAtRest({ phase: 'done', cycleActive: false, anyPickerOpen: true })).toBe(false);
  });

  it('fecha o picker ⇒ volta a atRest=true (a fila RE-TENTA)', () => {
    // o estado re-publica ao fechar o picker ⇒ o efeito da App re-roda e drena.
    expect(queueAtRest({ phase: 'idle', cycleActive: false, anyPickerOpen: false })).toBe(true);
  });

  it('o picker NÃO atropela os freios existentes (cycleActive ainda segura)', () => {
    // não-regressão EST-0981/CLI-SEC-14: com ciclo ativo segue false mesmo sem picker.
    expect(queueAtRest({ phase: 'idle', cycleActive: true, anyPickerOpen: false })).toBe(false);
    // fase de trabalho segue false independente do picker.
    expect(queueAtRest({ phase: 'thinking', cycleActive: false, anyPickerOpen: false })).toBe(
      false,
    );
  });
});

// ── P1-1 — paste com `@mention` mid-turn NÃO abre o FilePicker ───────────────────────
describe('EST-0982 P1-1 — paste com @mention só abre o picker em repouso', () => {
  it('paste terminando em `@src/x` DURANTE o turno vivo ⇒ picker NÃO abre; texto entra LITERAL', async () => {
    const s = buildSession();
    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    // cola um trecho que termina numa @mention plausível (`@src/x`) com o agente TRABALHANDO.
    await pressUntil(
      () => s.stdin.write(`${PASTE_START}veja @src/x${PASTE_END}`),
      () => plain(s.lastFrame()).includes('@src/x'),
    );

    const frame = plain(s.lastFrame());
    // o texto colado entrou LITERAL no composer (o `@` é texto, não overlay).
    expect(frame).toContain('veja @src/x');
    // o FilePicker NÃO abriu: o path indexado (`src/xyzzy.ts`) NÃO aparece (o overlay o
    // renderiza quando aberto). Sem o fix, o overlay abria por cima do turno vivo.
    expect(frame).not.toContain('xyzzy');

    s.resolveGate();
    s.unmount();
  });

  it('paste terminando em `@src/x` em REPOUSO (idle) ⇒ picker ABRE normalmente', async () => {
    const s = buildSession();
    // NÃO submetemos nada: a sessão fica idle. O paste deve abrir o picker como sempre.
    await waitFor(() => s.controller.current.phase === 'idle');

    await pressUntil(
      () => s.stdin.write(`${PASTE_START}veja @src/x${PASTE_END}`),
      () => plain(s.lastFrame()).includes('xyzzy'),
    );

    // o overlay abriu: o path indexado aparece (hit do fuzzy de `@src/x`).
    expect(plain(s.lastFrame())).toContain('xyzzy');
    s.unmount();
  });
});
