// EST-0982 — F8 = PARAR TUDO (pai + todos os sub-agentes), a tecla FORTE da nova
// semântica de parada (o esc agora para SÓ o pai). O F8 chega como sequência CSI
// (`\x1b[19~`; variantes VT/PF mandam `\x1bOW`) que o `useInput` do Ink NÃO expõe
// (vira input vazio) — a App o detecta no canal RAW do stdin (como o batch-Enter).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  ModelCallAbortedError,
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

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

/** Caller que PENDURA até o abort (como o broker real cancela in-flight). */
function hangingCaller(): ModelCaller {
  return {
    async call(args): Promise<ModelCallResult> {
      await new Promise<void>((res) => {
        if (args.signal?.aborted) return res();
        args.signal?.addEventListener('abort', () => res(), { once: true });
      });
      // Como o caller real do broker: o abort vira o erro de CANCELAMENTO (não falha).
      throw new ModelCallAbortedError();
    },
  };
}

function buildController(): SessionController {
  return new SessionController({
    model: hangingCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Reescreve o chunk até o efeito assentar (o listener de stdin do Ink é pós-commit). */
async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function mountApp(controller: SessionController) {
  const theme = resolveTheme({ env: ENV });
  return render(
    <ThemeProvider theme={theme}>
      <App controller={controller} bootMs={0} animate={false} />
    </ThemeProvider>,
  );
}

describe('EST-0982 — F8 (PARAR TUDO) detectado no canal raw do stdin', () => {
  for (const [name, seq] of [
    ['CSI \\x1b[19~ (xterm/rxvt — o comum)', '\x1b[19~'],
    ['SS3 \\x1bOW (variantes VT/PF)', '\x1bOW'],
  ] as const) {
    it(`${name} aborta o turno vivo (cancel-all auditado)`, async () => {
      const controller = buildController();
      const { stdin } = mountApp(controller);

      controller.dismissBoot();
      const turn = controller.submit('objetivo longo');
      await waitFor(() => controller.current.phase === 'thinking');

      // F8 — o Ink parseia a sequência como tecla de função (input vazio no
      // useInput); a App a pega no canal RAW e chama o PARAR-TUDO.
      await pressUntil(
        () => stdin.write(seq),
        () => controller.current.phase === 'idle',
      );
      await turn;
      // O caminho foi o cancel-all (o MESMO do painel Ctrl+T→P) — auditado.
      expect(
        controller.controlLog().some((e) => e.verb === 'cancel-all' && e.actorType === 'cli'),
      ).toBe(true);
    });
  }

  it('F8 com a sessão em repouso é INERTE (não muda fase, não audita)', async () => {
    const controller = buildController();
    const { stdin } = mountApp(controller);
    controller.dismissBoot();
    await waitFor(() => controller.current.phase === 'idle');
    stdin.write('\x1b[19~');
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.current.phase).toBe('idle');
    expect(controller.controlLog().some((e) => e.verb === 'cancel-all')).toBe(false);
  });
});
