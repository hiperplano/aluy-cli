// ADR-0137 (Fatia 3) — C3 no APP: na fase `cycle-ceiling`, Esc ENCERRA (igual a `n`). O
// seguranca achou que a Esc era tecla MORTA aqui (o handler só tratava `n`/`c` e dava
// `return`), contradizendo o que o gate/controller prometem. Este teste exercita a TECLA
// Esc pelo handler do App (caminho antes sem cobertura) e prova que ela chama
// `stopCycleCeiling()` (encerra). `n` já era coberto; a Esc não.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import {
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type JudgeEngine,
  type AskResolver,
} from '@hiperplano/aluy-cli-core';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
const toolCall = (n: string, i: Record<string, unknown>): string =>
  `${TOOL_OPEN}\n${JSON.stringify({ name: n, input: i })}\n${TOOL_CLOSE}`;

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

// juiz SEMPRE continue ⇒ ao bater o teto (--max-iter 1), abre o gate do teto.
const judge: JudgeEngine = {
  async judge() {
    return {
      chosen: 'continue',
      confidence: 0.9,
      reasons: [{ optionId: 'continue', rationale: 'segue' }],
      mode: 'llm',
    };
  },
};
const approveAll: AskResolver = { async resolve() {
  return { kind: 'approve' };
} };

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: não assentou');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ADR-0137 · C3 (App) — Esc no gate do teto ENCERRA (não é tecla morta)', () => {
  it('na fase cycle-ceiling, Esc chama stopCycleCeiling() (encerra, igual a `n`)', async () => {
    let turn = 0;
    let ref: SessionController | null = null;
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        ref!.sink.onStart?.();
        const t = turn++;
        return {
          request_id: 'r',
          content: t % 2 === 0 ? toolCall('read_file', { path: 'x' }) : 'andamento (sem concluir).',
          finish_reason: 'stop',
        };
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: fakePorts(),
      askResolver: approveAll,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
      judge,
      cycleJudgeEnv: {},
    });
    ref = controller;
    controller.dismissBoot();

    const theme = resolveTheme({ env: ENV });
    const s = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );

    const stopSpy = vi.spyOn(controller, 'stopCycleCeiling');
    void controller.cycle('--max-iter 1 "trabalho"');

    // o teto bate e o juiz pede continuar ⇒ a fase vira cycle-ceiling (gate na tela).
    await waitFor(() => controller.current.phase === 'cycle-ceiling');
    expect(stopSpy).not.toHaveBeenCalled();

    // Esc ⇒ ENCERRA (antes era tecla morta nesta fase).
    s.stdin.write(ESC);
    await waitFor(() => stopSpy.mock.calls.length > 0);
    expect(stopSpy).toHaveBeenCalled();
    await waitFor(() => controller.current.phase !== 'cycle-ceiling');

    stopSpy.mockRestore();
    s.unmount();
  });
});
