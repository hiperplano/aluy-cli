// REPRO/PROVA task #18 — CRASH do Ink em sequência CSI-u de tecla FUNCIONAL (kitty kbd
// proto). Renderiza o App REAL com o Ink numa TTY (dirigido por um PTY real via
// `repro-inkcrash.py`, que escreve `\x1b[57414u` no stdin do filho). Sem o fix (GUARD=off),
// o Ink crasha em `use-input.js:73` (`input.startsWith` sobre undefined). Com o fix (filtro
// raw, default), a sequência é descartada ANTES do Ink e o app SOBREVIVE.
//
// Os MARCADORES de protocolo vão num ARQUIVO de log (REPRO_LOG) — NÃO no stdout/stderr,
// que o Ink repinta/limpa. O driver lê esse arquivo p/ decidir VIVO/MORTO:
//   · `BOOT`        — montou e está vivo (composer pronto).
//   · `ALIVE t`     — heartbeat: ainda VIVO no tick t.
//   · `INKCRASH …`  — uncaughtException (o crash do Ink).
//   · `EXIT code`   — saída (limpa = 0).
// Sem backend (o model é um stub). Bug é puramente de UI/parse.

import { appendFileSync } from 'node:fs';
import React from 'react';
import { render } from 'ink';
import { ThemeProvider } from '../packages/cli/dist/ui/theme/context.js';
import { resolveTheme } from '../packages/cli/dist/ui/theme/theme.js';
import { App } from '../packages/cli/dist/session/App.js';
import { SessionController } from '../packages/cli/dist/session/controller.js';
import { TuiAskResolver } from '../packages/cli/dist/ask/ask-resolver.js';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';
import { installCsiUGuard } from '../packages/cli/dist/session/csi-u-guard.js';

const LOG = process.env.REPRO_LOG ?? '/tmp/repro-inkcrash.log';
const log = (line) => {
  try {
    appendFileSync(LOG, line + '\n');
  } catch {
    /* best-effort */
  }
};

const env = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

// O guard SÓ é instalado quando NÃO for o baseline (GUARD=off reproduz o crash pré-fix;
// default = fix ligado, espelhando o que o run.tsx faz antes do render).
if (process.env.GUARD !== 'off') installCsiUGuard(process.stdin);

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

// O crash do Ink vira uncaughtException — registra e sai com código DISTINTO do limpo.
process.on('uncaughtException', (e) => {
  log(`INKCRASH ${e && e.message ? e.message : e}`);
  log('EXIT 42');
  process.exit(42);
});

const theme = resolveTheme({ env });
const { waitUntilExit } = render(
  React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(App, { controller, animate: false, bootMs: 0 }),
  ),
  { exitOnCtrlC: false },
);

log('BOOT');
let tick = 0;
const hb = setInterval(() => {
  tick += 1;
  log(`ALIVE ${tick}`);
  if (tick >= 6) {
    clearInterval(hb);
    log('EXIT 0');
    process.exit(0); // sobreviveu a tudo: saída limpa.
  }
}, 200);

await waitUntilExit().catch(() => {});
