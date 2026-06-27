// EST-0982 (type-ahead) — HARNESS sob PTY (TTY real): o App REAL (Ink) com o composer
// ATIVO enquanto o agente "trabalha" (streaming MOCK — sem modelo/broker). Um driver
// externo (ptydrive-type-ahead.py) FORKA um PTY, digita EM LOTE (texto+Enter num único
// write — o caso xrdp/SSH) ENQUANTO o turno está vivo, e lê o frame renderizado p/ provar
// que a fila aparece e que o trabalho NÃO foi interrompido. Aqui o turno fica em STREAMING
// por ~2.6s (gate temporizado) p/ dar janela ao driver digitar; depois encerra (a fila
// auto-submete). Nada de credencial (CLI-SEC-7 intacto; é prova de UI).

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

let controllerRef = null;

// Caller GATEADO por TEMPO: dispara o stream (sink.onStart ⇒ fase `streaming`) e fica
// vivo ~2.6s — a janela em que o driver digita. Cada chamada (a inicial + a auto-submetida
// da fila) reabre um stream curto.
const model = {
  async call() {
    const sink = controllerRef.sink;
    sink.onStart?.();
    sink.onDelta('trabalhando…');
    // Cada turno fica vivo ~2.6s: o 1º dá a janela p/ enfileirar AS DUAS mensagens
    // ANTES de qualquer auto-submit; os seguintes (a fila virando objetivo) também
    // ficam vivos o bastante p/ o driver observar o 2º streaming.
    await new Promise((r) => setTimeout(r, 2600));
    sink.onDone?.();
    return { request_id: 'r', content: 'trabalhando…', finish_reason: 'stop' };
  },
};

const controller = new SessionController({
  model,
  permission: new PolicyPermissionEngine(),
  ports,
  askResolver: new TuiAskResolver(),
  meta: { cwd: '/proj/aluy-vau', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
  flush: { intervalMs: 0 },
});
controllerRef = controller;
controller.dismissBoot();

// Marcador de FASE no stdout (o driver casa por regex; não interfere no frame Ink, que
// reescreve a tela). Emite a cada transição.
let lastPhase = '';
controller.subscribe((s) => {
  if (s.phase !== lastPhase) {
    lastPhase = s.phase;
    process.stdout.write(`\r\n__PHASE__ ${s.phase}\r\n`);
  }
});

const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
const { unmount } = render(
  React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(App, { controller, animate: false, bootMs: 0 }),
  ),
  { exitOnCtrlC: false },
);

// Dispara o objetivo inicial → STREAMING (vivo ~2.6s). O driver digita nesse intervalo.
controller.submit('objetivo inicial');

// Encerra a prova após a janela (2.6s enfileirando) + o auto-submit consumir a fila
// (mais um turno de ~2.6s). Folga p/ o driver observar o 2º streaming.
setTimeout(() => {
  unmount();
  process.exit(0);
}, 6500);
