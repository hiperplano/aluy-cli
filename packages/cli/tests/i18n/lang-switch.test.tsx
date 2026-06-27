// EST-0989 (i18n) — integração do `/lang`: a App abre o picker pela tecla, navega/
// confirma, e o <ThemeRoot> RE-RENDERIZA a árvore no idioma novo (DoD: o /lang troca +
// re-render; default pt-BR; `--lang en` via initialLang). Espelha o theme-switch.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type ModelCaller,
  type ModelCallResult,
} from '@hiperplano/aluy-cli-core';
import { ThemeRoot } from '../../src/session/ThemeRoot.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

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

const idleCaller: ModelCaller = {
  async call(): Promise<ModelCallResult> {
    return { request_id: 'r', content: '', finish_reason: 'stop' };
  },
};

function buildController(): SessionController {
  return new SessionController({
    model: idleCaller,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

const ENV = { COLORTERM: 'truecolor', LANG: 'pt_BR.UTF-8', TERM: 'xterm-256color' };
const DOWN = '\x1b[B';
const ENTER = '\r';
const ESCAPE = '\x1b';

const stripAnsi = (s: string | undefined): string =>
  (s ?? '').replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g'), '');

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('App + ThemeRoot — /lang troca o idioma em runtime', () => {
  it('default (sem initialLang) ⇒ TUI em pt-BR (placeholder pt-BR)', async () => {
    const controller = buildController();
    const { lastFrame, unmount } = render(
      <ThemeRoot
        initialTheme="aluy-dark"
        env={ENV}
        controller={controller}
        animate={false}
        bootMs={0}
      />,
    );
    controller.dismissBoot();
    await flush();
    expect(stripAnsi(lastFrame())).toContain('digite um objetivo');
    unmount();
  });

  it('initialLang=en ⇒ TUI em inglês (placeholder + hints em en)', async () => {
    const controller = buildController();
    const { lastFrame, unmount } = render(
      <ThemeRoot
        initialTheme="aluy-dark"
        env={ENV}
        initialLang="en"
        controller={controller}
        animate={false}
        bootMs={0}
      />,
    );
    controller.dismissBoot();
    await flush();
    const out = stripAnsi(lastFrame());
    expect(out).toContain('type a goal');
    expect(out).not.toContain('digite um objetivo');
    unmount();
  });

  it('/lang abre o picker, navega p/ en, confirma ⇒ onLangChanged + re-render em inglês', async () => {
    const controller = buildController();
    const changed: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <ThemeRoot
        initialTheme="aluy-dark"
        env={ENV}
        initialLang="pt-BR"
        controller={controller}
        animate={false}
        bootMs={0}
        onLangChanged={(l) => changed.push(l)}
      />,
    );
    controller.dismissBoot();
    await flush();
    // começa em pt-BR
    expect(stripAnsi(lastFrame())).toContain('digite um objetivo');

    // digita `/lang` + ENTER ⇒ abre o picker (há onSelectLang ⇒ App abre o picker)
    for (const ch of '/lang') stdin.write(ch);
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(stripAnsi(lastFrame())).toContain('trocar idioma'); // ajuda do picker (pt-BR ativo)

    // navega pt-BR → en e confirma
    stdin.write(DOWN);
    await flush();
    stdin.write(ENTER);
    await flush();

    // onLangChanged recebeu 'en'…
    expect(changed).toContain('en');
    // …e a árvore re-renderizou em INGLÊS (placeholder en; pt-BR sumiu)
    const out = stripAnsi(lastFrame());
    expect(out).toContain('type a goal');
    expect(out).not.toContain('digite um objetivo');
    unmount();
  });

  it('esc fecha o picker sem trocar (idioma segue pt-BR)', async () => {
    const controller = buildController();
    const changed: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <ThemeRoot
        initialTheme="aluy-dark"
        env={ENV}
        initialLang="pt-BR"
        controller={controller}
        animate={false}
        bootMs={0}
        onLangChanged={(l) => changed.push(l)}
      />,
    );
    controller.dismissBoot();
    await flush();

    for (const ch of '/lang') stdin.write(ch);
    await flush();
    stdin.write(ENTER); // abre o picker
    await flush();
    expect(stripAnsi(lastFrame())).toContain('trocar idioma');

    stdin.write(ESCAPE);
    await flush();
    expect(changed).toHaveLength(0); // não trocou
    expect(stripAnsi(lastFrame())).toContain('digite um objetivo'); // segue pt-BR
    unmount();
  });
});
