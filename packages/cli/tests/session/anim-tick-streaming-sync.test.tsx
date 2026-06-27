// EST-0965 — RELIGAR a animação de 120ms no STREAMING quando o synchronized-output
// (#76, Mode 2026, frame atômico) está ATIVO — sem reintroduzir o flicker no caminho
// sem-sync (#75 preservado).
//
// O #75 desligou a animação no streaming p/ NÃO redesenhar 8×/seg (era o flicker: o
// terminal pintava o erase+redraw intermediário do log-update do Ink). O #76 envolve
// cada frame em BSU…ESU ⇒ o frame sai ATÔMICO ⇒ redesenhar deixou de tremer. Então a
// App RELIGA o tick de 120ms no streaming QUANDO `syncActive` (padrão true); sem sync,
// mantém DESLIGADO (anti-flicker #75).
//
// COMO TESTAMOS sem o loop de efeitos do Ink (que o harness não dispara): o que importa
// é a DECISÃO da App — qual `enabled` ela passa ao `useTick` de 120ms (DEFAULT_TICK_MS).
// Mockamos o `useTick` p/ CAPTURAR o `enabled` por intervalo a cada render e, com a
// sessão em `streaming` (caller adiável), conferimos: sync ON ⇒ o tick de 120ms é
// ENABLED; sync OFF ⇒ é DISABLED. O tick de 1s (elapsed) segue ENABLED nos dois (não
// regride). É determinístico (não depende do timer real nem de avançar frames).

import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// Mock do hook de tick ANTES de importar a App: cada chamada registra
// `{ intervalMs, enabled }` no array compartilhado. Retorna 0 (frame estático — o
// harness não avança o timer; aqui só nos importa a DECISÃO de enable).
const tickCalls: Array<{ intervalMs: number; enabled: boolean }> = [];
vi.mock('../../src/ui/hooks/useTick.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/hooks/useTick.js')>();
  return {
    ...actual,
    useTick: (opts: { enabled?: boolean; intervalMs?: number } = {}): number => {
      tickCalls.push({
        intervalMs: opts.intervalMs ?? actual.DEFAULT_TICK_MS,
        enabled: opts.enabled ?? true,
      });
      return 0;
    },
  };
});

import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@aluy/cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { DEFAULT_TICK_MS } from '../../src/ui/hooks/useTick.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

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

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Sessão com um caller que entra em `streaming` e fica vivo até o gate resolver. */
function buildStreaming() {
  const gate = defer();
  let cref: SessionController | null = null;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      cref!.sink.onStart?.();
      cref!.sink.onDelta('trabalhando…');
      await gate.promise;
      cref!.sink.onDone?.();
      return { request_id: 'r', content: 'trabalhando…', finish_reason: 'stop' };
    },
  };
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  cref = controller;
  controller.dismissBoot();
  return { controller, gate };
}

/** Renderiza a App (animate=true) com o `syncActive` dado e leva ao `streaming`. */
async function renderStreaming(syncActive: boolean) {
  const { controller, gate } = buildStreaming();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate bootMs={0} syncActive={syncActive} />
    </ThemeProvider>,
  );
  void controller.submit('objetivo');
  await waitFor(() => controller.current.phase === 'streaming');
  return { controller, gate, r };
}

/** Último `enabled` capturado p/ o tick do intervalo dado (após assentar o render). */
function lastEnabledFor(intervalMs: number): boolean | undefined {
  for (let i = tickCalls.length - 1; i >= 0; i--) {
    const c = tickCalls[i];
    if (c && c.intervalMs === intervalMs) return c.enabled;
  }
  return undefined;
}

describe('App — RELIGA a animação de 120ms no streaming sob sync (EST-0965)', () => {
  it('o intervalo de 120ms é a cadência do tick de ANIMAÇÃO (sanidade do mock)', () => {
    expect(DEFAULT_TICK_MS).toBe(120);
  });

  it('streaming + sync ATIVO ⇒ o tick de 120ms (animação) é ENABLED (bolinhas voltam)', async () => {
    tickCalls.length = 0;
    const { gate, r } = await renderStreaming(true);
    expect(lastEnabledFor(DEFAULT_TICK_MS)).toBe(true);
    // o elapsed de 1s segue ligado (indicador de atividade) — não regride.
    expect(lastEnabledFor(1000)).toBe(true);
    gate.resolve();
    r.unmount();
  });

  it('streaming + sync OFF ⇒ o tick de 120ms (animação) fica DISABLED (preserva o #75)', async () => {
    tickCalls.length = 0;
    const { gate, r } = await renderStreaming(false);
    expect(lastEnabledFor(DEFAULT_TICK_MS)).toBe(false);
    // mesmo sem animação, o elapsed de 1s segue ligado (a tela não congela).
    expect(lastEnabledFor(1000)).toBe(true);
    gate.resolve();
    r.unmount();
  });
});
