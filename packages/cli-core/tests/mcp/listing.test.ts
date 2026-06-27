// EST-0970 — listagem unificada de servers MCP (origem/precedência + estado da descoberta).

import { describe, expect, it } from 'vitest';
import {
  buildMcpListing,
  invalidCommandWarning,
  originLabel,
  type McpSource,
} from '../../src/mcp/listing.js';
import type { McpConfig } from '../../src/mcp/config.js';
import type { McpDiscoveryResult } from '../../src/mcp/client.js';

function cfg(
  ...names: { name: string; command?: string; env?: Record<string, string> }[]
): McpConfig {
  return {
    servers: names.map((n) => ({
      name: n.name,
      command: n.command ?? 'npx',
      args: [],
      env: n.env ?? {},
    })),
  };
}

describe('buildMcpListing — origem, precedência e estado', () => {
  it('lista de TODAS as fontes com a origem de cada server', () => {
    const sources: McpSource[] = [
      { origin: 'codex', config: cfg({ name: 'cx' }) },
      { origin: 'aluy-global', config: cfg({ name: 'fs' }) },
      { origin: 'project', config: cfg({ name: 'proj' }) },
    ];
    const out = buildMcpListing(sources);
    expect(out.map((s) => [s.name, s.origin])).toEqual([
      ['cx', 'codex'],
      ['fs', 'aluy-global'],
      ['proj', 'project'],
    ]);
  });

  it('precedência: projeto VENCE global em colisão de nome (origem vencedora)', () => {
    const sources: McpSource[] = [
      { origin: 'aluy-global', config: cfg({ name: 'fs', command: 'global-bin' }) },
      { origin: 'project', config: cfg({ name: 'fs', command: 'project-bin' }) },
    ];
    const out = buildMcpListing(sources);
    expect(out).toHaveLength(1);
    expect(out[0]!.origin).toBe('project');
    expect(out[0]!.command).toBe('project-bin');
  });

  it('marca managed=false só p/ Codex (o aluy não escreve no Codex)', () => {
    const sources: McpSource[] = [
      { origin: 'codex', config: cfg({ name: 'cx' }) },
      { origin: 'aluy-global', config: cfg({ name: 'fs' }) },
    ];
    const out = buildMcpListing(sources);
    expect(out.find((s) => s.name === 'cx')!.managed).toBe(false);
    expect(out.find((s) => s.name === 'fs')!.managed).toBe(true);
  });

  it('expõe só as CHAVES de env (nunca valores)', () => {
    const sources: McpSource[] = [
      {
        origin: 'aluy-global',
        config: cfg({ name: 'fs', env: { TOKEN: 'super-secreto', X: 'y' } }),
      },
    ];
    const out = buildMcpListing(sources);
    expect(out[0]!.envKeys.sort()).toEqual(['TOKEN', 'X']);
    // garante que nenhum valor vaza no objeto exibível.
    expect(JSON.stringify(out)).not.toContain('super-secreto');
  });

  it('sem descoberta ⇒ estado unknown e zero tools', () => {
    const out = buildMcpListing([{ origin: 'aluy-global', config: cfg({ name: 'fs' }) }]);
    expect(out[0]!.state.kind).toBe('unknown');
    expect(out[0]!.tools).toEqual([]);
  });

  it('com descoberta ⇒ casa estado + tools prefixadas por server', () => {
    const discovery: McpDiscoveryResult = {
      servers: [
        {
          server: 'fs',
          ok: true,
          tools: [
            {
              server: 'fs',
              descriptor: { name: 'read', description: 'lê' },
              transport: {} as never,
            },
          ],
        },
        { server: 'down', ok: false, tools: [], error: 'spawn falhou' },
      ],
      tools: [],
      transports: [],
    };
    const sources: McpSource[] = [
      { origin: 'aluy-global', config: cfg({ name: 'fs' }, { name: 'down' }) },
    ];
    const out = buildMcpListing(sources, discovery);
    const fs = out.find((s) => s.name === 'fs')!;
    expect(fs.state).toEqual({ kind: 'ok', toolCount: 1 });
    expect(fs.tools[0]!.qualifiedName).toBe('mcp__fs__read');
    const down = out.find((s) => s.name === 'down')!;
    expect(down.state).toEqual({ kind: 'error', error: 'spawn falhou' });
  });

  // EST-0970 (fix) — config legada quebrada: `command:"--"` (separador do
  // `aluy mcp add <nome> -- <command>` gravado por engano) ⇒ aviso com correção pronta.
  it('invalidCommandWarning detecta command:"--" e sugere o re-add', () => {
    const sources: McpSource[] = [
      {
        origin: 'aluy-global',
        config: {
          servers: [
            { name: 'ok', command: 'npx', args: ['-y', 'X'], env: {} },
            { name: 'pw', command: '--', args: ['npx', '-y', 'X'], env: {} },
          ],
        },
      },
    ];
    const out = buildMcpListing(sources);
    expect(invalidCommandWarning(out.find((s) => s.name === 'ok')!)).toBeUndefined();
    const warning = invalidCommandWarning(out.find((s) => s.name === 'pw')!)!;
    expect(warning).toContain('command inválido "--"');
    expect(warning).toContain('aluy mcp add pw --force -- npx -y X');
  });

  it('originLabel é PT-BR legível por fonte', () => {
    expect(originLabel('aluy-global')).toContain('.aluy');
    expect(originLabel('project')).toContain('projeto');
    expect(originLabel('codex')).toContain('Codex');
  });
});
