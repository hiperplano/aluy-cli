// F163 — stress do anti-flicker: sessão GIGANTE + saída viva rápida, sob PTY real.
// Mede o que o dono relata: "tela enormemente cheia, sessão 20M+ tokens, muitos arquivos".
// Semeia N blocos concluídos (Static enorme) e streama um !comando com linhas largas.
// A análise (fora daqui) conta clearTerminal (\x1b[2J) e bytes totais no cap do `script`.
// Rodar: script -qec 'node pty-flicker-stress.mjs big|small' /dev/null > cap-<modo>.bin

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink';

const { ThemeProvider } = await import('../packages/cli/dist/ui/theme/context.js');
const { resolveTheme } = await import('../packages/cli/dist/ui/theme/theme.js');
const { App } = await import('../packages/cli/dist/session/App.js');
const { SessionController } = await import('../packages/cli/dist/session/controller.js');
const { TuiAskResolver } = await import('../packages/cli/dist/ask/ask-resolver.js');
const { NodeShellPort } = await import('../packages/cli/dist/io/shell-port.js');
const { NodeWorkspace } = await import('../packages/cli/dist/io/workspace.js');
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';

const mode = process.argv[2] ?? 'big';
const SEED = mode === 'big' ? 500 : 4;

const base = mkdtempSync(join(tmpdir(), 'aluy-flicker-'));
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
  meta: { cwd: root, tier: 'aluy-flux', tokens: 21_400_000, windowPct: 43 },
  flush: { intervalMs: 40 },
});

controller.dismissBoot();

// Sessão GIGANTE: turnos + linhas largas (paths/JSON longos — o caso "gerou muitos arquivos").
const wide = (i) =>
  `⏺ write packages/app/src/gerado/component-${i}.tsx aplicado +${80 + (i % 40)}/−0 · ` +
  'props='.padEnd(60, 'x') +
  ' '.repeat(4) +
  'x'.repeat(90 + (i % 60));
const blocks = [];
for (let i = 0; i < SEED; i += 1) {
  blocks.push({ kind: 'you', text: `gere o arquivo ${i} com o layout ${'muito '.repeat(8)}largo` });
  blocks.push({
    kind: 'aluy',
    text: `Gerado o componente ${i}.\n${wide(i)}\n${wide(i + 1)}`,
    streaming: false,
  });
}
controller.restoreBlocks(blocks);

const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
const { unmount } = render(
  React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(App, { controller, animate: true, bootMs: 0 }),
  ),
  { exitOnCtrlC: false },
);

// Marca o fim do MOUNT (o clear inicial é legítimo) p/ a análise separar as fases.
setTimeout(() => process.stdout.write('\n__FASE_VIVA__\n'), 700);

// Saída viva RÁPIDA e LARGA por ~2.5s — o gatilho do frame alto durante o trabalho.
setTimeout(() => {
  controller.runBang(
    'for i in $(seq 1 60); do printf "arquivo-%03d " "$i"; head -c 140 /dev/zero | tr "\\0" "="; echo; sleep 0.035; done',
  );
}, 800);

setTimeout(() => {
  process.stdout.write('\n__FIM__\n');
  unmount();
  process.exit(0);
}, 3800);
