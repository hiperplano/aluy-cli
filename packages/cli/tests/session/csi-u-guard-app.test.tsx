// task #18 (🔴 CRASH) — na <App> com o GUARD instalado: a sequência CSI-u de tecla
// FUNCIONAL `\x1b[57414u` NÃO crasha o Ink E NÃO vira texto no composer.
//
// Sem o guard, `\x1b[57414u` faz o Ink crashar em `use-input.js:73`
// (`input.startsWith(undefined)`). O `installCsiUGuard` (que o run.tsx instala no
// `process.stdin` antes do render) envolve o `stdin.read()` p/ STRIPAR a seq do chunk
// ANTES do parse do Ink. Aqui montamos a App com o guard instalado no stdin-mock e
// provamos: (1) NÃO crasha; (2) o composer NÃO ganha resíduo `57414u`; (3) digitação
// normal em volta segue intacta.

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
import { installCsiUGuard } from '../../src/session/csi-u-guard.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const CRASH = '\x1b[57414u'; // a sequência que derruba o Ink (task #18).

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

async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 15));
  }
}

function mountAppWithGuard() {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  // PRODUÇÃO: o run.tsx instala o guard no `process.stdin` ANTES do render. Aqui o stdin é
  // o mock da ink-testing-library — instalamos o guard NELE (o mesmo wrap de `read()`), que
  // é o caminho que o Ink usa p/ ler o teclado. Sem isto, este teste crasharia (baseline).
  installCsiUGuard(r.stdin as unknown as { read?: () => unknown });
  controller.dismissBoot();
  return { controller, ...r };
}

describe('App — task #18: CSI-u de tecla funcional `\\x1b[57414u` NÃO crasha nem vaza', () => {
  it('AAA + `\\x1b[57414u` + BBB ⇒ composer `AAABBB`, SEM crash e SEM resíduo `57414u`', async () => {
    const { stdin, lastFrame, unmount } = mountAppWithGuard();
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    // Se o guard não estivesse instalado, este write derrubaria o Ink (uncaughtException).
    // Com o guard, a seq some no canal raw; o composer só vê `AAA`+`BBB`.
    await pressUntil(
      () => {
        stdin.write('AAA');
        stdin.write(CRASH);
        stdin.write('BBB');
      },
      () => plain(lastFrame() ?? '').includes('AAABBB'),
    );

    const frame = plain(lastFrame() ?? '');
    expect(frame).toContain('AAABBB');
    expect(frame).not.toContain('57414u');
    expect(frame).not.toContain('57414');
    unmount();
  });

  it('a sequência SOZINHA não derruba e não insere nada (composer segue vazio/limpo)', async () => {
    const { stdin, lastFrame, unmount } = mountAppWithGuard();
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    // Manda a seq isolada várias vezes — não deve crashar nem virar texto.
    for (let i = 0; i < 5; i += 1) {
      stdin.write(CRASH);
      await new Promise((r) => setTimeout(r, 10));
    }
    // Sobreviveu (chegamos aqui sem uncaughtException) e nada de `57414u` no frame.
    const frame = plain(lastFrame() ?? '');
    expect(frame).not.toContain('57414u');
    // E a digitação normal AINDA funciona depois da seq (não travou o input).
    await pressUntil(
      () => stdin.write('ok'),
      () => plain(lastFrame() ?? '').includes('ok'),
    );
    expect(plain(lastFrame() ?? '')).toContain('ok');
    unmount();
  });
});
