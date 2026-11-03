// UX de saída (F3/F9/F11) — linha de trabalho contínua, pausa por cota e confirmação do esc.
//
// DoD: em `streaming` por 12s (clock MOCK) ⇒ o footer mostra `0:12`; com `ALUY_NO_ANIM`
// o número AINDA avança (é informativo, não decorativo). A App lê o elapsed VIVO do
// controller (`turnAccounting().durationMs` = clock − início do turno) e o renderiza no
// <FooterHints>. (O harness do Ink não dispara o useEffect do tick de 1s; aqui um delta
// de token força o re-render APÓS avançar o clock — prova que o valor lido é o vivo, que
// é o que o tick de 1s faria na TUI real a cada segundo.)

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string) => (s ?? '').replace(ANSI, '');

function fakePorts(): ToolPorts {
  return {
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
}
function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function waitFor(cond: () => boolean, t = 2000) {
  const d = Date.now() + t;
  while (!cond()) {
    if (Date.now() > d) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Relógio MOCK controlável (ms). Avança só quando o teste manda. */
function mockClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function build(env: NodeJS.ProcessEnv) {
  const clk = mockClock();
  const gate = defer();
  let cref: SessionController | null = null;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      cref!.sink.onStart?.();
      cref!.sink.onDelta('trabalhando…');
      await gate.promise;
      cref!.sink.onDone?.();
      return { request_id: 'r', content: 'x', finish_reason: 'stop' };
    },
  };
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
    clock: clk.now, // contabilidade do turno usa ESTE clock (determinístico)
  });
  cref = controller;
  controller.dismissBoot();
  const theme = resolveTheme({ env });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  return { controller, clk, gate, r };
}

const BASE_ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

const view = {
  scope: 'janela',
  reason: 'x',
  manual: false,
  probing: false,
  agents: [],
  resetAtMs: Date.now() + 3_600_000,
  nextProbeAtMs: Date.now() + 60_000,
  deadlineAtMs: Date.now() + 7_200_000,
};

describe('UX de saída', () => {
  it('F3: a linha de trabalho (verbo + segundos) segue visível DURANTE o streaming e o verbo não muda entre passos', async () => {
    const { controller, clk, gate, r } = build(BASE_ENV);
    void controller.submit('objetivo');
    await waitFor(() => controller.current.phase === 'streaming');
    clk.advance(3_000);
    controller.sink.onDelta(' mais');
    await waitFor(() => /\(.*3s\)/.test(plain(r.lastFrame())));
    const f1 = plain(r.lastFrame());
    const v1 = controller.current.workingVerb;
    expect(v1).toBeDefined();
    expect(f1).toContain(`${v1}…`);
    // novo passo dentro do mesmo turno (model-call): mesmo verbo
    (controller as unknown as { patch(p: object): void }).patch({
      phase: 'thinking',
      workingLabel: 'pensando',
      workingSince: 5,
    });
    expect(controller.current.workingVerb).toBe(v1);
    gate.resolve();
    r.unmount();
  });

  it('F9: pausa por cota troca a linha de trabalho por um estado estático e o rodapé deixa de dizer "interromper"', async () => {
    const { controller, gate, r } = build(BASE_ENV);
    void controller.submit('objetivo');
    await waitFor(() => controller.current.phase === 'streaming');
    (controller as unknown as { patch(p: object): void }).patch({
      phase: 'thinking',
      workingLabel: 'pausado',
      quotaPause: view,
    });
    await waitFor(() => plain(r.lastFrame()).includes('pausado — cota esgotada'));
    const f = plain(r.lastFrame());
    expect(f).toContain('↵ tentar agora');
    expect(f).not.toContain('esc interromper');
    expect(f).not.toMatch(/·\s*\d+:\d\d/);
    gate.resolve();
    r.unmount();
  });

  it.each([
    ['esc', ESC],
    ['Ctrl-C', String.fromCharCode(3)],
  ])(
    'F11: %s durante o trabalho deixa a nota "↳ interrompido" (sem rotular a tecla)',
    async (_nome, tecla) => {
      const { controller, gate, r } = build(BASE_ENV);
      void controller.submit('objetivo');
      await waitFor(() => controller.current.phase === 'streaming');
      await new Promise((res) => setTimeout(res, 50));
      r.stdin.write(tecla);
      await waitFor(() => plain(r.lastFrame()).includes('↳ interrompido'), 3000);
      gate.resolve();
      await new Promise((res) => setTimeout(res, 30));
      const txt = plain(r.lastFrame());
      // Ctrl-C também interrompe, então a nota não pode afirmar "(esc)".
      expect(txt).not.toContain('interrompido (esc)');
      r.unmount();
    },
  );
});
