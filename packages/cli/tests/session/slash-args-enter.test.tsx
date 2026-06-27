// EST-0948 — slash-commands COM ARGUMENTOS digitados CHAR-A-CHAR não submetiam.
//
// Causa-raiz (provada por PTY char-a-char): `slashOpen` ficava `true` para QUALQUER
// input começado por `/` — inclusive `/cycle --max-iter 2 …`. Com o menu aberto, o
// handler de Enter (key.return) CONFIRMAVA a seleção do menu (que, filtrando pela
// linha inteira `cycle --max-iter 2 …`, casava NADA) em vez de SUBMETER a linha.
// Resultado: nada acontecia. (Em LOTE/paste o `\r` grudado caía no caminho do
// detector de quebra — por isso o batched passava e este caso escapava.)
//
// Fix: `slashOpen` é `true` SÓ enquanto se digita o NOME do comando — fecha no
// PRIMEIRO espaço (entrou nos args). Com o menu fechado, o Enter cai no submit
// normal do composer ⇒ `routeInput` ⇒ comando COM args.
//
// Este teste dirige a TUI CHAR-A-CHAR (cada char + o Enter em writes SEPARADOS) —
// é onde mora o bug (NÃO um write em lote com `\r` grudado).

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
// linha-âncora renderizada SÓ quando o slash-menu está aberto (ver <SlashMenu>).
const MENU_HINT = 'enter executa · esc fecha';

const ESC = String.fromCharCode(27);
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

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Pressiona o Enter (`\r`) num write SEPARADO e espera o efeito assíncrono. Re-escreve
 * só enquanto a condição não assenta; após o submit o composer já está vazio, então
 * um `\r` extra num composer vazio é no-op (não roteia objetivo) — re-escrever é
 * seguro p/ este caso de borda do escalonador.
 */
async function pressEnterUntil(
  stdin: { write: (s: string) => void },
  cond: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressEnterUntil: efeito não assentou no prazo');
    stdin.write('\r');
    await sleep(15);
  }
}

/** A linha do composer (a que tem o prompt `›`). */
function composerLine(lastFrame: () => string | undefined): string {
  return (
    plain(lastFrame() ?? '')
      .split('\n')
      .find((l) => l.includes('›')) ?? ''
  );
}

/**
 * AQUECE a attachment do stdin do Ink ANTES de digitar de verdade. O Ink só anexa o
 * listener de stdin num efeito PÓS-COMMIT do 1º render; sob o escalonador do vitest os
 * PRIMEIROS writes (char-a-char) chegam ANTES disso e SOMEM (a stdin-mock guarda só a
 * última escrita). Escrevemos um `x` REPETIDO até ele ecoar (= listener vivo) e o
 * apagamos (DEL). A partir daí cada char isolado assenta de forma determinística.
 */
async function warmup(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!composerLine(lastFrame).includes('x')) {
    if (Date.now() > deadline) throw new Error('warmup: stdin do Ink não anexou no prazo');
    stdin.write('x');
    await sleep(20);
  }
  stdin.write('\x7f'); // DEL: remove o `x` de aquecimento ⇒ composer LIMPO p/ digitar.
  await sleep(40);
}

/**
 * Digita uma string CHAR-A-CHAR — um write SEPARADO por caractere (digitação HUMANA
 * real, NÃO um write em lote com `\r` grudado). Exige `warmup()` antes (listener vivo);
 * cada char então assenta em 1 write. É exatamente o caminho onde o bug vivia: o menu
 * interceptava o Enter porque `slashOpen` seguia `true` mesmo com os args na linha.
 */
async function typeCharByChar(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await sleep(45);
  }
  await sleep(40);
}

async function mountApp(opts?: {
  userCommands?: readonly SlashCommand[];
  onCommand?: (cmd: SlashCommand, args: string) => void;
}) {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        {...(opts?.userCommands !== undefined ? { userCommands: opts.userCommands } : {})}
        {...(opts?.onCommand !== undefined ? { onCommand: opts.onCommand } : {})}
      />
    </ThemeProvider>,
  );
  controller.dismissBoot(); // exercitar o COMPOSER, não o splash.
  await waitFor(() => plain(r.lastFrame() ?? '').length > 0);
  await warmup(r.stdin, r.lastFrame); // garante o listener de stdin vivo antes de digitar.
  return { controller, ...r };
}

const menuOpen = (lastFrame: () => string | undefined): boolean =>
  plain(lastFrame() ?? '').includes(MENU_HINT);

describe('App — slash COM args (char-a-char): Enter SUBMETE a linha (EST-0948)', () => {
  it('REPRO DO BUG — `/cycle --max-iter 2 responda OK` + Enter ⇒ onCommand(cycle, args), menu fechou', async () => {
    const calls: { cmd: SlashCommand; args: string }[] = [];
    const { stdin, lastFrame, unmount } = await mountApp({
      onCommand: (cmd, args) => calls.push({ cmd, args }),
    });

    // `/cycle` (sem espaço ainda) ⇒ menu ABERTO.
    await typeCharByChar(stdin, '/cycle');
    await waitFor(() => menuOpen(lastFrame));
    expect(menuOpen(lastFrame)).toBe(true);

    // 1º ESPAÇO ⇒ entrou nos args ⇒ menu FECHA (esta é a raiz do fix).
    await typeCharByChar(stdin, ' --max-iter 2 responda OK');
    await waitFor(() => !menuOpen(lastFrame));
    expect(menuOpen(lastFrame)).toBe(false);

    // Enter LIMPO (write separado) ⇒ submit normal ⇒ routeInput ⇒ comando COM args.
    await pressEnterUntil(stdin, () => calls.length > 0);

    expect(calls.length).toBe(1);
    expect(calls[0]?.cmd.id).toBe('cycle');
    // os argumentos chegam INTEGRAIS ao handler (antes: nada chegava).
    expect(calls[0]?.args).toBe('--max-iter 2 responda OK');
    unmount();
  });

  it('`/memory editar <id> texto` (char-a-char) + Enter ⇒ onCommand(memory, "editar <id> texto")', async () => {
    const calls: { cmd: SlashCommand; args: string }[] = [];
    const { stdin, lastFrame, unmount } = await mountApp({
      onCommand: (cmd, args) => calls.push({ cmd, args }),
    });

    await typeCharByChar(stdin, '/memory');
    await waitFor(() => menuOpen(lastFrame));
    await typeCharByChar(stdin, ' editar abc um texto novo');
    await waitFor(() => !menuOpen(lastFrame));

    await pressEnterUntil(stdin, () => calls.length > 0);

    expect(calls[0]?.cmd.id).toBe('memory');
    expect(calls[0]?.args).toBe('editar abc um texto novo');
    unmount();
  });

  it('`/cycle rode pra sempre` (sem teto, char-a-char) ⇒ args chegam ao handler (a recusa é downstream)', async () => {
    // O fix garante que os args CHEGAM ao handler; a RECUSA "sem teto" é exercida no
    // controller/linear (cycle-linear.test.ts / controller-cycle.test.ts). Aqui só
    // provamos que a linha COM args submete em vez de ser engolida pelo menu.
    const calls: { cmd: SlashCommand; args: string }[] = [];
    const { stdin, lastFrame, unmount } = await mountApp({
      onCommand: (cmd, args) => calls.push({ cmd, args }),
    });

    await typeCharByChar(stdin, '/cycle');
    await waitFor(() => menuOpen(lastFrame));
    await typeCharByChar(stdin, ' rode pra sempre');
    await waitFor(() => !menuOpen(lastFrame));

    await pressEnterUntil(stdin, () => calls.length > 0);

    expect(calls[0]?.cmd.id).toBe('cycle');
    expect(calls[0]?.args).toBe('rode pra sempre');
    unmount();
  });
});

describe('App — NÃO-REGRESSÃO do slash-menu/pickers com o fix (EST-0948)', () => {
  it('`/cycle` SOZINHO (sem espaço) + Enter ⇒ CONFIRMA a seleção do menu (args VAZIOS)', async () => {
    const calls: { cmd: SlashCommand; args: string }[] = [];
    const { stdin, lastFrame, unmount } = await mountApp({
      onCommand: (cmd, args) => calls.push({ cmd, args }),
    });

    await typeCharByChar(stdin, '/cycle');
    await waitFor(() => menuOpen(lastFrame));
    expect(menuOpen(lastFrame)).toBe(true);

    // Enter com o menu ABERTO confirma o item ⇒ runCommand(cmd, '') ⇒ onCommand(cycle, '').
    await pressEnterUntil(stdin, () => calls.length > 0);
    expect(calls[0]?.cmd.id).toBe('cycle');
    expect(calls[0]?.args).toBe('');
    unmount();
  });

  it('autocomplete: `/cyc` mostra /cycle e Enter completa/roda (menu segue funcionando)', async () => {
    const calls: { cmd: SlashCommand; args: string }[] = [];
    const { stdin, lastFrame, unmount } = await mountApp({
      onCommand: (cmd, args) => calls.push({ cmd, args }),
    });

    await typeCharByChar(stdin, '/cyc');
    await waitFor(() => menuOpen(lastFrame));
    // o menu lista /cycle filtrando por "cyc".
    expect(plain(lastFrame() ?? '')).toContain('cycle');

    await pressEnterUntil(stdin, () => calls.length > 0);
    expect(calls[0]?.cmd.id).toBe('cycle');
    unmount();
  });

  // Usa `/compact` (comando SEM subcomandos): `/compact ` (trailing space) FECHA o menu.
  // (`/cycle ` não serve mais — ganhou subcomandos e o espaço ABRE o submenu, por design.)
  it('backspace REABRE o menu: `/compact ` (fechado) → apaga o espaço → `/compact` (menu de novo)', async () => {
    const { stdin, lastFrame, unmount } = await mountApp();

    await typeCharByChar(stdin, '/compact');
    await waitFor(() => menuOpen(lastFrame));
    // entra no espaço ⇒ menu FECHA. `/compact ` (trailing space) é "entrei nos args".
    await typeCharByChar(stdin, ' ');
    await waitFor(() => !menuOpen(lastFrame));
    expect(menuOpen(lastFrame)).toBe(false);
    // backspace (DEL, \x7f) remove o espaço ⇒ volta a `/compact` (sem whitespace) ⇒ menu reabre.
    stdin.write('\x7f');
    await waitFor(() => menuOpen(lastFrame));
    expect(menuOpen(lastFrame)).toBe(true);
    unmount();
  });
});
