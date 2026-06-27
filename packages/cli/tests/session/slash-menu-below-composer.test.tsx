// EST-0974 — o slash-menu (e os pickers de `/`) abrem ABAIXO do composer, ANCORADO.
//
// O pedido (Tiago): "as opções do menu não poderiam aparecer embaixo pra o composer
// deixar de ficar subindo e descendo?". Antes o <SlashMenu> renderizava ACIMA do
// composer: abrir/filtrar (o menu cresce/encolhe) MUDAVA a linha vertical do input —
// ele "subia e descia". Agora o composer é o PONTO FIXO e o menu cresce PRA BAIXO.
//
// Este teste PROVA (FRUGAL, sem modelo — caller inerte, idle, char-a-char):
//   • abrir `/`  ⇒ o menu (cabeçalho `/ para comandos`) aparece DEPOIS da linha do
//     composer no frame (ABAIXO), nunca antes;
//   • a LINHA do composer NÃO MUDA de índice ao abrir o menu (ancorado) — o mesmo
//     índice com o menu fechado e aberto;
//   • FILTRAR (`/mc`) encolhe o menu PRA BAIXO sem mexer o índice do composer.

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

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const MENU_HEADER = '/ para comandos';
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await sleep(5);
  }
}

/** Linhas do frame, em texto puro (sem ANSI). */
function lines(lastFrame: () => string | undefined): string[] {
  return plain(lastFrame() ?? '').split('\n');
}

/** Índice (0-based) da linha do COMPOSER no frame: a do prompt `›` ANTES do cabeçalho do
 * menu (quando aberto). O input vazio mostra o placeholder `digite um objetivo`. */
function composerLineIndex(lastFrame: () => string | undefined): number {
  const ls = lines(lastFrame);
  const menuIdx = ls.findIndex((l) => l.includes(MENU_HEADER));
  const ceiling = menuIdx >= 0 ? menuIdx : ls.length;
  // O ÚLTIMO prompt `›` ANTES do menu é o composer (acima dele só blocos/queue, que aqui
  // não existem na sessão idle vazia).
  for (let i = ceiling - 1; i >= 0; i--) {
    if (ls[i]!.trimStart().startsWith('›')) return i;
  }
  return -1;
}

const menuOpen = (lastFrame: () => string | undefined): boolean =>
  plain(lastFrame() ?? '').includes(MENU_HEADER);

async function warmup(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
): Promise<void> {
  const deadline = Date.now() + 2000;
  // Escreve `x` até ecoar na linha do composer (listener do Ink anexou), depois apaga.
  while (!plain(lastFrame() ?? '').includes('› x')) {
    if (Date.now() > deadline) throw new Error('warmup: stdin do Ink não anexou no prazo');
    stdin.write('x');
    await sleep(20);
  }
  stdin.write('\x7f');
  await sleep(40);
}

async function type(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await sleep(45);
  }
  await sleep(40);
}

async function mountApp() {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  await waitFor(() => plain(r.lastFrame() ?? '').length > 0);
  await warmup(r.stdin, r.lastFrame);
  return { controller, ...r };
}

describe('App — o slash-menu abre ABAIXO do composer, ANCORADO (EST-0974)', () => {
  it('abrir `/` ⇒ o cabeçalho do menu aparece DEPOIS (abaixo) da linha do composer', async () => {
    const { stdin, lastFrame, unmount } = await mountApp();

    await type(stdin, '/');
    await waitFor(() => menuOpen(lastFrame));

    const ls = lines(lastFrame);
    const composerIdx = composerLineIndex(lastFrame);
    const menuHeaderIdx = ls.findIndex((l) => l.includes(MENU_HEADER));

    expect(composerIdx).toBeGreaterThanOrEqual(0);
    expect(menuHeaderIdx).toBeGreaterThanOrEqual(0);
    // O menu está ABAIXO do composer (índice maior = mais embaixo no frame).
    expect(menuHeaderIdx).toBeGreaterThan(composerIdx);

    unmount();
  });

  it('a linha do composer NÃO MUDA de índice ao ABRIR o menu (ancorado)', async () => {
    const { stdin, lastFrame, unmount } = await mountApp();

    // Fechado: índice do composer.
    expect(menuOpen(lastFrame)).toBe(false);
    const idxClosed = composerLineIndex(lastFrame);
    expect(idxClosed).toBeGreaterThanOrEqual(0);

    // Abre o menu com `/`.
    await type(stdin, '/');
    await waitFor(() => menuOpen(lastFrame));
    const idxOpen = composerLineIndex(lastFrame);

    // O composer ficou ANCORADO: mesma linha aberto vs fechado.
    expect(idxOpen).toBe(idxClosed);

    unmount();
  });

  it('FILTRAR (`/mc`) encolhe o menu PRA BAIXO sem mover a linha do composer', async () => {
    const { stdin, lastFrame, unmount } = await mountApp();
    const idxClosed = composerLineIndex(lastFrame);

    // `/` abre cheio.
    await type(stdin, '/');
    await waitFor(() => menuOpen(lastFrame));
    const idxOpenFull = composerLineIndex(lastFrame);

    // `mc` filtra — o menu encolhe (menos entradas) PRA BAIXO.
    await type(stdin, 'mc');
    await waitFor(() => menuOpen(lastFrame));
    const idxFiltered = composerLineIndex(lastFrame);

    // O composer NÃO se moveu em nenhuma transição (fechado → aberto → filtrado).
    expect(idxOpenFull).toBe(idxClosed);
    expect(idxFiltered).toBe(idxClosed);

    // E o menu segue ABAIXO do composer após o filtro.
    const ls = lines(lastFrame);
    const menuHeaderIdx = ls.findIndex((l) => l.includes(MENU_HEADER));
    expect(menuHeaderIdx).toBeGreaterThan(idxFiltered);

    unmount();
  });

  it('esc FECHA o menu e o composer permanece na MESMA linha (ancorado de volta)', async () => {
    const { stdin, lastFrame, unmount } = await mountApp();
    const idxClosed = composerLineIndex(lastFrame);

    await type(stdin, '/');
    await waitFor(() => menuOpen(lastFrame));

    stdin.write(ESC);
    await waitFor(() => !menuOpen(lastFrame));
    const idxAfterClose = composerLineIndex(lastFrame);

    expect(idxAfterClose).toBe(idxClosed);

    unmount();
  });
});
