// EST-0982 — prova de RENDER sob PTY: o App REAL (Ink, TTY real) mostra a SAÍDA AO
// VIVO de um `!comando` enquanto roda, bounded, sem quebrar o chrome (composer/status).
// Dirige o NodeShellPort REAL via runBang e deixa o Ink pintar o frame vivo.
//
// Rodar via PTY: `script -qec 'node scripts/pty-run-command-stream.mjs' /tmp/cap`.
// Sem TTY o Ink ainda renderiza (modo não-raw), suficiente p/ a captura.

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink';
import { ThemeProvider } from '../packages/cli/dist/ui/theme/context.js';
import { resolveTheme } from '../packages/cli/dist/ui/theme/theme.js';
import { App } from '../packages/cli/dist/session/App.js';
import { SessionController } from '../packages/cli/dist/session/controller.js';
import { TuiAskResolver } from '../packages/cli/dist/ask/ask-resolver.js';
import { NodeShellPort } from '../packages/cli/dist/io/shell-port.js';
import { NodeWorkspace } from '../packages/cli/dist/io/workspace.js';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';

const base = mkdtempSync(join(tmpdir(), 'aluy-0982-pty-'));
const root = join(base, 'project');
mkdirSync(root, { recursive: true });

const ports = {
  fs: {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  },
  shell: new NodeShellPort({ workspace: new NodeWorkspace({ root }), timeoutMs: 30_000 }),
  search: {
    async search() {
      return [];
    },
  },
};

const controller = new SessionController({
  model: {
    async call() {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  },
  permission: new PolicyPermissionEngine({
    policy: { rules: [{ tool: 'run_command', decision: 'allow' }] },
  }),
  ports,
  askResolver: new TuiAskResolver(),
  meta: { cwd: root, tier: 'aluy-flux', tokens: 0, windowPct: 0 },
  flush: { intervalMs: 40 },
});

controller.dismissBoot();

const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
const { unmount } = render(
  React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(App, { controller, animate: false, bootMs: 0 }),
  ),
  { exitOnCtrlC: false },
);

// Dispara um `!comando` que streama por ~0.6s (respiro entre linhas).
controller.runBang('for i in $(seq 1 8); do echo "linha-viva-$i"; sleep 0.07; done');

// Deixa o Ink pintar vários frames com a saída ao vivo, então desmonta.
setTimeout(() => {
  unmount();
  process.exit(0);
}, 900);
