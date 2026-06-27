// EST-0974 — SUBCOMANDOS no slash-menu: descoberta + completação no composer.
//
// O pedido (Tiago): "no menu deveria mostrar os subcomandos tipo /mcp search". Antes o
// menu do `/` só listava os comandos top-level — os subs (`/mcp search`, `/mcp add`, …)
// não apareciam, logo não dava pra descobrir. Agora os subs são ACHATADOS como entradas
// próprias, filtráveis por substring; selecionar um sub COMPLETA `/mcp search ` no
// composer (com o espaço pra digitar o termo), em vez de executar.
//
// Este teste dirige a TUI no IDLE char-a-char (mesma mecânica do slash-args-enter):
//   • `/mcp`            → o menu lista o pai + os 4 subs (search/add/list/remove).
//   • `/mcp s`          → o menu filtra `/mcp search` (e some o `/mcp add`).
//   • ↓ até o sub + Tab → completa `/mcp search ` no composer; NÃO executa.
//   • Tab no PAI `/mcp` → drilla os subs (`/mcp ` no composer, menu aberto).
//
// FRUGAL: sem modelo (caller inerte) — só a TUI + o stdin.

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
} from '@aluy/cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { SlashCommand } from '../../src/slash/commands.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const MENU_HINT = 'enter executa · esc fecha';
const ESC = String.fromCharCode(27);
const TAB = '\t';
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
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

/** A linha do composer (a com o prompt `›`). EST-0974 — o menu agora vem ABAIXO do
 * composer (composer ANCORADO) e o selecionado também usa `›`; o input fica ANTES do
 * cabeçalho do menu (`MENU_HINT`). Fatiamos no cabeçalho e pegamos o último `›` de CIMA. */
function composerText(lastFrame: () => string | undefined): string {
  const frame = plain(lastFrame() ?? '');
  const above = frame.split(MENU_HINT)[0] ?? frame;
  const rows = above.split('\n').filter((l) => l.trimStart().startsWith('›'));
  const row = rows[rows.length - 1] ?? '';
  const text = row.replace(/^\s*›\s?/, '').trim();
  return text.startsWith('digite um objetivo') ? '' : text;
}

async function warmup(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!composerText(lastFrame).includes('x')) {
    if (Date.now() > deadline) throw new Error('warmup: stdin do Ink não anexou no prazo');
    stdin.write('x');
    await sleep(20);
  }
  stdin.write('\x7f');
  await sleep(40);
}

async function typeCharByChar(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await sleep(45);
  }
  await sleep(40);
}

async function tap(stdin: { write: (s: string) => void }, seq: string): Promise<void> {
  stdin.write(seq);
  await sleep(50);
}

async function mountApp(opts?: { onCommand?: (cmd: SlashCommand, args: string) => void }) {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        {...(opts?.onCommand !== undefined ? { onCommand: opts.onCommand } : {})}
      />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  await waitFor(() => plain(r.lastFrame() ?? '').length > 0);
  await warmup(r.stdin, r.lastFrame);
  return { controller, ...r };
}

const menuOpen = (lastFrame: () => string | undefined): boolean =>
  plain(lastFrame() ?? '').includes(MENU_HINT);

/** A entrada SELECIONADA do menu (a linha `› /…`), só o caminho (`mcp`, `mcp search`).
 * EST-0974 — o menu está ABAIXO do composer; o input digitado (`› /mcp`) também casa `› /`.
 * Procuramos só DEPOIS do cabeçalho do menu (`MENU_HINT`), onde moram os itens. */
function selectedPath(lastFrame: () => string | undefined): string | null {
  const frame = plain(lastFrame() ?? '');
  const idx = frame.indexOf(MENU_HINT);
  const below = idx >= 0 ? frame.slice(idx) : frame;
  const row = below.split('\n').find((l) => l.trimStart().startsWith('› /'));
  if (!row) return null;
  // O caminho usa UM espaço entre pai e sub; o summary vem após ≥2 espaços (a coluna).
  // Captura `/<caminho>` até o gap de 2+ espaços, e tira a barra.
  const m = row.replace(/^\s*›\s+/, '').match(/^\/(\S+(?: \S+)?)(?:\s{2,}|$)/);
  return m ? m[1]! : null;
}

describe('App — subcomandos no slash-menu (EST-0974, idle)', () => {
  it('`/mcp` ⇒ o menu LISTA os 4 subs (search/add/list/remove)', async () => {
    const { stdin, lastFrame, unmount } = await mountApp();

    await typeCharByChar(stdin, '/mcp');
    await waitFor(() => menuOpen(lastFrame));
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('/mcp search');
    expect(out).toContain('/mcp add');
    expect(out).toContain('/mcp list');
    expect(out).toContain('/mcp remove');
    unmount();
  });

  it('`/mcp s` ⇒ o menu FILTRA `/mcp search` (e some o `/mcp add`)', async () => {
    const { stdin, lastFrame, unmount } = await mountApp();

    await typeCharByChar(stdin, '/mcp s');
    // `/mcp ` mantém o menu aberto (pai com subs); `s` filtra o sub.
    await waitFor(() => menuOpen(lastFrame) && plain(lastFrame() ?? '').includes('/mcp search'));
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('/mcp search');
    expect(out).not.toContain('/mcp add');
    unmount();
  });

  it('Tab num SUBcomando ⇒ COMPLETA `/mcp search ` no composer (não executa)', async () => {
    const calls: { cmd: SlashCommand; args: string }[] = [];
    const { stdin, lastFrame, unmount } = await mountApp({
      onCommand: (cmd, args) => calls.push({ cmd, args }),
    });

    // Filtra direto o sub `search` (só ele casa `/mcp s` no menu) e seleciona-o.
    await typeCharByChar(stdin, '/mcp s');
    await waitFor(() => menuOpen(lastFrame) && plain(lastFrame() ?? '').includes('/mcp search'));
    // o topo filtrado é o `/mcp search` (único match de `mcp s`).
    await waitFor(() => selectedPath(lastFrame) === 'mcp search');

    await tap(stdin, TAB);
    // Composer = `/mcp search ` (com o espaço pra digitar o termo); menu FECHADO; sem execução.
    await waitFor(() => composerText(lastFrame) === '/mcp search');
    expect(composerText(lastFrame)).toBe('/mcp search');
    expect(menuOpen(lastFrame)).toBe(false);
    expect(calls.length).toBe(0);
    unmount();
  });

  it('Tab no PAI `/mcp` ⇒ DRILLA os subs (`/mcp ` no composer, menu segue aberto)', async () => {
    const { stdin, lastFrame, unmount } = await mountApp();

    await typeCharByChar(stdin, '/mcp');
    await waitFor(() => menuOpen(lastFrame));
    // o 1º item (selecionado) é o PAI `/mcp`.
    await waitFor(() => selectedPath(lastFrame) === 'mcp');

    await tap(stdin, TAB);
    // completa `/mcp ` (com espaço): o menu REVELA os subs e segue aberto.
    await waitFor(() => composerText(lastFrame) === '/mcp');
    expect(menuOpen(lastFrame)).toBe(true);
    expect(plain(lastFrame() ?? '')).toContain('/mcp search');
    unmount();
  });

  it('digitar `/mcp search github` + completar o termo manualmente FECHA o menu (args)', async () => {
    const { stdin, lastFrame, unmount } = await mountApp();

    await typeCharByChar(stdin, '/mcp search');
    await waitFor(() => menuOpen(lastFrame));
    // o 2º espaço (termo) entra nos ARGS do sub ⇒ menu fecha.
    await typeCharByChar(stdin, ' github');
    await waitFor(() => !menuOpen(lastFrame));
    expect(menuOpen(lastFrame)).toBe(false);
    unmount();
  });
});
