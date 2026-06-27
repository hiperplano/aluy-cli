// Anti "dois splashes" (feedback Tiago): quando o run.tsx JÁ mostrou o SplashScreen,
// ele chama controller.dismissBoot() ANTES de montar a App, pra pular a fase 'boot'
// (que renderia um <Boot>/"conectando" cosmético — uma 2ª tela de marca). Este teste
// fixa o contrato em que o fix se apoia: arranca em 'boot' e dismissBoot → 'idle'.
import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

const noFs: FileSystemPort = {
  async readFile() {
    return '';
  },
  async writeFile() {},
  async exists() {
    return false;
  },
};
const noShell: ShellPort = {
  async exec() {
    return { stdout: '', stderr: '', exitCode: 0 };
  },
};
const noSearch: SearchPort = {
  async grep() {
    return [];
  },
};

function makeController(): SessionController {
  const ports: ToolPorts = { fs: noFs, shell: noShell, search: noSearch };
  return new SessionController({
    model: {
      async call() {
        return { request_id: 'r', content: 'pronto.', finish_reason: 'stop' as const };
      },
    },
    permission: new PolicyPermissionEngine({}),
    ports,
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

describe('dismissBoot — pular a 2ª tela de marca quando o splash já apareceu', () => {
  it('arranca na fase boot', () => {
    expect(makeController().state.phase).toBe('boot');
  });

  it('dismissBoot leva boot → idle (splash → cockpit direto, sem <Boot>)', () => {
    const c = makeController();
    c.dismissBoot();
    expect(c.state.phase).toBe('idle');
  });

  it('dismissBoot é no-op fora da fase boot (não derruba um turno em curso)', () => {
    const c = makeController();
    c.dismissBoot();
    expect(c.state.phase).toBe('idle');
    c.dismissBoot();
    expect(c.state.phase).toBe('idle');
  });
});
