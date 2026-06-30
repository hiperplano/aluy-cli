// fix(footer-bleed) — durante uma APROVAÇÃO ATIVA (`phase: 'asking'`) o <AskDialog>
// renderiza o SEU PRÓPRIO footer de atalhos em contexto (colado ao diálogo). O rodapé
// da App NÃO deve repetir esse footer: antes, o <FooterHints> do rodapé reimprimia a
// MESMA linha (`hints.ask`/`hints.askDestructive`) embaixo do composer/régua/status —
// um 2º footer de aprovação SOLTO sob o input, lido como vazamento/resíduo entre o
// diálogo e o composer. Estes testes provam:
//   1) durante o ask a linha de aprovação aparece EXATAMENTE 1× (a do AskDialog), não 2×;
//   2) o footer do rodapé NÃO segue o ask logo abaixo do composer (sem bleed);
//   3) ao RESOLVER o ask, o rodapé volta limpo (transição ask→composer, sem resíduo).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
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

function fakePorts(gate?: Promise<void>): ToolPorts {
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
      if (gate) await gate; // segura o shell `running` p/ inspeção determinística pós-aprovação.
      return { stdout: 'ok', stderr: '', exitCode: 0 };
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

function buildController(gate?: Promise<void>): SessionController {
  return new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(gate),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Conta quantas LINHAS do frame são (essencialmente) a dica de aprovação `a aprova · …`. */
function approveHintLines(frame: string): string[] {
  return plain(frame)
    .split('\n')
    .map((ln) => ln.trim())
    .filter((ln) => /a aprova/.test(ln) && /n nega/.test(ln) && /esc cancela/.test(ln));
}

/** Conta as linhas com a dica de IDLE (`enter sends · … history …`) — o rodapé "normal". */
function idleHintLines(frame: string): string[] {
  return plain(frame)
    .split('\n')
    .map((ln) => ln.trim())
    .filter((ln) => /enter/i.test(ln) && /(history|histórico|palette|paleta)/i.test(ln));
}

describe('App — footer de aprovação NÃO vaza no composer durante o ask (fix-footer-bleed)', () => {
  it('durante o ask: a dica de aprovação aparece EXATAMENTE 1× (a do AskDialog), não 2×', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const controller = buildController(gate);
    const theme = resolveTheme({ env: ENV });
    const { lastFrame, unmount } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await flush();

    // `!ls` ⇒ a catraca abre o AskDialog (phase `asking`).
    void controller.runBang('ls');
    await waitFor(() => controller.current.phase === 'asking');
    await flush();

    const frame = lastFrame() ?? '';
    // RAIZ do bug: antes a linha de aprovação aparecia 2× (AskDialog + rodapé). Agora 1×.
    expect(approveHintLines(frame)).toHaveLength(1);

    release();
    await flush();
    unmount();
  });

  it('durante o ask: a dica de aprovação NÃO é a ÚLTIMA linha do frame (não cai sob o composer)', async () => {
    // O bleed era um 2º footer de ask SOLTO no rodapé, abaixo do composer/status/modo —
    // i.e. a dica de aprovação como a última linha não-vazia. O footer de ask correto
    // mora DENTRO do diálogo (acima do composer), nunca como rodapé final.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const controller = buildController(gate);
    const theme = resolveTheme({ env: ENV });
    const { lastFrame, unmount } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await flush();

    void controller.runBang('ls');
    await waitFor(() => controller.current.phase === 'asking');
    await flush();

    const rows = plain(lastFrame() ?? '')
      .split('\n')
      .map((ln) => ln.trim())
      .filter((ln) => ln.length > 0);
    const lastRow = rows[rows.length - 1] ?? '';
    // a última linha do frame NÃO é a dica de aprovação (ela está em contexto, no diálogo).
    expect(/a aprova/.test(lastRow) && /n nega/.test(lastRow)).toBe(false);

    release();
    await flush();
    unmount();
  });

  it('ao RESOLVER o ask, o rodapé volta limpo (sem resíduo de aprovação; transição ask→composer)', async () => {
    const controller = buildController(); // sem gate ⇒ o shell resolve sozinho.
    const theme = resolveTheme({ env: ENV });
    const { lastFrame, unmount } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await flush();

    void controller.runBang('ls');
    await waitFor(() => controller.current.phase === 'asking');
    controller.resolveAsk({ kind: 'approve-once' });
    // o bang executa e o turno fecha ⇒ volta a idle/done.
    await waitFor(() => controller.current.phase !== 'asking');
    await flush();

    const frame = lastFrame() ?? '';
    // sem NENHUM resíduo da dica de aprovação após resolver…
    expect(approveHintLines(frame)).toHaveLength(0);
    // …e o rodapé normal (idle) reaparece — transição limpa.
    expect(idleHintLines(frame).length).toBeGreaterThanOrEqual(1);

    unmount();
  });
});
