// EST-0970 (ciclo MCP na sessão) — o interruptor `disabled` de um server MCP:
//   • parser TOLERANTE: ausente ⇒ ativo (todo mcp.json pré-existente segue igual);
//     `disabled: true` ⇒ marcado; tipo errado ⇒ erro legível (formato defensivo).
//   • a DESCOBERTA PULA o server desativado: não lança transport, não conecta,
//     nenhuma tool entra no toolset — os ATIVOS seguem descobertos normalmente.
//   • a LISTAGEM resolve o estado `disabled` da CONFIG (fonte da verdade), sem tools.

import { describe, expect, it } from 'vitest';
import {
  parseMcpConfig,
  McpConfigError,
  discoverMcpTools,
  buildMcpListing,
  type McpConfig,
  type McpServerConfig,
  type McpTransport,
} from '../../src/index.js';

describe('parseMcpConfig — `disabled` tolerante', () => {
  it('ausente ⇒ ativo (campo omitido)', () => {
    const cfg = parseMcpConfig({ mcpServers: { a: { command: 'npx' } } });
    expect(cfg.servers[0]!.disabled).toBeUndefined();
  });

  it('disabled: true ⇒ marcado', () => {
    const cfg = parseMcpConfig({ mcpServers: { a: { command: 'npx', disabled: true } } });
    expect(cfg.servers[0]!.disabled).toBe(true);
  });

  it('disabled: false ⇒ ativo (normalizado p/ omitido)', () => {
    const cfg = parseMcpConfig({ mcpServers: { a: { command: 'npx', disabled: false } } });
    expect(cfg.servers[0]!.disabled).toBeUndefined();
  });

  it('disabled não-boolean ⇒ McpConfigError legível', () => {
    expect(() =>
      parseMcpConfig({ mcpServers: { a: { command: 'npx', disabled: 'yes' } } }),
    ).toThrow(McpConfigError);
  });
});

describe('discoverMcpTools — descoberta PULA servers desativados', () => {
  function fakeTransport(connected: string[]): (s: McpServerConfig) => McpTransport {
    return (s) => ({
      connect: async () => {
        connected.push(s.name);
        return [{ name: 'do' }];
      },
      callTool: async () => ({ ok: true, content: '' }),
      close: async () => {},
    });
  }

  it('não conecta nem registra o server disabled; os ativos seguem', async () => {
    const config: McpConfig = {
      servers: [
        { name: 'on', command: 'npx', args: [], env: {} },
        { name: 'off', command: 'npx', args: [], env: {}, disabled: true },
      ],
    };
    const connected: string[] = [];
    const result = await discoverMcpTools(config, fakeTransport(connected));
    // o desativado NÃO foi lançado/conectado…
    expect(connected).toEqual(['on']);
    // …não aparece na descoberta nem contribui tool alguma.
    expect(result.servers.map((s) => s.server)).toEqual(['on']);
    expect(result.tools.map((t) => t.server)).toEqual(['on']);
    expect(result.transports).toHaveLength(1);
  });
});

describe('buildMcpListing — estado `disabled` vem da config', () => {
  it('server disabled lista como disabled, sem tools', () => {
    const listing = buildMcpListing([
      {
        origin: 'aluy-global',
        config: {
          servers: [
            { name: 'on', command: 'npx', args: [], env: {} },
            { name: 'off', command: 'npx', args: [], env: {}, disabled: true },
          ],
        },
      },
    ]);
    const off = listing.find((s) => s.name === 'off')!;
    expect(off.state).toEqual({ kind: 'disabled' });
    expect(off.tools).toEqual([]);
    expect(listing.find((s) => s.name === 'on')!.state).toEqual({ kind: 'unknown' });
  });
});
