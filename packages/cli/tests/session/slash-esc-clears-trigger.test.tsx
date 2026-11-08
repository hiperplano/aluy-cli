// Esc no menu `/`: fecha o menu e, se o composer tem SÓ o gatilho `/`, limpa-o (como o Claude
// Code). Com `/mod…` o texto fica.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { PolicyPermissionEngine, type ToolPorts } from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ANSI = new RegExp('\\x1b' + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ESC = '\x1b';

function mount() {
  const ports: ToolPorts = {
    fs: { readFile: async () => '', writeFile: async () => {}, exists: async () => false },
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    search: { search: async () => [] },
  };
  const controller = new SessionController({
    model: { call: async () => ({ request_id: 'r', content: '', finish_reason: 'stop' }) },
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: ENV })}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return r;
}
const composerLine = (f: string | undefined): string =>
  plain(f)
    .split('\n')
    .find((l) => l.includes('❯')) ?? '';

describe('Esc no menu `/`', () => {
  it('só `/`: Esc fecha o menu e LIMPA o composer', async () => {
    const s = mount();
    await sleep(40);
    s.stdin.write('/');
    await sleep(80);
    expect(plain(s.lastFrame())).toContain('para comandos');
    s.stdin.write(ESC);
    await sleep(120);
    expect(plain(s.lastFrame())).not.toContain('para comandos');
    expect(composerLine(s.lastFrame())).toContain('digite um objetivo'); // vazio: placeholder
    s.unmount();
  });

  it('`/mod`: Esc fecha o menu e MANTÉM o texto', async () => {
    const s = mount();
    await sleep(40);
    s.stdin.write('/mod');
    await sleep(80);
    s.stdin.write(ESC);
    await sleep(120);
    expect(plain(s.lastFrame())).not.toContain('para comandos');
    expect(composerLine(s.lastFrame())).toContain('/mod');
    s.unmount();
  });
});
