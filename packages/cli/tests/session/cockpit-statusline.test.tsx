// Rodapé (`/statusline`, F2) dentro do `/fullscreen` (cockpit): os 3 modos full|compact|hidden
// mudam o painel de status e a linha de hints; `hidden` mantém o `⚠ yolo`; F2 e `/statusline`
// ciclam também no cockpit. Sem modelo (ink-testing-library).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { PolicyPermissionEngine, type ToolPorts } from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { StatuslineMode } from '../../src/io/user-config.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');
const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

beforeEach(() => vi.stubEnv('ALUY_FULLSCREEN', '1'));
afterEach(() => vi.unstubAllEnvs());

function ports(): ToolPorts {
  return {
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
  } as ToolPorts;
}

function mount(opts: { statusline?: StatuslineMode; unsafe?: boolean }) {
  const controller = new SessionController({
    model: {
      async call() {
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
      },
    },
    permission: new PolicyPermissionEngine({ mode: opts.unsafe ? 'unsafe' : 'normal' }),
    ports: ports(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 1200, windowPct: 4 },
    flush: { intervalMs: 0 },
  });
  controller.dismissBoot();
  const onStatuslineChange = vi.fn();
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: ENV })}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        initialFullscreen
        {...(opts.statusline !== undefined ? { initialStatusline: opts.statusline } : {})}
        onStatuslineChange={onStatuslineChange}
      />
    </ThemeProvider>,
  );
  return { controller, onStatuslineChange, ...r };
}

async function esperar(cond: () => boolean, ms = 2000): Promise<void> {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error('esperar: não assentou');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const HINTS = 'tab foca';

describe('cockpit — rodapé nos 3 modos', () => {
  it('full: painel de status inteiro + hints do cockpit', async () => {
    const { lastFrame, unmount } = mount({ statusline: 'full' });
    await esperar(() => plain(lastFrame()).includes('conversa'));
    const f = plain(lastFrame());
    expect(f).toContain('estado');
    expect(f).toContain(HINTS);
    unmount();
  });

  it('compact: UMA linha (% janela) no lugar do painel; hints seguem', async () => {
    const { lastFrame, unmount } = mount({ statusline: 'compact' });
    await esperar(() => plain(lastFrame()).includes('4% janela'));
    const f = plain(lastFrame());
    expect(f).not.toContain('estado');
    expect(f).toContain(HINTS);
    unmount();
  });

  it('compact + yolo: o aviso aparece na linha', async () => {
    const { lastFrame, unmount } = mount({ statusline: 'compact', unsafe: true });
    await esperar(() => plain(lastFrame()).includes('⚠ yolo'));
    unmount();
  });

  it('hidden: sem painel, sem % janela e sem hints; o cockpit segue renderizado', async () => {
    const { lastFrame, unmount } = mount({ statusline: 'hidden' });
    await esperar(() => plain(lastFrame()).includes('conversa'));
    const f = plain(lastFrame());
    expect(f).not.toContain('estado');
    expect(f).not.toContain('% janela');
    expect(f).not.toContain(HINTS);
    unmount();
  });

  it('hidden + yolo: o ⚠ yolo NUNCA some', async () => {
    const { lastFrame, unmount } = mount({ statusline: 'hidden', unsafe: true });
    await esperar(() => plain(lastFrame()).includes('⚠ yolo'));
    expect(plain(lastFrame())).not.toContain('estado');
    unmount();
  });

  it('hidden mantém a altura do frame (soma == rows): as linhas liberadas vão p/ as regiões', async () => {
    const full = mount({ statusline: 'full' });
    await esperar(() => plain(full.lastFrame()).includes('conversa'));
    const hidden = mount({ statusline: 'hidden' });
    await esperar(() => plain(hidden.lastFrame()).includes('conversa'));
    const nl = (s: string | undefined): number => plain(s).split('\n').length;
    expect(nl(hidden.lastFrame())).toBe(nl(full.lastFrame()));
    full.unmount();
    hidden.unmount();
  });

  it('F2 cicla full → compact → hidden dentro do cockpit e persiste cada escolha', async () => {
    const { lastFrame, stdin, onStatuslineChange, unmount } = mount({ statusline: 'full' });
    await esperar(() => plain(lastFrame()).includes('estado'));
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('\x1bOQ');
    await esperar(
      () => plain(lastFrame()).includes('% janela') && !plain(lastFrame()).includes('estado'),
    );
    stdin.write('\x1b[12~');
    await esperar(
      () => !plain(lastFrame()).includes('% janela') && !plain(lastFrame()).includes(HINTS),
    );
    expect(onStatuslineChange.mock.calls.map((c) => c[0])).toEqual(['compact', 'hidden']);
    stdin.write('\x1bOQ');
    await esperar(() => plain(lastFrame()).includes('estado'));
    unmount();
  });

  it('/statusline hidden dentro do cockpit esconde o rodapé', async () => {
    const { lastFrame, stdin, onStatuslineChange, unmount } = mount({ statusline: 'full' });
    await new Promise((r) => setTimeout(r, 200));
    await esperar(() => plain(lastFrame()).includes('estado'));
    stdin.write('/statusline hidden');
    await new Promise((r) => setTimeout(r, 250));
    stdin.write('\r');
    await esperar(() => !plain(lastFrame()).includes('estado'));
    expect(onStatuslineChange).toHaveBeenCalledWith('hidden');
    unmount();
  });
});
