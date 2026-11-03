// F16/F8 — eco "você" com chips de anexo/paste e aviso de `@arquivo` inexistente.

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
import { buildSentDisplay } from '../../src/session/sent-display.js';

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

describe('buildSentDisplay', () => {
  it('sem anexo: o texto como está', () => {
    expect(buildSentDisplay('oi', [])).toBe('oi');
  });
  it('com anexos: chips [anexo: x] numa linha própria (sem duplicar)', () => {
    expect(buildSentDisplay('resuma', ['a.txt', 'b.ts', 'a.txt'])).toBe(
      'resuma\n[anexo: a.txt] [anexo: b.ts]',
    );
  });
});

function build(models: string[]): SessionController {
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
    async call(args): Promise<ModelCallResult> {
      models.push(JSON.stringify(args.messages));
      return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
    },
  };
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

describe('App — F16: @arquivo inexistente e chip de anexo no eco', () => {
  const reader = {
    attach: async (path: string): Promise<unknown> =>
      path === 'notes.txt'
        ? {
            kind: 'ok',
            path,
            item: { role: 'observation', toolName: 'attach', text: 'conteudo' },
            truncated: false,
          }
        : { kind: 'rejected', path, reason: 'não encontrado' },
  };

  function mount(sent: string[]) {
    const controller = build(sent);
    const theme = resolveTheme({ env: ENV });
    const r = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} attachReader={reader as never} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    return { ...r, controller };
  }

  it('`@naoexiste.txt oi`: avisa, NÃO envia e mantém o texto no composer', async () => {
    const sent: string[] = [];
    const s = mount(sent);
    await sleep(30);
    s.stdin.write('@naoexiste.txt oi');
    await sleep(30);
    s.stdin.write('\r');
    await waitFor(() => plain(s.lastFrame()).includes('não encontrado'));
    expect(plain(s.lastFrame())).toContain('NÃO foi enviada');
    expect(plain(s.lastFrame())).toContain('@naoexiste.txt oi');
    expect(sent).toHaveLength(0);
    expect(s.controller.current.blocks.some((b) => b.kind === 'you')).toBe(false);
    // Enter de novo envia assim mesmo.
    s.stdin.write('\r');
    await waitFor(() => s.controller.current.blocks.some((b) => b.kind === 'you'));
    s.unmount();
  });

  it('`@notes.txt resuma`: o eco mostra o chip [anexo: notes.txt] e o modelo recebe o texto limpo', async () => {
    const sent: string[] = [];
    const s = mount(sent);
    await sleep(30);
    s.stdin.write('@notes.txt resuma');
    await sleep(30);
    s.stdin.write('\r');
    await waitFor(() => s.controller.current.blocks.some((b) => b.kind === 'you'));
    const you = s.controller.current.blocks.find((b) => b.kind === 'you');
    expect(you && you.kind === 'you' ? you.display : '').toContain('[anexo: notes.txt]');
    await waitFor(() => plain(s.lastFrame()).includes('[anexo: notes.txt]'));
    s.unmount();
  });
});

describe('controller.submit — display só afeta a apresentação', () => {
  it('guarda `display` no bloco e mantém `text` cheio', async () => {
    const sent: string[] = [];
    const c = build(sent);
    c.dismissBoot();
    await c.submit('texto\n'.repeat(130), [], { display: '[texto colado #1, +130 linhas]' });
    const you = c.current.blocks.find((b) => b.kind === 'you');
    expect(you && you.kind === 'you' ? you.display : '').toBe('[texto colado #1, +130 linhas]');
    expect(you && you.kind === 'you' ? you.text.split('\n').length : 0).toBeGreaterThan(100);
  });
});
