// EST-0970 · ADR-0058 (E-B1) · CLI-SEC-12 — leitor CONFINADO de `~/.aluy/mcp.json`.
//
// SÓ-LEITURA: a ESCRITA de `~/.aluy/mcp.json` pelo agente é DENY pela catraca
// (`aluy-config-write-deny`) — provado no core (mcp-gate). Aqui provamos a leitura
// confinada + fail-safe, sobre um tmpdir (a suíte nunca toca o `~/.aluy/` real).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpConfigStore, MCP_CONFIG_FILENAME } from '../../src/mcp/mcp-config-store.js';

describe('McpConfigStore — leitura confinada de ~/.aluy/mcp.json', () => {
  let base: string;
  let aluyHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-mcp-'));
    aluyHome = join(base, '.aluy');
    mkdirSync(aluyHome, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function write(content: string): void {
    writeFileSync(join(aluyHome, MCP_CONFIG_FILENAME), content);
  }

  it('arquivo ausente ⇒ config vazia, sem erro (caso comum: sem MCP)', () => {
    const store = new McpConfigStore({ baseDir: aluyHome });
    const r = store.load();
    expect(r.config.servers).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('parseia um server válido', () => {
    write(JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', '@x/fs'] } } }));
    const r = new McpConfigStore({ baseDir: aluyHome }).load();
    expect(r.config.servers).toHaveLength(1);
    expect(r.config.servers[0]!.name).toBe('fs');
  });

  it('JSON inválido ⇒ config vazia + erro (não derruba o boot)', () => {
    write('{ not json');
    const r = new McpConfigStore({ baseDir: aluyHome }).load();
    expect(r.config.servers).toEqual([]);
    expect(r.error).toContain('JSON inválido');
  });

  it('formato inválido ⇒ config vazia + erro legível', () => {
    write(JSON.stringify({ mcpServers: { bad: { args: [] } } })); // sem command
    const r = new McpConfigStore({ baseDir: aluyHome }).load();
    expect(r.config.servers).toEqual([]);
    expect(r.error).toContain('command');
  });

  it('configPath aponta SÓ p/ dentro de ~/.aluy/ (confinado)', () => {
    const store = new McpConfigStore({ baseDir: aluyHome });
    expect(store.configPath).toBe(join(aluyHome, 'mcp.json'));
  });

  it('arquivo gigante (anti-adulteração) ⇒ ignorado (config vazia)', () => {
    write(JSON.stringify({ mcpServers: { fs: { command: 'x' } } }) + ' '.repeat(300 * 1024));
    const r = new McpConfigStore({ baseDir: aluyHome }).load();
    expect(r.config.servers).toEqual([]);
  });
});
