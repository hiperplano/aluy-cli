// EST-0948 — HARNESS de PTY p/ a prova manual char-a-char do fix do slash-com-args.
// NÃO faz parte da suíte; é dirigido pelo `ptydrive-slashargs.py` (pty real). Renderiza
// o MESMO <App> de produção numa TTY real, com um `onCommand` espião que IMPRIME, em
// uma linha de protocolo, o comando+args que CHEGARAM ao handler. Assim, sob um PTY
// dirigido CHAR-A-CHAR, vemos se `/cycle --max-iter 2 …` realmente submete (vs o menu
// engolir o Enter). Broker inerte: não precisamos de rede — o bug é puramente de UI.
import React from 'react';
import { render } from 'ink';
import { ThemeProvider } from '../packages/cli/dist/ui/theme/context.js';
import { resolveTheme } from '../packages/cli/dist/ui/theme/theme.js';
import { App } from '../packages/cli/dist/session/App.js';
import { SessionController } from '../packages/cli/dist/session/controller.js';
import { TuiAskResolver } from '../packages/cli/dist/ask/ask-resolver.js';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';

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
const model = {
  async call() {
    return { request_id: 'r', content: '', finish_reason: 'stop' };
  },
};

const controller = new SessionController({
  model,
  permission: new PolicyPermissionEngine(),
  ports,
  askResolver: new TuiAskResolver(),
  meta: { cwd: process.cwd(), tier: 'aluy-flux', tokens: 0, windowPct: 0 },
  flush: { intervalMs: 0 },
});
controller.dismissBoot();

const theme = resolveTheme({ env: process.env });
// onCommand ESPIÃO: imprime no stderr (fora do frame da TUI) o que chegou ao handler.
const onCommand = (cmd, args) => {
  process.stderr.write(`\n__CMD__ id=${cmd.id} args=${JSON.stringify(args)}\n`);
};

render(
  React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(App, { controller, animate: false, bootMs: 0, onCommand }),
  ),
);
