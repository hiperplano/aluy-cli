// F18 — Tab só COMPLETA (não executa); `/xyz` mostra "nenhum comando encontrado".

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { SlashCommand } from '../../src/slash/commands.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ANSI = new RegExp('\\x1b' + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await sleep(5);
  }
}

function mount(onCommand: (c: SlashCommand, a: string) => void) {
  const ports: ToolPorts = {
    fs: {
      async readFile() {
        return '';
      },
      async writeFile() {},
      async exists() {
        return false;
      },
    },
    shell: {
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return [];
      },
    },
  };
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: ENV })}>
      <App controller={controller} animate={false} bootMs={0} onCommand={onCommand} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return r;
}

describe('F18 — slash-menu', () => {
  it('Tab em `/mo` COMPLETA `/model` e NÃO executa o comando', async () => {
    const ran: string[] = [];
    const s = mount((c) => ran.push(c.id));
    await sleep(30);
    s.stdin.write('/mo');
    await sleep(40);
    s.stdin.write('\t');
    await sleep(80);
    expect(ran).toEqual([]);
    expect(plain(s.lastFrame())).toContain('/model');
    // Enter, aí sim, executa.
    s.stdin.write('\r');
    await waitFor(() => ran.includes('model'));
    s.unmount();
  });

  it('`/xyz` mostra "nenhum comando encontrado" (não um popup vazio)', async () => {
    const s = mount(() => {});
    await sleep(30);
    s.stdin.write('/xyz');
    await waitFor(() => plain(s.lastFrame()).includes('nenhum comando encontrado'));
    s.unmount();
  });
});
