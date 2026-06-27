// EST-0979 · ADR-0058 (E-B1) · CLI-SEC-12 — leitor CONFINADO do `.mcp.json` do
// PROJETO (padrão Claude Code, no workspace) + merge projeto>global. Config de
// projeto = DADO confinado ao workspace; NÃO relaxa a catraca (conectar = ask, provado
// no core/setup). Aqui: leitura confinada + fail-safe + precedência do merge.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeMcpConfigs, type McpConfig } from '@aluy/cli-core';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { NodeFileSystemPort } from '../../src/io/fs-port.js';
import {
  ProjectMcpConfigStore,
  PROJECT_MCP_CONFIG_FILENAME,
} from '../../src/mcp/project-mcp-config.js';

function makeStore(root: string): ProjectMcpConfigStore {
  const workspace = new NodeWorkspace({ root });
  const fs = new NodeFileSystemPort({ workspace });
  return new ProjectMcpConfigStore({
    workspace,
    readFile: (p) => fs.readFile(p),
    exists: (p) => fs.exists(p),
  });
}

describe('EST-0979 · ProjectMcpConfigStore — .mcp.json confinado ao workspace', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-projmcp-'));
    root = join(base, 'project');
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function write(content: string): void {
    writeFileSync(join(root, PROJECT_MCP_CONFIG_FILENAME), content);
  }

  it('ausente ⇒ config vazia, sem erro (repo sem MCP de projeto — caso comum)', async () => {
    const r = await makeStore(root).load();
    expect(r.config.servers).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('.mcp.json válido ⇒ servers DESCOBERTOS (mesmo formato mcpServers do Claude Code)', async () => {
    write(JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', '@x/fs'] } } }));
    const r = await makeStore(root).load();
    expect(r.config.servers).toHaveLength(1);
    expect(r.config.servers[0]!.name).toBe('fs');
  });

  it('JSON inválido ⇒ config vazia + erro (não derruba o boot)', async () => {
    write('{ not json');
    const r = await makeStore(root).load();
    expect(r.config.servers).toEqual([]);
    expect(r.error).toContain('JSON inválido');
  });

  it('formato inválido (sem command) ⇒ config vazia + erro legível', async () => {
    write(JSON.stringify({ mcpServers: { bad: { args: [] } } }));
    const r = await makeStore(root).load();
    expect(r.config.servers).toEqual([]);
    expect(r.error).toContain('command');
  });

  it('CONFINAMENTO — .mcp.json symlink p/ FORA da raiz ⇒ config vazia (nada lido)', async () => {
    const outside = join(base, 'evil-mcp.json');
    writeFileSync(
      outside,
      JSON.stringify({ mcpServers: { evil: { command: 'curl', args: ['attacker'] } } }),
    );
    symlinkSync(outside, join(root, PROJECT_MCP_CONFIG_FILENAME));
    const r = await makeStore(root).load();
    // o confinamento rejeita o escape — o server malicioso de FORA nunca é descoberto.
    expect(r.config.servers).toEqual([]);
  });

  it('configPath aponta SÓ p/ dentro do workspace', async () => {
    const store = makeStore(root);
    expect(store.configPath.startsWith(root)).toBe(true);
    expect(store.configPath).toContain('.mcp.json');
  });
});

describe('EST-0979 · mergeMcpConfigs — PROJETO especializa o GLOBAL', () => {
  const global: McpConfig = {
    servers: [
      { name: 'fs', command: 'global-fs', args: [], env: {} },
      { name: 'git', command: 'global-git', args: [], env: {} },
    ],
  };
  const project: McpConfig = {
    servers: [
      { name: 'fs', command: 'project-fs', args: ['--proj'], env: {} }, // colide com global.fs
      { name: 'db', command: 'project-db', args: [], env: {} },
    ],
  };

  it('colisão de nome ⇒ a declaração do PROJETO vence', () => {
    const merged = mergeMcpConfigs(global, project);
    const fs = merged.servers.find((s) => s.name === 'fs')!;
    expect(fs.command).toBe('project-fs'); // projeto > global.
    expect(fs.args).toEqual(['--proj']);
  });

  it('servers SÓ-global e SÓ-projeto ambos sobrevivem (união)', () => {
    const merged = mergeMcpConfigs(global, project);
    const names = merged.servers.map((s) => s.name).sort();
    expect(names).toEqual(['db', 'fs', 'git']);
  });

  it('determinístico: ordem de 1ª aparição preservada', () => {
    const merged = mergeMcpConfigs(global, project);
    // fs e git aparecem 1º no global; db é novo do projeto (ao final).
    expect(merged.servers.map((s) => s.name)).toEqual(['fs', 'git', 'db']);
  });
});
