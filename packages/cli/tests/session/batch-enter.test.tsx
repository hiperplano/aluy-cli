// EST-0948 — BUG CRÍTICO (sessões remotas xrdp/SSH): o Enter "engolido".
//
// Causa-raiz (provada por PTY instrumentado): em sessões remotas a latência faz o
// texto e o Enter chegarem num ÚNICO chunk de stdin. O Ink entrega isso ao
// `useInput` como um `char` MULTI-caractere terminando em `\r` (ex.:
// `char="liste os arquivos\r"`) com `key.return === false`. O handler do composer
// só submetia quando `key.return === true`, então o Enter em lote era ENGOLIDO (o
// `\r` viraria texto) e NADA acontecia — a TUI ficava inutilizável p/ o usuário
// remoto.
//
// Fix: ANTES do append normal de char, detectar `\r`/`\n` embutido e SUBMETER a
// linha até a quebra. Cobertura do DoD:
//   (1) objetivo em lote (`"liste arquivos\r"` num write só) ⇒ controller.submit
//       recebe `"liste arquivos"` (o `\r` NÃO virou texto);
//   (2) slash em lote (`"/help\r"`) ⇒ executa o comando (onCommand recebe `help`);
//   (3) boot: lote chegando DURANTE o splash ⇒ não perde texto+Enter (submete);
//   (4) não-regressão: Enter LIMPO ainda submete; shift+enter ainda quebra linha;
//       digitação char-a-char segue intacta.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
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
const PLACEHOLDER = 'digite um objetivo'; // prefixo do placeholder do composer ATIVO

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

/**
 * O Ink só ATTACHA o listener de stdin num efeito pós-commit do 1º render, e a
 * stdin-mock da ink-testing-library guarda só a ÚLTIMA escrita (eventos podem se
 * perder sob escalonamento do vitest). Para um teste DETERMINÍSTICO, reescrevemos o
 * chunk até o efeito desejado aparecer. Re-escrever o lote é idempotente p/ os
 * nossos casos: após o 1º submit o composer está vazio ⇒ um `"\r"` à toa num
 * composer vazio não roteia objetivo (submit só registra 1 vez).
 */
async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito do lote não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function mountApp(opts?: {
  bootMs?: number;
  userCommands?: readonly SlashCommand[];
  onCommand?: (cmd: SlashCommand, args: string) => void;
  dismissBoot?: boolean;
}) {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App
        controller={controller}
        animate={false}
        bootMs={opts?.bootMs ?? 0}
        {...(opts?.userCommands !== undefined ? { userCommands: opts.userCommands } : {})}
        {...(opts?.onCommand !== undefined ? { onCommand: opts.onCommand } : {})}
      />
    </ThemeProvider>,
  );
  // Por padrão dispensa o boot (queremos exercitar o COMPOSER). Os casos de boot
  // passam `dismissBoot: false` p/ exercitar o splash.
  if (opts?.dismissBoot !== false) controller.dismissBoot();
  return { controller, ...r };
}

describe('App — input em LOTE (xrdp/SSH/paste): Enter grudado SUBMETE (EST-0948)', () => {
  it('(1) "liste arquivos\\r" num write só ⇒ submit recebe "liste arquivos" (o \\r não vira texto)', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    // o chunk inteiro (texto + Enter) num ÚNICO write — exatamente o que o Ink
    // entrega como `char="liste arquivos\r"` com key.return === false.
    await pressUntil(
      () => stdin.write('liste arquivos\r'),
      () => submitSpy.mock.calls.length > 0,
    );

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]?.[0]).toBe('liste arquivos');
    // garantia explícita: o `\r` NÃO virou parte do objetivo (não foi engolido como texto).
    expect(submitSpy.mock.calls[0]?.[0]).not.toContain('\r');
    submitSpy.mockRestore();
    unmount();
  });

  it('(1b) "\\n" embutido (CR/LF e paste com \\n) também submete', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    await pressUntil(
      () => stdin.write('oi responda pong\n'),
      () => submitSpy.mock.calls.length > 0,
    );

    expect(submitSpy.mock.calls[0]?.[0]).toBe('oi responda pong');
    submitSpy.mockRestore();
    unmount();
  });

  it('(1c) prefixo digitado char-a-char + cauda em lote ⇒ a linha COMPLETA submete', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    // 1ª parte digitada normalmente…
    await pressUntil(
      () => stdin.write('liste '),
      () => plain(lastFrame() ?? '').includes('liste'),
    );
    // …e a cauda chega em LOTE com o Enter grudado.
    await pressUntil(
      () => stdin.write('os arquivos\r'),
      () => submitSpy.mock.calls.length > 0,
    );

    expect(submitSpy.mock.calls[0]?.[0]).toBe('liste os arquivos');
    submitSpy.mockRestore();
    unmount();
  });

  it('(2) "/help\\r" em LOTE ⇒ EXECUTA o comando (onCommand recebe `help`, não vira texto)', async () => {
    const calls: { cmd: SlashCommand; args: string }[] = [];
    const { stdin, lastFrame, unmount } = mountApp({
      onCommand: (cmd, args) => calls.push({ cmd, args }),
    });
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    await pressUntil(
      () => stdin.write('/help\r'),
      () => calls.length > 0,
    );

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.cmd.name).toBe('help');
    unmount();
  });

  it('(3) BOOT: lote chegando DURANTE o splash NÃO perde o texto+Enter (submete)', async () => {
    // bootMs alto + sem dismiss manual: a App está MESMO no splash quando o lote chega.
    const { controller, stdin, unmount } = mountApp({
      bootMs: 100000,
      dismissBoot: false,
    });
    const submitSpy = vi.spyOn(controller, 'submit');
    // espera o splash de boot renderizar (fase boot).
    await waitFor(() => controller.current.phase === 'boot');

    await pressUntil(
      () => stdin.write('liste arquivos\r'),
      () => submitSpy.mock.calls.length > 0,
    );

    // o boot foi dispensado E o objetivo do lote NÃO se perdeu.
    expect(submitSpy.mock.calls[0]?.[0]).toBe('liste arquivos');
    expect(controller.current.phase).not.toBe('boot');
    submitSpy.mockRestore();
    unmount();
  });

  it('(3b) BOOT: texto PURO (sem Enter) durante o splash semeia o composer (não perde o char)', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp({
      bootMs: 100000,
      dismissBoot: false,
    });
    await waitFor(() => controller.current.phase === 'boot');

    // texto sem quebra: dispensa o boot E semeia no composer (a próxima tecla continua daí).
    await pressUntil(
      () => stdin.write('liste'),
      () => plain(lastFrame() ?? '').includes('liste'),
    );
    expect(plain(lastFrame() ?? '')).toContain('liste');
    expect(controller.current.phase).not.toBe('boot');
    unmount();
  });
});

describe('App — NÃO-REGRESSÃO do Enter/composer com o fix do lote (EST-0948)', () => {
  it('Enter LIMPO (char-a-char) ainda submete o objetivo digitado', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    // espera o COMPOSER ativo (boot dispensado ⇒ placeholder do composer visível).
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));

    // digita char-a-char (caminho normal, key.return chega LIMPO no fim). O fantasma
    // some no 1º char — é o sinal determinístico de que a tecla assentou.
    await pressUntil(
      () => stdin.write('o'),
      () => !plain(lastFrame() ?? '').includes(PLACEHOLDER),
    );
    await pressUntil(
      () => stdin.write('\r'),
      () => submitSpy.mock.calls.length > 0,
    );

    expect(submitSpy.mock.calls[0]?.[0]).toBe('o');
    submitSpy.mockRestore();
    unmount();
  });

  it('digitar texto SEM quebra (char-a-char) NÃO submete sozinho (só o Enter submete)', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));

    // digita 1 char — o fantasma some (assentou) mas SEM `\r`/`\n` nada submete.
    await pressUntil(
      () => stdin.write('a'),
      () => !plain(lastFrame() ?? '').includes(PLACEHOLDER),
    );
    await new Promise((r) => setTimeout(r, 50));
    // sem quebra ⇒ o detector de lote NÃO dispara; só o Enter (limpo ou em lote) submete.
    expect(submitSpy).not.toHaveBeenCalled();
    submitSpy.mockRestore();
    unmount();
  });

  it('digitação char-a-char ecoa no composer (texto digitado aparece, não some)', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));

    // 1º char some o fantasma; depois o texto digitado aparece no composer.
    await pressUntil(
      () => stdin.write('o'),
      () => !plain(lastFrame() ?? '').includes(PLACEHOLDER),
    );
    await pressUntil(
      () => stdin.write('i'),
      () => plain(lastFrame() ?? '').includes('oi'),
    );
    expect(plain(lastFrame() ?? '')).toContain('oi');
    expect(submitSpy).not.toHaveBeenCalled();
    submitSpy.mockRestore();
    unmount();
  });
});
