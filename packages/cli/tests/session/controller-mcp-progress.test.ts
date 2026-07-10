// EST-MCP-STATUSBAR (pedido do dono) — antes, o boot desacoplado (EST-BOOT-DECOUPLE)
// empurrava NOTAS na conversa ("conectando N server(es)…" → "M/N conectados") a cada
// server MCP resolvido. Isto poluía a tela principal. Agora o progresso vive só em
// `state.mcpProgress` (a StatusBar o desenha como barrinha + ✓ transiente) — provamos
// aqui a máquina de estado PURA do controller (sem Ink): arma/avança/fecha/auto-clear.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
      return { matches: [], truncated: {} };
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

function build(): SessionController {
  return new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

describe('SessionController — mcpProgress (EST-MCP-STATUSBAR)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sem startMcpProgress ⇒ mcpProgress ausente (sem MCP configurado, zero ruído)', () => {
    const c = build();
    expect(c.current.mcpProgress).toBeUndefined();
  });

  it('startMcpProgress(0) ⇒ no-op (nada configurado)', () => {
    const c = build();
    c.startMcpProgress(0);
    expect(c.current.mcpProgress).toBeUndefined();
  });

  it('startMcpProgress(N) arma {connected:0,total:N,failed:0,done:false}', () => {
    const c = build();
    c.startMcpProgress(3);
    expect(c.current.mcpProgress).toEqual({ connected: 0, total: 3, failed: 0, done: false });
  });

  it('reportMcpServerReady avança connected/failed; fecha done ao bater o total', () => {
    const c = build();
    c.startMcpProgress(3);

    c.reportMcpServerReady(true);
    expect(c.current.mcpProgress).toEqual({ connected: 1, total: 3, failed: 0, done: false });

    c.reportMcpServerReady(false);
    expect(c.current.mcpProgress).toEqual({ connected: 1, total: 3, failed: 1, done: false });

    c.reportMcpServerReady(true);
    expect(c.current.mcpProgress).toEqual({ connected: 2, total: 3, failed: 1, done: true });
  });

  it('reportMcpServerReady sem startMcpProgress antes ⇒ no-op (nunca crasha)', () => {
    const c = build();
    c.reportMcpServerReady(true);
    expect(c.current.mcpProgress).toBeUndefined();
  });

  it('ao fechar done, agenda o auto-clear (~2s) — mcpProgress vira undefined sozinho', () => {
    const c = build();
    c.startMcpProgress(1);
    c.reportMcpServerReady(true);
    expect(c.current.mcpProgress?.done).toBe(true);

    vi.advanceTimersByTime(1999);
    expect(c.current.mcpProgress).toBeDefined(); // ainda não passou o teto

    vi.advanceTimersByTime(1);
    expect(c.current.mcpProgress).toBeUndefined(); // sumiu sozinho, ninguém pediu
  });

  it('um novo startMcpProgress ANTES do auto-clear anterior cancela o timer velho', () => {
    const c = build();
    c.startMcpProgress(1);
    c.reportMcpServerReady(true); // done ⇒ agenda o clear em ~2s

    vi.advanceTimersByTime(1000);
    c.startMcpProgress(2); // nova rodada (ex.: /mcp reload) — reseta a barra
    expect(c.current.mcpProgress).toEqual({ connected: 0, total: 2, failed: 0, done: false });

    // o timer da rodada ANTERIOR não deve zerar a rodada NOVA no meio do caminho.
    vi.advanceTimersByTime(1100);
    expect(c.current.mcpProgress).toEqual({ connected: 0, total: 2, failed: 0, done: false });
  });

  it('dispose() cancela o auto-clear pendente (sem timer órfão após o unmount)', () => {
    const c = build();
    c.startMcpProgress(1);
    c.reportMcpServerReady(true);
    expect(c.current.mcpProgress?.done).toBe(true);

    c.dispose();
    vi.advanceTimersByTime(5000);
    // o dispose já desmontou a sessão — o estado congela como estava (sem crash, sem
    // callback tardio tentando notificar observers de uma sessão morta).
    expect(c.current.mcpProgress?.done).toBe(true);
  });
});
