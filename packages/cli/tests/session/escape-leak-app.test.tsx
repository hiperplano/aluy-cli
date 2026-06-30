// BUG-A (task #16) — na <App>: sequências de escape de shift+enter NÃO vazam no composer.
//
// Repro do QA: `AAA` + `\x1b[13;2u` (CSI-u shift+enter, kitty) + `BBB` deixava o buffer
// `AAA[13;2uBBB` (a cauda `[13;2u` vazava como texto). Idem `\x1b[27;2;13~` (modifyOtherKeys).
// Aqui provamos que o composer fica `AAABBB` (sem resíduo) E que um `[` DIGITADO normal
// AINDA entra (não-regressão da digitação).

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

// A stdin-mock da ink-testing-library guarda só a ÚLTIMA escrita e o listener de input pode
// anexar tarde (effect do React) ⇒ uma escrita ÚNICA pode se perder. Re-escrevemos a ação
// até a condição assentar (mesmo padrão dos testes de bracketed-paste). A condição usa
// `includes` ⇒ uma eventual duplicação por re-escrita NÃO invalida (`AAABBB` segue presente,
// e o resíduo `[13;2u` segue AUSENTE — que é o que provamos).
async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 15));
  }
}

function mountApp() {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { controller, ...r };
}

describe('App — BUG-A: sequência de escape de shift+enter NÃO vaza no composer', () => {
  it('CSI-u (`\\x1b[13;2u`) entre AAA e BBB ⇒ composer `AAABBB` (sem resíduo `[13;2u`)', async () => {
    const { stdin, lastFrame, unmount } = mountApp();
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    // Repro do QA: AAA, depois a CSI-u (shift+enter, kitty — o `\x1b` é engolido pelo Ink),
    // depois BBB. A cauda `[13;2u` NÃO deve vazar. Os 3 writes ficam SEPARADOS (como 3 sends
    // distintos do terminal), re-emitidos até assentar.
    await pressUntil(
      () => {
        stdin.write('AAA');
        stdin.write('\x1b[13;2u');
        stdin.write('BBB');
      },
      () => plain(lastFrame() ?? '').includes('AAABBB'),
    );

    const frame = plain(lastFrame() ?? '');
    expect(frame).toContain('AAABBB');
    expect(frame).not.toContain('[13;2u');
    expect(frame).not.toContain('13;2u');
    unmount();
  });

  it('modifyOtherKeys (`\\x1b[27;2;13~`) entre AAA e BBB ⇒ composer `AAABBB`', async () => {
    const { stdin, lastFrame, unmount } = mountApp();
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    await pressUntil(
      () => {
        stdin.write('AAA');
        stdin.write('\x1b[27;2;13~');
        stdin.write('BBB');
      },
      () => plain(lastFrame() ?? '').includes('AAABBB'),
    );

    const frame = plain(lastFrame() ?? '');
    expect(frame).toContain('AAABBB');
    expect(frame).not.toContain('[27;2;13~');
    expect(frame).not.toContain('27;2;13~');
    unmount();
  });

  it('NÃO-REGRESSÃO: um `[` DIGITADO normal AINDA entra no composer', async () => {
    const { stdin, lastFrame, unmount } = mountApp();
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    // `[` digitado entre letras (cada tecla é um evento próprio em raw mode, len 1) AINDA
    // entra: o filtro só engole um corpo COMPLETO de sequência (introdutor + byte final),
    // nunca um `[` solto. Provamos que `a[b` aparece no composer (o `[` não foi suprimido).
    await pressUntil(
      () => {
        stdin.write('a');
        stdin.write('[');
        stdin.write('b');
      },
      () => plain(lastFrame() ?? '').includes('a[b'),
    );

    expect(plain(lastFrame() ?? '')).toContain('a[b');
    unmount();
  });
});
