// EST-0965 — INDICADOR DE ATIVIDADE (elapsed) integrado na App.
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

describe('App — INDICADOR DE ATIVIDADE / elapsed (EST-0965)', () => {
  it('em streaming por 12s (clock mock) ⇒ footer mostra 0:12', async () => {
    const { controller, clk, gate, r } = build(BASE_ENV);
    void controller.submit('objetivo');
    await waitFor(() => controller.current.phase === 'streaming');

    // Avança o relógio 12s e força um re-render (um delta de token re-publica o estado,
    // como o tick de 1s faria na TUI real). O elapsed lido é o VIVO: 12s ⇒ 0:12.
    clk.advance(12_000);
    controller.sink.onDelta(' mais');
    await waitFor(() => plain(r.lastFrame()).includes('0:12'));
    const f = plain(r.lastFrame());
    expect(f).toContain('esc interromper'); // a dica base segue
    expect(f).toContain('· 0:12'); // + o relógio anexado

    gate.resolve();
    r.unmount();
  });

  it('com ALUY_NO_ANIM o elapsed AINDA avança (informativo, não decorativo)', async () => {
    // theme.animate=false por ALUY_NO_ANIM — o tick de 120ms morre, mas o de 1s (elapsed)
    // independe de animate, então o número sobe igual.
    const { controller, clk, gate, r } = build({ ...BASE_ENV, ALUY_NO_ANIM: '1' });
    void controller.submit('objetivo');
    await waitFor(() => controller.current.phase === 'streaming');

    clk.advance(3_000);
    controller.sink.onDelta(' a');
    await waitFor(() => plain(r.lastFrame()).includes('0:03'));

    clk.advance(4_000); // total 7s
    controller.sink.onDelta(' b');
    await waitFor(() => plain(r.lastFrame()).includes('0:07'));
    expect(plain(r.lastFrame())).toContain('0:07');

    gate.resolve();
    r.unmount();
  });

  it('ao TERMINAR (done) o elapsed sai do footer (não há mais turno vivo)', async () => {
    const { controller, clk, gate, r } = build(BASE_ENV);
    void controller.submit('objetivo');
    await waitFor(() => controller.current.phase === 'streaming');
    clk.advance(5_000);
    controller.sink.onDelta(' x');
    await waitFor(() => plain(r.lastFrame()).includes('0:05'));

    gate.resolve();
    await waitFor(() => controller.current.phase === 'done');
    // O footer de done não carrega o relógio de atividade (some o `esc interromper` e o
    // elapsed). A dica vira a de idle.
    const f = plain(r.lastFrame());
    expect(f).not.toContain('esc interromper');
    expect(f).not.toMatch(/·\s*0:0\d/);
    r.unmount();
  });
});
