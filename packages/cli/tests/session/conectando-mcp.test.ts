// PROMPT-ENXUTO · espera honesta do boot MCP — enquanto o controller aguarda os servers MCP
// assentarem (antes da 1ª chamada ao modelo), a linha viva diz `conectando MCP` (antes
// ficava `preparando`, sem dizer a quê). Ao assentar (ou estourar o teto) volta a
// `preparando` e depois `pensando`. Sem servers pendentes, o rótulo nunca aparece.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

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
  shell: {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
  search: {
    async search() {
      return { matches: [], truncated: {} };
    },
  },
} as unknown as ToolPorts;

function build(pendentes: readonly string[]) {
  const rotulosNaChamada: Array<string | undefined> = [];
  let ref: SessionController | null = null;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      rotulosNaChamada.push(ref!.current.workingLabel);
      return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
    },
  };
  const c = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
    ...(pendentes.length > 0 ? { pendingMcpServers: pendentes } : {}),
  });
  ref = c;
  const rotulos: string[] = [];
  c.subscribe((s) => {
    if (s.workingLabel !== undefined && rotulos[rotulos.length - 1] !== s.workingLabel)
      rotulos.push(s.workingLabel);
  });
  return { c, rotulos, rotulosNaChamada };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('rótulo `conectando MCP` (controller)', () => {
  it('server pendente: mostra `conectando MCP` enquanto espera e só chama o modelo depois de assentar', async () => {
    const { c, rotulos, rotulosNaChamada } = build(['srv']);
    const p = c.submit('oi');
    await new Promise((r) => setTimeout(r, 30));
    // ainda esperando o handshake: o modelo NÃO foi chamado e o rótulo é o honesto.
    expect(rotulosNaChamada).toEqual([]);
    expect(c.current.workingLabel).toBe('conectando MCP');
    expect(c.current.phase).toBe('thinking');

    // o server conectou ⇒ libera a espera.
    c.refreshMcpTools([], 'srv');
    await p;
    expect(rotulosNaChamada).toHaveLength(1);
    // no instante da chamada o rótulo já não é o de espera (voltou p/ preparo → pensando).
    expect(rotulosNaChamada[0]).not.toBe('conectando MCP');
    const iMcp = rotulos.indexOf('conectando MCP');
    expect(iMcp).toBeGreaterThanOrEqual(0);
    expect(rotulos[iMcp + 1]).toBe('preparando');
    expect(rotulos).toContain('pensando');
    c.dispose();
  });

  it('server que nunca conecta: o teto (4s) solta a espera e o turno segue', async () => {
    vi.useFakeTimers();
    const { c, rotulosNaChamada } = build(['lento']);
    const p = c.submit('oi');
    await vi.advanceTimersByTimeAsync(3_900);
    expect(c.current.workingLabel).toBe('conectando MCP');
    expect(rotulosNaChamada).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(rotulosNaChamada).toHaveLength(1);
    expect(rotulosNaChamada[0]).not.toBe('conectando MCP');
    c.dispose();
  });

  it('sem server pendente: o rótulo `conectando MCP` NUNCA aparece', async () => {
    const { c, rotulos, rotulosNaChamada } = build([]);
    await c.submit('oi');
    expect(rotulosNaChamada).toHaveLength(1);
    expect(rotulos).not.toContain('conectando MCP');
    c.dispose();
  });
});
