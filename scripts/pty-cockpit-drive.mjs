// Harness INTERATIVO do cockpit (ADR-0076) p/ inspeção visual em tmux — SEM provider real
// (modelo fake; conteúdo via restoreBlocks/runBang, como o pty-flicker-stress). Replica o
// wiring do run.tsx (ramo TTY): wrapStdoutWithSync + enterAltScreen ANTES do 1º frame +
// cockpitScreen (enter/leave/resetDiffer) — a MESMA pilha de tela do produto.
// Uso: ALUY_FULLSCREEN=1 node scripts/pty-cockpit-drive.mjs [seedN] [--live] [--inline]
//   seedN    — nº de turnos semeados (default 12; 0 = sessão vazia/idle).
//   --live   — dispara um !comando com saída viva ~3s depois do mount.
//   --inline — começa no INLINE (p/ testar a transição /fullscreen dentro da sessão).

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

const args = process.argv.slice(2);
const seedArg = args.find((a) => !a.startsWith('--'));
const SEED = Number(seedArg ?? 12);
const LIVE = args.includes('--live');
const START_INLINE = args.includes('--inline');

const base = mkdtempSync(join(tmpdir(), 'aluy-cockpit-'));
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
      return { request_id: 'r', content: 'ok (modelo fake do harness)', finish_reason: 'stop' };
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

const blocks = [];
// nota de DIAGNÓSTICO de boot (relocada p/ o LOG pelo cockpit — EST-1015).
blocks.push({
  kind: 'note',
  title: 'config',
  lines: ['instruções: CLAUDE.md', '2 servers MCP configurados', 'permissões: padrão'],
});
for (let i = 0; i < SEED; i += 1) {
  blocks.push({ kind: 'you', text: `objetivo ${i}: gere o componente ${i} com layout responsivo` });
  blocks.push({
    kind: 'aluy',
    text:
      `Gerado o componente ${i}.\n` +
      `⏺ write packages/app/src/gerado/component-${i}.tsx aplicado +${80 + (i % 40)}/−0\n` +
      'A prop `density` controla o espaçamento; usei o padrão do DS.',
    streaming: false,
  });
}
if (blocks.length > 0) controller.restoreBlocks(blocks);

// ── wiring de tela (idêntico ao run.tsx, ramo TTY) ─────────────────────────────────────
const baseStdout = process.stdout;
registerRestoreHandlers(baseStdout, process);
const sync = wrapStdoutWithSync(baseStdout, { sync: true, overwrite: true });
const wantCockpit = !START_INLINE;
const bootFits =
  wantCockpit &&
  resolveCockpitLayout(baseStdout.rows ?? 0, baseStdout.columns ?? 0).kind === 'cockpit';
if (bootFits) {
  enterAltScreen(baseStdout);
  sync.setCockpit(true);
}

const theme = resolveTheme({ env: { LANG: 'pt_BR.UTF-8', TERM: 'xterm-256color' } });
const { unmount, waitUntilExit } = render(
  React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(App, {
      controller,
      animate: true,
      bootMs: 0,
      version: 'dev-cockpit',
      syncActive: true,
      initialFullscreen: wantCockpit,
      cockpitEnteredAtBoot: bootFits,
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
    }),
  ),
  { stdout: sync.stdout, exitOnCtrlC: true },
);

if (LIVE) {
  setTimeout(() => {
    controller.runBang(
      'for i in $(seq 1 40); do printf "arquivo-%03d " "$i"; head -c 110 /dev/zero | tr "\\0" "="; echo; sleep 0.08; done',
    );
  }, 3000);
}

await waitUntilExit();
sync.cleanup();
unmount();
process.exit(0);
