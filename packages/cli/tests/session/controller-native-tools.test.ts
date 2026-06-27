// EST-0996 — o SessionController (dono do toolset FINAL) entrega a capacidade de
// tool-calling NATIVO via `onToolsReady`, com o catálogo de funções convertido do
// toolset (nativas + …). E `disableNativeTools` suprime a entrega (escape hatch).

import { describe, expect, it } from 'vitest';
import {
  NativeToolsCapability,
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

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
    return { matches: [], truncated: {} };
  },
};
const ports: ToolPorts = { fs, shell, search };

const model: ModelCaller = {
  async call(): Promise<ModelCallResult> {
    return { request_id: 'r', content: '', finish_reason: 'stop' };
  },
};

function build(opts: {
  disableNativeTools?: boolean;
  onToolsReady?: (c: NativeToolsCapability) => void;
}) {
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    ...(opts.disableNativeTools !== undefined
      ? { disableNativeTools: opts.disableNativeTools }
      : {}),
    ...(opts.onToolsReady !== undefined ? { onToolsReady: opts.onToolsReady } : {}),
  });
}

describe('EST-0996 — controller entrega a capacidade de tools nativas', () => {
  it('onToolsReady recebe a capacidade com o catálogo das tools nativas', () => {
    let cap: NativeToolsCapability | undefined;
    build({ onToolsReady: (c) => (cap = c) });
    expect(cap).toBeInstanceOf(NativeToolsCapability);
    // O catálogo tem tools (nativas convertidas) ⇒ shouldSendTools=true.
    expect(cap!.shouldSendTools()).toBe(true);
  });

  it('disableNativeTools=true ⇒ onToolsReady NÃO é chamado (texto puro)', () => {
    let called = false;
    build({ disableNativeTools: true, onToolsReady: () => (called = true) });
    expect(called).toBe(false);
  });
});
