// F161 — `/model` no backend LOCAL (BYO) NÃO abre o seletor de tiers do broker
// (Flui/Granito/… era beco sem saída: "catálogo do broker indisponível"). Em vez
// disso, uma nota orienta o caminho local (/provider · ALUY_LOCAL_MODEL / --model).

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
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');

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

function mount(backend: 'local' | undefined): ReturnType<typeof render> & {
  controller: SessionController;
} {
  const controller = new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: {
      cwd: '/proj',
      tier: 'aluy-flux',
      tokens: 0,
      windowPct: 0,
      ...(backend !== undefined ? { backend } : {}),
    },
    flush: { intervalMs: 0 },
  });
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        catalog={undefined}
        onSelectTier={undefined}
      />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { ...r, controller } as never;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('F161 — /model no backend LOCAL', () => {
  it('backend local: /model NÃO abre o seletor de tiers; mostra a nota do caminho BYO', async () => {
    const { stdin, lastFrame, controller } = mount('local');
    await flush();
    stdin.write('/model');
    await flush();
    stdin.write('\r');
    await flush();
    const f = plain(lastFrame());
    // NÃO oferece os tiers do broker…
    expect(f).not.toContain('trocar modelo');
    expect(f).not.toContain('Granito');
    // …e orienta o caminho local (nota honesta).
    expect(f).toContain('não se aplicam');
    expect(f).toContain('/provider');
    controller.dispose();
  });
});
