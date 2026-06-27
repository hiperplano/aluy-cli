// HUNT-IO-NET — ANTI-HANG DE BOOT no HANDSHAKE MCP (`connect`+`listTools`).
//
// Classe de bug (timeout/hang de I/O): o watchdog do EST-1010 só cobria `callTool`.
// O `connect()` (handshake initialize + listTools) NÃO tinha teto. Como a descoberta
// é SEQUENCIAL e roda no STARTUP (discovery.ts), UM server que spawna mas trava no
// `initialize`/`listTools` (server bugado/hostil) pendurava a descoberta — e o BOOT
// inteiro — PARA SEMPRE. Provas (fake do cliente MCP injetado, sem processo real):
//   • connect que NUNCA resolve ⇒ watchdog dispara no teto, LANÇA, não pendura.
//   • listTools que NUNCA resolve ⇒ idem (o handshake inclui o listTools).
//   • o transport é fechado/zerado no timeout (não vaza processo).
//   • server NORMAL ⇒ conecta igual (não regride).
import { describe, expect, it, vi } from 'vitest';
import {
  StdioMcpTransport,
  resolveMcpConnectTimeoutMs,
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  type McpClientLike,
} from '../../src/mcp/stdio-transport.js';
import type { McpServerConfig } from '@hiperplano/aluy-cli-core';

const SERVER: McpServerConfig = { name: 'fake', command: 'node', args: [], env: {} };

function fakeClient(opts: {
  connect?: McpClientLike['connect'];
  listTools?: McpClientLike['listTools'];
  onClose?: () => void;
}): McpClientLike {
  return {
    connect: opts.connect ?? (async () => {}),
    listTools:
      opts.listTools ?? (async () => ({ tools: [{ name: 'do_thing', description: 'd' }] })),
    callTool: async () => ({ content: [] }),
    async close() {
      opts.onClose?.();
    },
  };
}

describe('HUNT-IO-NET · StdioMcpTransport.connect — TIMEOUT de handshake (anti-hang boot)', () => {
  it('connect que NUNCA resolve ⇒ watchdog LANÇA (não pendura o boot)', async () => {
    const hang: McpClientLike['connect'] = () => new Promise<void>(() => {});
    const transport = new StdioMcpTransport({
      connectTimeoutMs: 30,
      clientFactory: () => fakeClient({ connect: hang }),
    });
    const started = Date.now();
    await expect(transport.connect(SERVER)).rejects.toThrow(/handshake MCP não respondeu/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('listTools que NUNCA resolve ⇒ watchdog LANÇA (handshake cobre o listTools)', async () => {
    const hang: McpClientLike['listTools'] = () =>
      new Promise<{ tools: { name: string }[] }>(() => {});
    const transport = new StdioMcpTransport({
      connectTimeoutMs: 30,
      clientFactory: () => fakeClient({ listTools: hang }),
    });
    await expect(transport.connect(SERVER)).rejects.toThrow(/anti-hang de boot/);
  });

  it('no timeout, o processo-server é FECHADO (não vaza processo zumbi)', async () => {
    const onClose = vi.fn();
    const hang: McpClientLike['connect'] = () => new Promise<void>(() => {});
    const transport = new StdioMcpTransport({
      connectTimeoutMs: 30,
      clientFactory: () => fakeClient({ connect: hang, onClose }),
    });
    await expect(transport.connect(SERVER)).rejects.toThrow();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('server NORMAL ⇒ conecta e lista as tools (não regride)', async () => {
    const transport = new StdioMcpTransport({
      connectTimeoutMs: 1_000,
      clientFactory: () => fakeClient({}),
    });
    const tools = await transport.connect(SERVER);
    expect(tools.map((t) => t.name)).toEqual(['do_thing']);
  });

  it('resolveMcpConnectTimeoutMs: env válido > clamp > default', () => {
    expect(resolveMcpConnectTimeoutMs({})).toBe(DEFAULT_MCP_CONNECT_TIMEOUT_MS);
    expect(resolveMcpConnectTimeoutMs({ ALUY_MCP_CONNECT_TIMEOUT_MS: '5000' })).toBe(5000);
    // lixo/negativo ⇒ default; abaixo do piso ⇒ piso de 1s.
    expect(resolveMcpConnectTimeoutMs({ ALUY_MCP_CONNECT_TIMEOUT_MS: 'abc' })).toBe(
      DEFAULT_MCP_CONNECT_TIMEOUT_MS,
    );
    expect(resolveMcpConnectTimeoutMs({ ALUY_MCP_CONNECT_TIMEOUT_MS: '10' })).toBe(1_000);
  });
});
