// EST-0966 — integração do `/theme`: a App abre o picker pela tecla, navega/confirma,
// e o <ThemeRoot> RE-RENDERIZA a árvore com a paleta nova (DoD: a paleta muda; os
// componentes leem os 7 papéis ⇒ repintam de uma vez).

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

// truecolor env: as cores saem como ANSI `38;2;R;G;B` (dá p/ comparar a paleta).
const ENV = { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const DOWN = '\x1b[B';
const ENTER = '\r';

async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('App + ThemeRoot — /theme troca a paleta em runtime', () => {
  it('abre o picker, navega p/ light, confirma ⇒ chama onSelectTheme e repinta', async () => {
    const controller = buildController();
    const selected: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <ThemeRoot
        initialTheme="aluy-dark"
        env={ENV}
        controller={controller}
        animate={false}
        bootMs={0}
        onThemeChanged={(name) => selected.push(name)}
      />,
    );
    controller.dismissBoot();
    await flush();

    // antes da troca: a paleta DARK pinta o accent #DDA13F (221;161;63).
    expect(lastFrame()).toContain('221;161;63');

    // digita `/theme` e ENTER ⇒ abre o picker (há onSelectTheme ⇒ App abre o picker).
    for (const ch of '/theme') stdin.write(ch);
    await flush();
    stdin.write(ENTER);
    await flush();
    // o picker está aberto: a dica aparece.
    expect(lastFrame()).toContain('trocar tema');

    // navega dark → light e confirma.
    stdin.write(DOWN);
    await flush();
    stdin.write(ENTER);
    await flush();

    // onThemeChanged recebeu aluy-light…
    expect(selected).toContain('aluy-light');
    // …e a árvore repintou: agora aparece o accent LIGHT #82530F (130;83;15).
    expect(lastFrame()).toContain('130;83;15');
    // e o accent dark não é mais a cor dominante do composer/onboarding.
    unmount();
  });

  it('esc fecha o picker sem trocar (paleta segue dark)', async () => {
    const controller = buildController();
    const selected: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <ThemeRoot
        initialTheme="aluy-dark"
        env={ENV}
        controller={controller}
        animate={false}
        bootMs={0}
        onThemeChanged={(name) => selected.push(name)}
      />,
    );
    controller.dismissBoot();
    await flush();

    for (const ch of '/theme') stdin.write(ch);
    await flush();
    stdin.write(ENTER); // abre o picker
    await flush();
    expect(lastFrame()).toContain('trocar tema');

    stdin.write('\x1b'); // esc
    await flush();
    expect(selected).toHaveLength(0); // não trocou
    expect(lastFrame()).toContain('221;161;63'); // segue dark
    unmount();
  });

  it('inicia em LIGHT quando o initialTheme é aluy-light (auto-detecção → light)', async () => {
    const controller = buildController();
    const { lastFrame, unmount } = render(
      <ThemeRoot
        initialTheme="aluy-light"
        env={ENV}
        controller={controller}
        animate={false}
        bootMs={0}
      />,
    );
    controller.dismissBoot();
    await flush();
    expect(lastFrame()).toContain('130;83;15'); // accent light desde o boot
    unmount();
  });
});
