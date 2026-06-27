// EST-0979 (FU-S3-CODEX-TOML) · ADR-0058 (E-B1) · CLI-SEC-12 — leitor CONFINADO do
// `~/.codex/config.toml` (seção `[mcp_servers]`). Fail-safe: ausente/ilegível/inválido
// ⇒ config vazia (com erro legível quando o TOML é inválido). NUNCA lança.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexMcpConfigStore, CODEX_CONFIG_FILENAME } from '../../src/mcp/codex-mcp-config.js';

describe('CodexMcpConfigStore — lê ~/.codex/config.toml confinado, fail-safe', () => {
  let base: string;
  let codexHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-codex-'));
    codexHome = join(base, '.codex');
    mkdirSync(codexHome, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function writeToml(text: string): void {
    writeFileSync(join(codexHome, CODEX_CONFIG_FILENAME), text);
  }

  it('ausente ⇒ config vazia, sem erro (caso comum: sem Codex)', () => {
    const store = new CodexMcpConfigStore({ baseDir: codexHome });
    const r = store.load();
    expect(r.config.servers).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('config.toml com [mcp_servers] ⇒ servers descobertos (mesmo shape do mcp.json)', () => {
    writeToml(`
model = "gpt-5"

[mcp_servers.everything]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-everything"]
`);
    const store = new CodexMcpConfigStore({ baseDir: codexHome });
    const r = store.load();
    expect(r.config.servers).toEqual([
      {
        name: 'everything',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
        env: {},
      },
    ]);
    expect(r.error).toBeUndefined();
  });

  it('TOML inválido no subconjunto ⇒ config vazia + erro VISÍVEL (não quebra)', () => {
    writeToml('[mcp_servers.x]\ncommand = "npx\n'); // string não fechada
    const store = new CodexMcpConfigStore({ baseDir: codexHome });
    const r = store.load();
    expect(r.config.servers).toEqual([]);
    expect(r.error).toBeTruthy();
  });

  it('config.toml sem [mcp_servers] ⇒ vazio, sem erro (Codex sem MCP)', () => {
    writeToml('model = "gpt-5"\n[tui]\ntheme = "dark"\n');
    const store = new CodexMcpConfigStore({ baseDir: codexHome });
    expect(store.load().config.servers).toEqual([]);
    expect(store.load().error).toBeUndefined();
  });

  it('arquivo grande demais ⇒ config vazia (anti-arquivo-gigante adulterado)', () => {
    writeToml('# x\n'.repeat(200_000)); // > 256 KiB
    expect(new CodexMcpConfigStore({ baseDir: codexHome }).load().config.servers).toEqual([]);
  });

  it('configPath aponta pro config.toml dentro de ~/.codex/', () => {
    const store = new CodexMcpConfigStore({ baseDir: codexHome });
    expect(store.configPath).toBe(join(codexHome, 'config.toml'));
  });
});
