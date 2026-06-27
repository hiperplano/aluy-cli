// EST-0970 (ciclo MCP na sessão) — `McpConfigWriter.setDisabled`: o interruptor
// `disabled` gravado pelo MESMO writer do #81 (atômico, merge, 0600), sobre tmpdir.
// Desativar NÃO desinstala: command/args/env ficam intactos; `enable` remove o campo.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpConfigWriter, serializeMcpConfig } from '../../src/mcp/mcp-config-writer.js';
import { parseMcpConfig } from '@aluy/cli-core';

describe('McpConfigWriter.setDisabled — desliga sem desinstalar', () => {
  let base: string;
  let file: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-mcp-disable-'));
    file = join(base, '.aluy', 'mcp.json');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function read(): { mcpServers: Record<string, Record<string, unknown>> } {
    return JSON.parse(readFileSync(file, 'utf8')) as never;
  }

  it('disable grava disabled:true preservando a declaração e os outros servers', () => {
    const w = new McpConfigWriter({ file });
    w.add({ name: 'pw', command: 'npx', args: ['-y', '@playwright/mcp'], env: { K: 'V' } });
    w.add({ name: 'keep', command: 'node', args: [], env: {} });

    const { found } = w.setDisabled('pw', true);
    expect(found).toBe(true);
    const raw = read();
    expect(raw.mcpServers['pw']).toEqual({
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
      env: { K: 'V' },
      disabled: true,
    });
    // o vizinho não foi tocado (merge, não sobrescrita).
    expect(raw.mcpServers['keep']).toEqual({ command: 'node', args: [] });
  });

  it('enable REMOVE o campo (ausente = ativo — config mínima)', () => {
    const w = new McpConfigWriter({ file });
    w.add({ name: 'pw', command: 'npx', args: [], env: {} });
    w.setDisabled('pw', true);
    const { found } = w.setDisabled('pw', false);
    expect(found).toBe(true);
    expect(read().mcpServers['pw']).toEqual({ command: 'npx', args: [] });
    // o parser do core também o vê ativo.
    expect(parseMcpConfig(read()).servers[0]!.disabled).toBeUndefined();
  });

  it('server ausente ⇒ found:false (sem criar arquivo fantasma)', () => {
    const w = new McpConfigWriter({ file });
    expect(w.setDisabled('ghost', true)).toEqual({ found: false });
    expect(() => statSync(file)).toThrow(); // nada foi gravado.
  });

  it('a escrita preserva o modo 0600 (config do usuário)', () => {
    const w = new McpConfigWriter({ file });
    w.add({ name: 'pw', command: 'npx', args: [], env: {} });
    w.setDisabled('pw', true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('serializeMcpConfig persiste disabled SÓ quando ligado', () => {
    const on = serializeMcpConfig({
      servers: [{ name: 'a', command: 'npx', args: [], env: {}, disabled: true }],
    });
    expect(JSON.parse(on).mcpServers.a.disabled).toBe(true);
    const off = serializeMcpConfig({ servers: [{ name: 'a', command: 'npx', args: [], env: {} }] });
    expect('disabled' in JSON.parse(off).mcpServers.a).toBe(false);
  });
});
