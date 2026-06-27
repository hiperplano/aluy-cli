// EST-0983 (#157 fix) — `/clear full` e `/clear memory` SUBMETEM com Enter (sem precisar
// do espaço-final). O pedido (Tiago/QA): são VERBOS TERMINAIS, sem argumento — o Enter no
// menu deve EXECUTAR (`/clear full` ⇒ pede confirmação), não ficar preso re-completando
// `/clear full ●`. Subs que DE FATO pedem argumento (`/mcp search <termo>`) NÃO regridem:
// o Enter ainda completa e aguarda o termo.
//
// Dirige a TUI no IDLE char-a-char (mesma mecânica do slash-subcommands-menu), com um spy
// em `onCommand` p/ provar que o Enter ROTEOU o comando (`clear` + arg `full`/`memory`).
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
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { SlashCommand } from '../../src/slash/commands.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const MENU_HINT = 'enter executa · esc fecha';
const ESC = String.fromCharCode(27);
const ENTER = '\r';
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
  await sleep(60);
}

const menuOpen = (lastFrame: () => string | undefined): boolean =>
  plain(lastFrame() ?? '').includes(MENU_HINT);

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

describe('App — `/clear full|memory` SUBMETEM com Enter (subcomando terminal)', () => {
  it('`/clear full` + Enter (SEM espaço) ROTEIA o comando clear com arg `full`', async () => {
    const calls: { cmd: SlashCommand; args: string }[] = [];
    const { stdin, lastFrame, unmount } = await mountApp({
      onCommand: (cmd, args) => calls.push({ cmd, args }),
    });

    await typeCharByChar(stdin, '/clear full');
    // o menu fica aberto (1 espaço tolerado em comandos COM subs) e filtra `/clear full`.
    await waitFor(() => menuOpen(lastFrame) && plain(lastFrame() ?? '').includes('/clear full'));

    await tap(stdin, ENTER);
    // Enter SUBMETE: onCommand chamado com o comando `clear` + arg `full` (não re-completou).
    await waitFor(() => calls.length === 1);
    expect(calls[0]!.cmd.id).toBe('clear');
    expect(calls[0]!.args).toBe('full');
    // o composer ESVAZIOU e o menu FECHOU (submeteu, não ficou preso).
    expect(composerText(lastFrame)).toBe('');
    expect(menuOpen(lastFrame)).toBe(false);
    unmount();
  });

  it('`/clear memory` + Enter (SEM espaço) ROTEIA o comando clear com arg `memory`', async () => {
    const calls: { cmd: SlashCommand; args: string }[] = [];
    const { stdin, lastFrame, unmount } = await mountApp({
      onCommand: (cmd, args) => calls.push({ cmd, args }),
    });

    await typeCharByChar(stdin, '/clear memory');
    await waitFor(() => menuOpen(lastFrame) && plain(lastFrame() ?? '').includes('/clear memory'));

    await tap(stdin, ENTER);
    await waitFor(() => calls.length === 1);
    expect(calls[0]!.cmd.id).toBe('clear');
    expect(calls[0]!.args).toBe('memory');
    unmount();
  });

  it('`/clear` puro + Enter SUBMETE (sem sub) — não regride', async () => {
    const calls: { cmd: SlashCommand; args: string }[] = [];
    const { stdin, lastFrame, unmount } = await mountApp({
      onCommand: (cmd, args) => calls.push({ cmd, args }),
    });

    await typeCharByChar(stdin, '/clear');
    await waitFor(() => menuOpen(lastFrame));
    // o 1º item selecionado é o PAI `/clear` (comando-folha-com-subs); Enter no pai EXECUTA.
    await tap(stdin, ENTER);
    await waitFor(() => calls.length === 1);
    expect(calls[0]!.cmd.id).toBe('clear');
    expect(calls[0]!.args).toBe('');
    unmount();
  });

  it('`/mcp search` + Enter NÃO submete (pede argumento) — completa e aguarda o termo', async () => {
    const calls: { cmd: SlashCommand; args: string }[] = [];
    const { stdin, lastFrame, unmount } = await mountApp({
      onCommand: (cmd, args) => calls.push({ cmd, args }),
    });

    await typeCharByChar(stdin, '/mcp search');
    await waitFor(() => menuOpen(lastFrame) && plain(lastFrame() ?? '').includes('/mcp search'));

    await tap(stdin, ENTER);
    // Enter COMPLETA `/mcp search ` (aguarda o termo); NÃO roteou nada.
    await waitFor(() => composerText(lastFrame) === '/mcp search');
    expect(calls.length).toBe(0);
    unmount();
  });
});
