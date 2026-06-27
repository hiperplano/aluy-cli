// EST-0989 — prova de RENDER sob PTY (TTY real): renderiza o App REAL com o Ink
// (não a ink-testing-library, que funde Static+dinâmico num só frame) e uma sessão
// SEMEADA com 2 turnos. Num TTY real o Ink commita o Static no scrollback (sobe) e
// mantém só o frame vivo embaixo — então o que sai no terminal é a ORDEM REAL:
// header no TOPO, histórico abaixo, composer/status no rodapé.
//
// Rodar via: `script -qec 'node scripts/pty-proof.mjs <mode>' /tmp/cap` p/ alocar PTY.
// <mode>: 'unicode' | 'ascii' | 'narrow'. Sem TTY, aborta (precisa do PTY do script).

import React from 'react';
import { render } from 'ink';
import { ThemeProvider } from '../packages/cli/dist/ui/theme/context.js';
import { resolveTheme } from '../packages/cli/dist/ui/theme/theme.js';
import { App } from '../packages/cli/dist/session/App.js';
import { SessionController } from '../packages/cli/dist/session/controller.js';
import { TuiAskResolver } from '../packages/cli/dist/ask/ask-resolver.js';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';

const mode = process.argv[2] ?? 'unicode';

const env =
  mode === 'ascii' ? { TERM: 'linux', LANG: 'C' } : { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

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

const controller = new SessionController({
  model: {
    async call() {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  },
  permission: new PolicyPermissionEngine(),
  ports,
  askResolver: new TuiAskResolver(),
  meta: { cwd: '/proj/aluy-vau', tier: 'aluy-flux', tokens: 1280, windowPct: 12 },
  flush: { intervalMs: 0 },
});

// Semeia uma CONVERSA de 2+ turnos (concluídos ⇒ vão p/ o Static).
controller.dismissBoot();
controller.restoreBlocks([
  { kind: 'you', text: 'liste os arquivos do projeto' },
  {
    kind: 'aluy',
    text: 'Encontrei 9 pacotes no monorepo. O cli vive em packages/cli.',
    streaming: false,
  },
  { kind: 'you', text: 'e o header, fica onde?' },
  {
    kind: 'aluy',
    text: 'Agora o header fica PINADO no topo, acima de toda a conversa.',
    streaming: false,
  },
]);

const theme = resolveTheme({ env });

// largura forçada via columns do App? O App lê stdout.columns. Sob `script`, o PTY
// herda a largura do terminal host; p/ o modo 'narrow' encurtamos via COLUMNS+resize.
if (mode === 'narrow') {
  process.stdout.columns = 50;
}

const { unmount, waitUntilExit } = render(
  React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(App, { controller, animate: false, bootMs: 0 }),
  ),
  { exitOnCtrlC: false },
);

// deixa o Ink commitar o Static + pintar o frame vivo, então desmonta e sai.
setTimeout(() => {
  unmount();
  process.exit(0);
}, 600);

await waitUntilExit().catch(() => {});
