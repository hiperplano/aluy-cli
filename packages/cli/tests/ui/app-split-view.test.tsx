// EST-0990 — prova de PONTA (App + Ink): o MODO VIEW AVANÇADO (split CHAT | LOG).
//   • Ctrl+L / /split LIGA/DESLIGA o split + PERSISTE (onSplitViewChange);
//   • ≥100 col ⇒ LADO-A-LADO (rótulo LOG sobre a coluna do log — SEM letreiro "CHAT",
//     a conversa é obviamente o chat; o divisor já separa os painéis);
//   • Tab alterna o FOCO chat↔log; digitar com o log FOCADO NÃO edita o composer;
//   • esc com foco no log 1º devolve o foco ao chat (não interrompe);
//   • OFF por default ⇒ a TUI de hoje (sem coluna de LOG).
// A degradação por largura (tabs/<60) é coberta pela prova PURA (split-budget.test.ts);
// aqui o ink-testing fixa columns=100 (⇒ side). A redação do log (RES-C-1) é provada em
// activity-log.test.ts com uma FlowTree real.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type SearchPort,
  type ShellPort,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');
const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const CTRL_L = String.fromCharCode(12); // Ctrl+L
const TAB = '\t';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return [];
    },
  };
  return { fs, shell, search };
}

function inertCaller(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
}

function buildController(): SessionController {
  return new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function renderApp(
  controller: SessionController,
  extra: { initialSplitView?: boolean; onSplitViewChange?: (on: boolean) => void } = {},
) {
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} {...extra} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return r;
}

describe('App — MODO VIEW AVANÇADO (split CHAT | LOG) — EST-0990', () => {
  it('OFF por default: NÃO mostra a coluna de LOG (TUI de hoje)', async () => {
    const controller = buildController();
    const { lastFrame, unmount } = renderApp(controller);
    await waitFor(() => plain(lastFrame() ?? '').length > 0);
    const out = plain(lastFrame() ?? '');
    // sem o rótulo de coluna nem o painel de log.
    expect(out).not.toContain('CHAT │ LOG');
    expect(out).not.toContain('sem atividade ainda');
    unmount();
  });

  it('Ctrl+L LIGA o split (≥100col ⇒ lado-a-lado: rótulo LOG, SEM letreiro CHAT) e PERSISTE', async () => {
    const controller = buildController();
    let persisted: boolean | undefined;
    const { stdin, lastFrame, unmount } = renderApp(controller, {
      onSplitViewChange: (on) => {
        persisted = on;
      },
    });
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    await pressUntil(
      () => stdin.write(CTRL_L),
      () => plain(lastFrame() ?? '').includes('LOG'),
    );
    const out = plain(lastFrame() ?? '');
    // SÓ o painel de LOG se rotula no modo lado-a-lado. O letreiro "CHAT" à esquerda
    // saiu (polish EST-0990): a conversa é obviamente o chat; o divisor já separa.
    expect(out).toContain('LOG');
    expect(out).not.toContain('CHAT');
    // sem turno ⇒ a coluna do log mostra "sem atividade ainda".
    expect(out).toContain('sem atividade');
    // PERSISTÊNCIA: o callback foi chamado com `true`.
    expect(persisted).toBe(true);
    unmount();
  });

  it('Ctrl+L de novo DESLIGA o split + persiste OFF', async () => {
    const controller = buildController();
    const persists: boolean[] = [];
    const { stdin, lastFrame, unmount } = renderApp(controller, {
      onSplitViewChange: (on) => persists.push(on),
    });
    await waitFor(() => plain(lastFrame() ?? '').length > 0);
    // liga…
    await pressUntil(
      () => stdin.write(CTRL_L),
      () => plain(lastFrame() ?? '').includes('sem atividade'),
    );
    // …e desliga.
    await pressUntil(
      () => stdin.write(CTRL_L),
      () => !plain(lastFrame() ?? '').includes('sem atividade'),
    );
    expect(persists).toEqual([true, false]);
    unmount();
  });

  it('inicia LIGADO quando initialSplitView=true (precedência da flag/config)', async () => {
    const controller = buildController();
    const { lastFrame, unmount } = renderApp(controller, { initialSplitView: true });
    await waitFor(() => plain(lastFrame() ?? '').includes('sem atividade'));
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('LOG');
    unmount();
  });

  it('Tab com o split ligado alterna o FOCO sem editar o composer; digitar no log NÃO vaza', async () => {
    const controller = buildController();
    const { stdin, lastFrame, unmount } = renderApp(controller, { initialSplitView: true });
    await waitFor(() => plain(lastFrame() ?? '').includes('sem atividade'));
    // foca o LOG.
    stdin.write(TAB);
    await new Promise((r) => setTimeout(r, 20));
    // digita 'e' (filtro de erros do log) e 'x' — NÃO devem entrar no composer.
    stdin.write('e');
    stdin.write('x');
    await new Promise((r) => setTimeout(r, 20));
    const out = plain(lastFrame() ?? '');
    // o composer segue VAZIO (as teclas foram p/ o log, não p/ o input): o placeholder
    // "digite um objetivo…" continua na tela (some assim que algo é digitado no input).
    expect(out).toContain('digite um objetivo');
    // e nenhuma linha do composer (prompt ›) carrega o 'ex' digitado.
    const composerLine = out.split('\n').find((l) => l.includes('›'));
    expect(composerLine ?? '').not.toContain('ex');
    unmount();
  });

  it('/split (slash) alterna o split igual ao Ctrl+L', async () => {
    const controller = buildController();
    let persisted: boolean | undefined;
    const { stdin, lastFrame, unmount } = renderApp(controller, {
      onSplitViewChange: (on) => {
        persisted = on;
      },
    });
    await waitFor(() => plain(lastFrame() ?? '').length > 0);
    await pressUntil(
      () => stdin.write('/split'),
      () => plain(lastFrame() ?? '').includes('/split'),
    );
    await pressUntil(
      () => stdin.write('\r'),
      () => plain(lastFrame() ?? '').includes('sem atividade'),
    );
    expect(persisted).toBe(true);
    unmount();
  });
});
