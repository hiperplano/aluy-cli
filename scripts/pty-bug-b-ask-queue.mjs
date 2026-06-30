// HARNESS tmux (TTY real) — BUG B: ESC sob ask com `!bang` na FILA não pode abortar/limpar.
// App REAL (Ink), modelo MOCK (sem broker — CLI-SEC-7 intacto). Linha do tempo do turno
// VIVO: iter 0 = read_file (allow) gateado ~8s (janela p/ enfileirar o bang); iter 1 =
// run_command destrutivo ⇒ a CATRACA abre o ask DENTRO do turno vivo, com a fila cheia.
// O operador (tmux) digita `!echo segundo` + Enter durante a iter 0, espera o ask, e dá
// ESC ESC — provando que a fila SOBREVIVE e o trabalho NÃO aborta.

import React from 'react';
import { render } from 'ink';
import { ThemeProvider } from '../packages/cli/dist/ui/theme/context.js';
import { resolveTheme } from '../packages/cli/dist/ui/theme/theme.js';
import { App } from '../packages/cli/dist/session/App.js';
import { SessionController } from '../packages/cli/dist/session/controller.js';
import { TuiAskResolver } from '../packages/cli/dist/ask/ask-resolver.js';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
const toolCall = (name, input) => `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;

const ports = {
  fs: { async readFile() { return ''; }, async writeFile() {}, async exists() { return false; } },
  shell: { async exec() { return { stdout: 'ok', stderr: '', exitCode: 0 }; } },
  search: { async search() { return []; } },
};

let controllerRef = null;
let turn = 0;
const model = {
  async call() {
    controllerRef.sink.onStart?.();
    const t = turn++;
    if (t === 0) {
      // janela LONGA p/ o operador enfileirar o bang antes da iter 1 abrir o ask.
      await new Promise((r) => setTimeout(r, 12000));
      return { request_id: 'r', content: toolCall('read_file', { path: 'x' }), finish_reason: 'stop' };
    }
    if (t === 1) {
      // run_command destrutivo ⇒ ask abre e BLOQUEIA o turno vivo (a fila segue cheia).
      return { request_id: 'r', content: toolCall('run_command', { command: 'rm -rf build' }), finish_reason: 'stop' };
    }
    // iter 2: encerra RÁPIDO p/ o turno repousar e a fila (bang) drenar VISIVELMENTE.
    await new Promise((r) => setTimeout(r, 1500));
    return { request_id: 'r', content: 'pronto.', finish_reason: 'stop' };
  },
};

const controller = new SessionController({
  model,
  permission: new PolicyPermissionEngine(), // default ask ⇒ run_command pede aprovação
  ports,
  askResolver: new TuiAskResolver(),
  meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
  flush: { intervalMs: 0 },
});
controllerRef = controller;
controller.dismissBoot();

const theme = resolveTheme({ env: process.env });
render(
  React.createElement(ThemeProvider, { theme }, React.createElement(App, { controller, animate: false, bootMs: 0 })),
);

// Dispara o turno automaticamente (o operador só digita o bang + ESC).
setTimeout(() => { void controller.submit('objetivo inicial'); }, 300);
