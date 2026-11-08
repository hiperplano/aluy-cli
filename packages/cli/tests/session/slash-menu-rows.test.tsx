// Menu `/` — mostra mais que 4 comandos quando há espaço, busca por palavra-chave PT-BR
// (tema/sair/senha) e esconde os raros e os comandos de outro modo. Revisão de UX dos menus.

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
const MENU_HEADER = 'digite para buscar';
const ROWS = 40;
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

/** Descasca a moldura à esquerda (barra `┃` do composer / `│` do <PickerFrame>) + espaços.
 * F-COMPOSER-CAIXA / F-PICKER-PAINEL — depois da reforma de UI pedida pelo dono, tanto a
 * linha do input quanto as do menu nascem com uma borda desenhada pelo Ink. */
function unframe(line: string): string {
  return line.replace(/^[\s┃│|]+/, '');
}

/** Índice (0-based) da linha do COMPOSER no frame: a do prompt ANTES do cabeçalho do
 * menu (quando aberto). O input vazio mostra o placeholder `digite um objetivo`.
 * F-COMPOSER-CAIXA — o prompt passou de `›` para `❯` e ganhou a barra `┃` na frente. */
function composerLineIndex(lastFrame: () => string | undefined): number {
  const ls = lines(lastFrame);
  const menuIdx = ls.findIndex((l) => l.includes(MENU_HEADER));
  const ceiling = menuIdx >= 0 ? menuIdx : ls.length;
  // O ÚLTIMO prompt ANTES do menu é o composer (acima dele só blocos/queue, que aqui
  // não existem na sessão idle vazia).
  for (let i = ceiling - 1; i >= 0; i--) {
    if (unframe(ls[i]!).startsWith('❯')) return i;
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
  // F-COMPOSER-CAIXA — o eco agora é `❯ x` (prompt novo), não `› x`.
  while (!plain(lastFrame() ?? '').includes('❯ x')) {
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

/** Comandos listados no menu (linhas `/nome` dentro da moldura). */
function listed(lastFrame: () => string | undefined): string[] {
  return lines(lastFrame)
    .map((l) => unframe(l).replace(/^›\s*/, ''))
    .filter((l) => /^\/[a-z-]+(\s|$)/.test(l))
    .map((l) => l.split(/\s+/)[0]!.slice(1));
}

async function mountRows(rows: number) {
  const m = await mountApp();
  (m.stdout as unknown as { rows: number }).rows = rows;
  return m;
}

describe('App — menu / (altura, busca, visibilidade)', () => {
  it('em 40 linhas o menu lista bem mais que 4 comandos (era 4 de 99)', async () => {
    const { stdin, lastFrame, unmount } = await mountRows(ROWS);
    await type(stdin, '/');
    await waitFor(() => menuOpen(lastFrame));
    expect(listed(lastFrame).length).toBeGreaterThanOrEqual(10);
    unmount();
  });

  it('a lista padrão não traz raros nem comandos de concierge', async () => {
    const { stdin, lastFrame, unmount } = await mountRows(ROWS);
    await type(stdin, '/');
    await waitFor(() => menuOpen(lastFrame));
    const l = listed(lastFrame);
    for (const hidden of [
      'rooms',
      'service',
      'upgrade',
      'window',
      'task',
      'approve',
      'deny',
      'back',
    ]) {
      expect(l).not.toContain(hidden);
    }
    unmount();
  });

  it.each([
    ['tema', 'theme'],
    ['sair', 'quit'],
    ['senha', 'secret'],
  ])('digitar /%s mostra /%s no topo', async (q, cmd) => {
    const { stdin, lastFrame, unmount } = await mountRows(ROWS);
    await type(stdin, '/' + q);
    await waitFor(() => listed(lastFrame)[0] === cmd);
    expect(listed(lastFrame)[0]).toBe(cmd);
    unmount();
  });

  it('um raro some da lista padrão mas aparece ao buscar', async () => {
    const { stdin, lastFrame, unmount } = await mountRows(ROWS);
    await type(stdin, '/sala');
    await waitFor(() => listed(lastFrame).includes('rooms'));
    expect(listed(lastFrame)).toContain('rooms');
    unmount();
  });

  it('em 24 linhas o menu ainda cabe (composer e hint visíveis, sem estourar)', async () => {
    const { stdin, lastFrame, unmount } = await mountRows(24);
    await type(stdin, '/');
    await waitFor(() => menuOpen(lastFrame));
    const ls = lines(lastFrame);
    expect(ls.length).toBeLessThanOrEqual(24);
    expect(composerLineIndex(lastFrame)).toBeGreaterThanOrEqual(0);
    unmount();
  });
});
