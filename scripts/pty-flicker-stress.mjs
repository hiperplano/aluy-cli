// F163 — stress do anti-flicker: sessão GIGANTE + saída viva rápida, sob PTY real.
// Mede o que o dono relata: "tela enormemente cheia, sessão 20M+ tokens, muitos arquivos".
// Semeia N blocos concluídos (Static enorme) e streama um !comando com linhas largas.
// A análise (fora daqui) conta clearTerminal (\x1b[2J) e bytes totais no cap do `script`.
// Rodar: script -qec 'node pty-flicker-stress.mjs big|small' /dev/null > cap-<modo>.bin
//
// EST-1015 — modo `cockpit`: o MESMO stress, mas no MODO TELA CHEIA (ADR-0076): monta a
// pilha REAL do run.tsx (wrapStdoutWithSync + enterAltScreen ANTES do 1º frame + differ
// do alt-screen) com sessão gigante + saída viva. A análise prova 0 `\x1b[2J` após o
// marcador de fase (o differ troca o clearTerminal do Ink por diff por-linha — §5).
// Rodar: ALUY_FULLSCREEN=1 script -qec 'stty rows R cols C; node pty-flicker-stress.mjs cockpit' /dev/null > cap.bin

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
const { wrapStdoutWithSync } = await import('../packages/cli/dist/session/synchronized-output.js');
const { enterAltScreen, registerRestoreHandlers } =
  await import('../packages/cli/dist/session/alt-screen.js');
const { resolveCockpitLayout } = await import('../packages/cli/dist/session/cockpit-layout.js');
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';

const mode = process.argv[2] ?? 'big';
const COCKPIT = mode === 'cockpit';
const SEED = mode === 'small' ? 4 : 500;

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

// EST-1015 — modo COCKPIT: a pilha de tela REAL do run.tsx (envelope + alt-screen + differ).
// Fora do cockpit, render cru de sempre (modos big/small INALTERADOS).
let appProps = { controller, animate: true, bootMs: 0 };
let renderOpts = { exitOnCtrlC: false };
let sync;
if (COCKPIT) {
  const baseStdout = process.stdout;
  registerRestoreHandlers(baseStdout, process);
  sync = wrapStdoutWithSync(baseStdout, { sync: true, overwrite: true });
  const fits =
    resolveCockpitLayout(baseStdout.rows ?? 0, baseStdout.columns ?? 0).kind === 'cockpit';
  if (fits) {
    enterAltScreen(baseStdout);
    sync.setCockpit(true);
  }
  appProps = {
    ...appProps,
    syncActive: true,
    initialFullscreen: true,
    cockpitEnteredAtBoot: fits,
    cockpitScreen: {
      enter: () => {
        enterAltScreen(baseStdout);
        sync.setCockpit(true);
      },
      leave: () => {
        sync.setCockpit(false);
        baseStdout.write('\x1b[?1049l\x1b[?25h\x1b[2J\x1b[3J\x1b[H');
        sync.resetDiffer();
      },
      resetDiffer: () => sync.resetDiffer(),
    },
  };
  renderOpts = { ...renderOpts, stdout: sync.stdout };
}

const { unmount } = render(
  React.createElement(ThemeProvider, { theme }, React.createElement(App, appProps)),
  renderOpts,
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
  sync?.cleanup();
  process.exit(0);
}, 3800);
