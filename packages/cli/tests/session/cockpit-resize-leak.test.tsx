// EST-1000 · ADR-0076 §2/§5/§6 — REGRESSÃO do RESIZE AO VIVO do MODO COCKPIT.
//
// Dois bugs P1 (quebra-uso) achados por auditoria do cockpit/fullscreen (alt-screen):
//   P1-A — encolher ABAIXO do piso (`<80col`=narrow OU `rows<COCKPIT_MIN_ROWS`=short) com o
//          cockpit ativo deixava o alt-screen PRESO: `cockpitActive` virava false e a App
//          caía pro inline, mas `leave()` (`?1049l`) NUNCA era chamado ⇒ terminal preso na
//          tela alternativa (scrollback/tela primária não voltam).
//   P1-B — voltar a caber re-montava o <Cockpit> SEM re-armar o alt-screen/differ (enter()
//          nunca rodava de novo ⇒ `?1049h` não re-armado + differ com buffer stale).
//   P2-D — (defensivo) o cockpit CONTINUANDO a caber numa dimensão NOVA: o differ comparava
//          frames de larguras diferentes (lixo). O fix reseta o differ (`resetDiffer`).
//
// Estes testes dirigem a <App> REAL com um stdout controlável (EventEmitter-backed) cujos
// `rows`/`columns` mudam em runtime + emitem `resize` (o que ink-testing-library, columns
// fixo, e os PTY tests, sem resize, não fazem). Portados dos repros da auditoria.
//
// scrub CI ANTES de importar ink (senão o Ink desliga o render no runner — classe #149).
import './_scrub-ci-env.js';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
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

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

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

function inertCaller(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
}

function buildController(): SessionController {
  return new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

/**
 * Um stdout FAKE controlável: captura os writes, expõe `rows`/`columns` MUTÁVEIS e
 * EMITE `resize` (o que o Ink escuta p/ re-renderizar). Diferente do stub do cockpit-diff
 * (rows/cols fixos): aqui MUDAMOS a janela em runtime.
 */
function makeResizableStdout(rows: number, columns: number) {
  const ee = new EventEmitter();
  const writes: string[] = [];
  const stream = Object.assign(ee, {
    columns,
    rows,
    isTTY: true,
    write(chunk: string): boolean {
      writes.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    },
  }) as unknown as NodeJS.WriteStream & { columns: number; rows: number };
  const resize = (r: number, c: number): void => {
    (stream as { rows: number }).rows = r;
    (stream as { columns: number }).columns = c;
    ee.emit('resize');
  };
  return { stream, writes, resize };
}

/**
 * Um STDIN fake-TTY que NUNCA termina. Sem ele, `render` (do `ink`) usa o `process.stdin`,
 * que sob o runner NÃO é um TTY ⇒ o `<App>` interno do Ink não consegue entrar em raw-mode
 * e se DESMONTA logo no mount (handleExit) — o que removeria o listener de `resize` antes do
 * teste emitir. Com este stdin TTY estável, a App permanece montada e reage ao resize.
 */
function makeTtyStdin(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as NodeJS.ReadStream & {
    isTTY: boolean;
    setRawMode: () => unknown;
  };
  Object.assign(s, {
    isTTY: true,
    setRawMode: () => s,
    setEncoding: () => s,
    resume: () => s,
    pause: () => s,
    ref: () => s,
    unref: () => s,
    read: () => null,
  });
  return s;
}

function makeScreen() {
  const enter = vi.fn();
  const leave = vi.fn();
  const resetDiffer = vi.fn();
  return { enter, leave, resetDiffer, cockpitScreen: { enter, leave, resetDiffer } };
}

describe('cockpit — resize ABAIXO do piso chama leave() (P1-A: alt-screen NÃO vaza)', () => {
  it('cockpit ativo (100×30) → narrow (50col) ⇒ leave() é chamado (sai do alt-screen)', async () => {
    const controller = buildController();
    const theme = resolveTheme({ env: ENV });
    const { enter, leave, cockpitScreen } = makeScreen();
    const { stream, resize } = makeResizableStdout(30, 100);

    const inst = render(
      <ThemeProvider theme={theme}>
        <App
          controller={controller}
          animate={false}
          bootMs={0}
          initialFullscreen
          cockpitEnteredAtBoot
          cockpitScreen={cockpitScreen}
        />
      </ThemeProvider>,
      { stdout: stream, stdin: makeTtyStdin(), exitOnCtrlC: false, patchConsole: false },
    );
    controller.dismissBoot();
    await tick();
    enter.mockClear();
    leave.mockClear();

    // ENCOLHE p/ 50 colunas (< COCKPIT_MIN_COLS=80) ⇒ o layout RECUSA (narrow). O fix SAI do
    // alt-screen (leave()), mantendo `fullscreen` ON p/ re-entrar quando voltar a caber.
    resize(30, 50);
    await tick();

    inst.unmount();
    controller.dispose();

    expect(leave, 'resize abaixo do piso deve sair do alt-screen (leave())').toHaveBeenCalled();
  });

  it('cockpit ativo (100×30) → short (poucas linhas) ⇒ leave() é chamado', async () => {
    const controller = buildController();
    const theme = resolveTheme({ env: ENV });
    const { enter, leave, cockpitScreen } = makeScreen();
    const { stream, resize } = makeResizableStdout(30, 100);

    const inst = render(
      <ThemeProvider theme={theme}>
        <App
          controller={controller}
          animate={false}
          bootMs={0}
          initialFullscreen
          cockpitEnteredAtBoot
          cockpitScreen={cockpitScreen}
        />
      </ThemeProvider>,
      { stdout: stream, stdin: makeTtyStdin(), exitOnCtrlC: false, patchConsole: false },
    );
    controller.dismissBoot();
    await tick();
    enter.mockClear();
    leave.mockClear();

    // poucas linhas (< COCKPIT_MIN_ROWS) ⇒ recusa `short`. Mesma saída de alt-screen.
    resize(4, 100);
    await tick();

    inst.unmount();
    controller.dispose();

    expect(leave, 'resize curto deve sair do alt-screen (leave())').toHaveBeenCalled();
  });
});

describe('cockpit — voltar a caber re-arma o alt-screen/differ (P1-B: enter() re-chamado)', () => {
  it('narrow → volta a caber: enter() é re-chamado (re-arma ?1049h + reseta o differ)', async () => {
    const controller = buildController();
    const theme = resolveTheme({ env: ENV });
    const { enter, leave, cockpitScreen } = makeScreen();
    const { stream, resize } = makeResizableStdout(30, 100);

    const inst = render(
      <ThemeProvider theme={theme}>
        <App
          controller={controller}
          animate={false}
          bootMs={0}
          initialFullscreen
          cockpitEnteredAtBoot
          cockpitScreen={cockpitScreen}
        />
      </ThemeProvider>,
      { stdout: stream, stdin: makeTtyStdin(), exitOnCtrlC: false, patchConsole: false },
    );
    controller.dismissBoot();
    await tick();

    resize(30, 50); // narrow ⇒ inline + leave()
    await tick();
    expect(leave).toHaveBeenCalled();
    enter.mockClear();

    resize(30, 100); // de volta a caber ⇒ re-entra no cockpit
    await tick();

    inst.unmount();
    controller.dispose();

    expect(
      enter,
      'voltar a caber deve re-entrar no cockpit (enter() re-arma ?1049h + differ)',
    ).toHaveBeenCalled();
  });
});

// NOTA (EST-1015): o bug "tela EM BRANCO na re-entrada" (fullscreen → encolhe <80col → cresce
// de volta) é de ORDENAÇÃO do differ REAL (o frame do resize é pintado contra `prevLines` STALE
// ANTES do effect resetar o differ; em repouso nenhum render novo dispara ⇒ alt-screen preto). O
// fix força um repaint após o enter(). Como aqui o `cockpitScreen` é MOCK (sem differ real), esse
// caminho não é observável — a prova não-tautológica vive em `cockpit-reentry-pty.test.ts` (PTY
// real + binário + SIGWINCH). O P1-B acima já cobre que `enter()` é re-chamado na re-entrada.

describe('cockpit — resize-em-tamanho reseta o differ (P2-D defensivo)', () => {
  it('cockpit continua cabendo, mas as colunas mudam ⇒ resetDiffer() é chamado', async () => {
    const controller = buildController();
    const theme = resolveTheme({ env: ENV });
    const { enter, leave, resetDiffer, cockpitScreen } = makeScreen();
    const { stream, resize } = makeResizableStdout(30, 100);

    const inst = render(
      <ThemeProvider theme={theme}>
        <App
          controller={controller}
          animate={false}
          bootMs={0}
          initialFullscreen
          cockpitEnteredAtBoot
          cockpitScreen={cockpitScreen}
        />
      </ThemeProvider>,
      { stdout: stream, stdin: makeTtyStdin(), exitOnCtrlC: false, patchConsole: false },
    );
    controller.dismissBoot();
    await tick();
    enter.mockClear();
    leave.mockClear();
    resetDiffer.mockClear();

    // 120 col continua cabendo (≥80) e 30 linhas continuam OK ⇒ NÃO sai nem re-entra; só
    // reseta o differ p/ não comparar frames de larguras diferentes (lixo).
    resize(30, 120);
    await tick();

    inst.unmount();
    controller.dispose();

    expect(leave, 'continua cabendo: não deve sair do alt-screen').not.toHaveBeenCalled();
    expect(enter, 'continua cabendo: não deve re-entrar').not.toHaveBeenCalled();
    expect(
      resetDiffer,
      'resize-em-tamanho deve resetar o differ (full-paint na dimensão nova)',
    ).toHaveBeenCalled();
  });
});
