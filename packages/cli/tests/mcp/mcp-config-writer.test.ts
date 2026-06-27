// EST-0970 · ADR-0058 (E-B1) · CLI-SEC-12 — ESCRITOR merge-safe de `~/.aluy/mcp.json`
// (ou `.mcp.json` do projeto). Sobre tmpdir — a suíte NUNCA toca a config real do dev.
// Escrever a config é ATO DO USUÁRIO (o comando `aluy mcp`), fora do caminho do agente.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  McpConfigWriter,
  McpWriteError,
  serializeMcpConfig,
} from '../../src/mcp/mcp-config-writer.js';
import { parseMcpConfig } from '@aluy/cli-core';

describe('McpConfigWriter — escrita/merge confinada', () => {
  let base: string;
  let file: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-mcp-writer-'));
    file = join(base, '.aluy', 'mcp.json');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function read(): unknown {
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  it('add cria o arquivo (e o dir) e grava o server', () => {
    const w = new McpConfigWriter({ file });
    const { replaced } = w.add({ name: 'foo', command: 'npx', args: ['pkg'], env: { K: 'V' } });
    expect(replaced).toBe(false);
    const raw = read() as { mcpServers: Record<string, unknown> };
    expect(raw.mcpServers['foo']).toEqual({ command: 'npx', args: ['pkg'], env: { K: 'V' } });
  });

  it('add faz MERGE — preserva os outros servers', () => {
    mkdirSync(join(base, '.aluy'), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { keep: { command: 'node', args: [] } } }));
    const w = new McpConfigWriter({ file });
    w.add({ name: 'foo', command: 'npx', args: [], env: {} });
    const cfg = parseMcpConfig(read());
    expect(cfg.servers.map((s) => s.name).sort()).toEqual(['foo', 'keep']);
  });

  it('nome duplicado SEM --force ⇒ McpWriteError (não sobrescreve)', () => {
    const w = new McpConfigWriter({ file });
    w.add({ name: 'foo', command: 'npx', args: [], env: {} });
    expect(() => w.add({ name: 'foo', command: 'other', args: [], env: {} })).toThrow(
      McpWriteError,
    );
    // o original permaneceu
    expect(
      (read() as { mcpServers: Record<string, { command: string }> }).mcpServers['foo']!.command,
    ).toBe('npx');
  });

  it('--force sobrescreve o homônimo (replaced=true) e preserva os outros', () => {
    const w = new McpConfigWriter({ file });
    w.add({ name: 'foo', command: 'npx', args: [], env: {} });
    w.add({ name: 'bar', command: 'node', args: [], env: {} });
    const { replaced } = w.add(
      { name: 'foo', command: 'deno', args: [], env: {} },
      { force: true },
    );
    expect(replaced).toBe(true);
    const cfg = parseMcpConfig(read());
    expect(cfg.servers.find((s) => s.name === 'foo')!.command).toBe('deno');
    expect(cfg.servers.find((s) => s.name === 'bar')).toBeDefined();
  });

  it('remove tira o server e preserva os demais', () => {
    const w = new McpConfigWriter({ file });
    w.add({ name: 'foo', command: 'npx', args: [], env: {} });
    w.add({ name: 'bar', command: 'node', args: [], env: {} });
    const { removed } = w.remove('foo');
    expect(removed).toBe(true);
    const cfg = parseMcpConfig(read());
    expect(cfg.servers.map((s) => s.name)).toEqual(['bar']);
  });

  it('remove de server ausente ⇒ removed=false (não é erro fatal)', () => {
    const w = new McpConfigWriter({ file });
    w.add({ name: 'foo', command: 'npx', args: [], env: {} });
    expect(w.remove('nope').removed).toBe(false);
  });

  it('nome inválido ⇒ McpWriteError (não grava prefixo de tool ambíguo)', () => {
    const w = new McpConfigWriter({ file });
    expect(() => w.add({ name: 'a b', command: 'npx', args: [], env: {} })).toThrow(McpWriteError);
    expect(() => w.add({ name: 'x__y', command: 'npx', args: [], env: {} })).toThrow(McpWriteError);
  });

  it('command vazio ⇒ McpWriteError', () => {
    const w = new McpConfigWriter({ file });
    expect(() => w.add({ name: 'foo', command: '   ', args: [], env: {} })).toThrow(McpWriteError);
  });

  // EST-0970 (fix) — `--` é o SEPARADOR do `aluy mcp add`, nunca um command real:
  // defesa em profundidade — `command:"--"` não é gravável por NENHUM caminho.
  it('command "--" ⇒ McpWriteError (separador nunca vira config)', () => {
    const w = new McpConfigWriter({ file });
    expect(() => w.add({ name: 'pw', command: '--', args: ['npx'], env: {} })).toThrow(/separador/);
    expect(() => w.add({ name: 'pw', command: ' -- ', args: [], env: {} })).toThrow(McpWriteError);
  });

  it('arquivo existente com JSON inválido ⇒ McpWriteError (não destrói cegamente)', () => {
    mkdirSync(join(base, '.aluy'), { recursive: true });
    writeFileSync(file, '{ not json');
    const w = new McpConfigWriter({ file });
    expect(() => w.add({ name: 'foo', command: 'npx', args: [], env: {} })).toThrow(McpWriteError);
  });

  it('serializeMcpConfig omite env vazio e mantém ordem', () => {
    const json = serializeMcpConfig({
      servers: [
        { name: 'a', command: 'x', args: ['1'], env: {} },
        { name: 'b', command: 'y', args: [], env: { K: 'v' } },
      ],
    });
    const obj = JSON.parse(json) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(obj.mcpServers['a']).toEqual({ command: 'x', args: ['1'] });
    expect(obj.mcpServers['b']).toEqual({ command: 'y', args: [], env: { K: 'v' } });
  });

  // ═════════════════════════════════════════════════════════════════════
  // EST-1013 — endurecimento: cobertura de 2 ramos do load()
  // ═════════════════════════════════════════════════════════════════════

  it('arquivo grande demais (> MAX_MCP_BYTES) ⇒ McpWriteError', () => {
    mkdirSync(join(base, '.aluy'), { recursive: true });
    // Gera ~257KB (passa o teto de 256KB) com uma string repetida
    const bigPayload = 'x'.repeat(257 * 1024);
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { huge: { command: 'echo', args: [bigPayload] } } }),
    );
    const w = new McpConfigWriter({ file });
    expect(() => w.add({ name: 'foo', command: 'npx', args: [], env: {} })).toThrow(McpWriteError);
    // mensagem deve conter 'grande demais'
    expect(() => w.add({ name: 'foo', command: 'npx', args: [], env: {} })).toThrow(
      /grande demais/,
    );
  });

  it('config malformada (mcpServers string em vez de objeto) ⇒ McpWriteError', () => {
    mkdirSync(join(base, '.aluy'), { recursive: true });
    // JSON válido, mas "mcpServers" é string → parseMcpConfig rejeita com McpConfigError
    writeFileSync(file, JSON.stringify({ mcpServers: 'isto-deveria-ser-objeto' }));
    const w = new McpConfigWriter({ file });
    expect(() => w.add({ name: 'foo', command: 'npx', args: [], env: {} })).toThrow(McpWriteError);
    expect(() => w.add({ name: 'foo', command: 'npx', args: [], env: {} })).toThrow(/objeto/);
  });
});
