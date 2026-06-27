// EST-0965 — PROVA DE BYTES do overwrite-in-place sob PTY real (TTY). Renderiza o App
// REAL com o Ink, ENVOLVENDO o stdout com `wrapStdoutWithSync` (igual ao run.tsx), e
// dirige um TURNO de STREAMING (deltas token-a-token, o caminho REAL do flicker — cada
// flush re-renderiza a região viva via `eraseLines + frame` do log-update). Captura os
// bytes dos redraws e CONTA os `\x1b[2K` (limpa-linha-inteira = branqueamento = flicker).
//
// CRITÉRIO OBJETIVO do DoD:
//   · overwrite ON  ⇒ `\x1b[2K` no redraw == 0  (zero branco ⇒ zero flicker)
//   · overwrite OFF ⇒ `\x1b[2K` no redraw  > 0  (o comportamento cru do Ink, p/ contraste)
//
// NÃO chama o modelo real (model stub). Rodar via:
//   script -qec 'node scripts/pty-overwrite-proof.mjs on'  /tmp/cap-on
//   script -qec 'node scripts/pty-overwrite-proof.mjs off' /tmp/cap-off
// <arg>: 'on' (overwrite ligado, default) | 'off' (overwrite desligado, contraste).

import React from 'react';
import { render } from 'ink';
import { ThemeProvider } from '../packages/cli/dist/ui/theme/context.js';
import { resolveTheme } from '../packages/cli/dist/ui/theme/theme.js';
import { App } from '../packages/cli/dist/session/App.js';
import { SessionController } from '../packages/cli/dist/session/controller.js';
import { TuiAskResolver } from '../packages/cli/dist/ask/ask-resolver.js';
import { wrapStdoutWithSync } from '../packages/cli/dist/session/synchronized-output.js';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';

const overwrite = (process.argv[2] ?? 'on') !== 'off';
const env = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

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

controller.dismissBoot();
controller.restoreBlocks([
  { kind: 'you', text: 'liste os arquivos do projeto' },
  { kind: 'aluy', text: 'Encontrei 9 pacotes no monorepo.', streaming: false },
]);

const theme = resolveTheme({ env });

// Envolve o stdout EXATAMENTE como o run.tsx (sync ligado p/ paridade; o que varia é o
// overwrite). É o mesmo wrapper que a TUI usa em produção.
const { stdout } = wrapStdoutWithSync(process.stdout, { sync: true, overwrite });

// Captura os bytes a partir do MOMENTO em que o streaming começa (isola os redraws da
// região viva — o 1º render full-clear NÃO entra na conta).
let capturing = false;
let captured = '';
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (capturing) captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  return realWrite(chunk, ...rest);
};

const instance = render(
  React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(App, { controller, animate: false, bootMs: 0 }),
  ),
  { stdout, exitOnCtrlC: false },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

setTimeout(async () => {
  // 1º render full já saiu. Liga a captura e dirige um streaming de várias linhas: cada
  // flush re-pinta a região viva (eraseLines + frame) — o caminho real do flicker.
  capturing = true;
  controller.startAluyTurn();
  const deltas = ['Analisando o ', 'projeto.\nForam ', '9 pacotes.\nO cli ', 'em packages/cli.\n'];
  for (const d of deltas) {
    controller.appendAluyDelta(d);
    controller.flushNow?.(); // força a notificação ⇒ re-render imediato da região viva.
    await sleep(60); // separa os frames no tempo (cada um é um write distinto).
  }
  await sleep(120);
  capturing = false;
  instance.unmount();
  const erase2K = captured.split('\x1b[2K').length - 1;
  const up = captured.split('\x1b[1A').length - 1;
  const eos = captured.split('\x1b[J').length - 1;
  const eol = captured.split('\x1b[K').length - 1;
  process.stderr.write(
    `\n[PROOF] overwrite=${overwrite ? 'ON' : 'OFF'} ` +
      `\\x1b[2K=${erase2K} \\x1b[1A=${up} \\x1b[K=${eol} \\x1b[J=${eos}\n`,
  );
  process.exit(0);
}, 500);
