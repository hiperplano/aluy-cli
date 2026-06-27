// EST-0970 · ADR-0058 · CLI-SEC-12 — setupMcp: lê config, descobre, adapta, fecha.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupMcp, MCP_TRUST_WARNING } from '../../src/mcp/setup.js';
import {
  PolicyPermissionEngine,
  type McpCallResult,
  type McpToolDescriptor,
  type McpTransport,
} from '@aluy/cli-core';

function fakeTransport(tools: McpToolDescriptor[]): McpTransport & { closed: boolean } {
  return {
    closed: false,
    async connect() {
      return tools;
    },
    async callTool(): Promise<McpCallResult> {
      return { ok: true, content: 'x' };
    },
    async close() {
      this.closed = true;
    },
  };
}

describe('setupMcp — wiring de descoberta sobre ~/.aluy/mcp.json', () => {
  let base: string;
  let aluyHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-mcp-setup-'));
    aluyHome = join(base, '.aluy');
    mkdirSync(aluyHome, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function writeConfig(obj: unknown): void {
    writeFileSync(join(aluyHome, 'mcp.json'), JSON.stringify(obj));
  }

  it('sem mcp.json ⇒ zero tools (sem MCP)', async () => {
    const setup = await setupMcp({ aluyHome });
    expect(setup.tools).toEqual([]);
    await setup.close();
  });

  it('descobre + adapta as tools (prefixadas, efeito por padrão)', async () => {
    writeConfig({ mcpServers: { fs: { command: 'x' } } });
    const transport = fakeTransport([{ name: 'read', description: 'lê' }]);
    const setup = await setupMcp({ aluyHome, makeTransport: () => transport });
    expect(setup.tools.map((t) => t.name)).toEqual(['mcp__fs__read']);
    expect(setup.tools[0]!.effect).toBe('mcp');
    await setup.close();
    expect(transport.closed).toBe(true);
  });

  it('as tools descobertas passam pela catraca como EFEITO (ask em normal)', async () => {
    writeConfig({ mcpServers: { fs: { command: 'x' } } });
    const transport = fakeTransport([{ name: 'read', description: 'd' }]);
    const setup = await setupMcp({ aluyHome, makeTransport: () => transport });
    const engine = new PolicyPermissionEngine();
    const v = engine.decide({ name: setup.tools[0]!.name, input: { foo: 'bar' } });
    expect(v.decision).toBe('ask');
    await setup.close();
  });

  it('config inválida ⇒ configError, sem tools (não derruba)', async () => {
    writeFileSync(join(aluyHome, 'mcp.json'), '{ bad json');
    const setup = await setupMcp({ aluyHome });
    expect(setup.tools).toEqual([]);
    expect(setup.configError).toBeTruthy();
    await setup.close();
  });

  it('MCP_TRUST_WARNING documenta o limite de sandbox (FU-VAU-11-bis)', () => {
    expect(MCP_TRUST_WARNING).toContain('privilégios');
    expect(MCP_TRUST_WARNING).toMatch(/sandbox de SO|CLI-SEC-H1/);
  });

  // EST-0979 — .mcp.json do PROJETO mesclado ao global (projeto > global), passando
  // pela MESMA descoberta/catraca. Config de projeto = DADO; conectar = ask igual.
  it('EST-0979 — server do .mcp.json do PROJETO é descoberto (além do global)', async () => {
    writeConfig({ mcpServers: { fsglobal: { command: 'g' } } });
    const transport = fakeTransport([{ name: 'read', description: 'd' }]);
    const setup = await setupMcp({
      aluyHome,
      makeTransport: () => transport,
      loadProjectConfig: async () => ({
        config: { servers: [{ name: 'fsproj', command: 'p', args: [], env: {} }] },
      }),
    });
    const names = setup.tools.map((t) => t.name).sort();
    expect(names).toContain('mcp__fsglobal__read'); // global sobrevive.
    expect(names).toContain('mcp__fsproj__read'); // projeto descoberto.
    await setup.close();
  });

  it('EST-0979 — colisão de nome: o server do PROJETO VENCE o global (projeto > global)', async () => {
    // global e projeto declaram "shared" com COMMANDS diferentes.
    writeConfig({ mcpServers: { shared: { command: 'GLOBAL-CMD' } } });
    const seenCommands: string[] = [];
    const setup = await setupMcp({
      aluyHome,
      makeTransport: (server) => {
        seenCommands.push(server.command);
        return fakeTransport([{ name: 'read', description: 'd' }]);
      },
      loadProjectConfig: async () => ({
        config: { servers: [{ name: 'shared', command: 'PROJECT-CMD', args: [], env: {} }] },
      }),
    });
    // um único "shared" foi lançado — com o command do PROJETO (venceu o global).
    expect(seenCommands).toEqual(['PROJECT-CMD']);
    expect(setup.tools.map((t) => t.name)).toEqual(['mcp__shared__read']);
    await setup.close();
  });

  it('EST-0979 — server do PROJETO passa pela catraca como EFEITO (ask) — config de projeto NÃO relaxa', async () => {
    const transport = fakeTransport([{ name: 'read', description: 'd' }]);
    const setup = await setupMcp({
      aluyHome, // sem mcp.json global
      makeTransport: () => transport,
      loadProjectConfig: async () => ({
        config: { servers: [{ name: 'projsrv', command: 'p', args: [], env: {} }] },
      }),
    });
    const engine = new PolicyPermissionEngine();
    const v = engine.decide({ name: setup.tools[0]!.name, input: { foo: 'bar' } });
    expect(v.decision).toBe('ask'); // conectar/usar um server do projeto é ASK.
    await setup.close();
  });

  it('EST-0979 — erro do .mcp.json do projeto é AGREGADO ao configError (UX avisa)', async () => {
    const setup = await setupMcp({
      aluyHome,
      loadProjectConfig: async () => ({
        config: { servers: [] },
        error: '.mcp.json: JSON inválido — MCP de projeto desativado.',
      }),
    });
    expect(setup.configError).toContain('.mcp.json');
    await setup.close();
  });

  // EST-0979 (FU-S3-CODEX-TOML) — server do `~/.codex/config.toml` MESCLADO na cadeia,
  // como fonte de MENOR precedência, passando pela MESMA descoberta/catraca.
  it('EST-0979 — server do CODEX (config.toml) é descoberto (além do global/projeto)', async () => {
    writeConfig({ mcpServers: { aluysrv: { command: 'a' } } });
    const transport = fakeTransport([{ name: 'read', description: 'd' }]);
    const setup = await setupMcp({
      aluyHome,
      makeTransport: () => transport,
      loadCodexConfig: () => ({
        config: { servers: [{ name: 'codexsrv', command: 'c', args: [], env: {} }] },
      }),
      loadProjectConfig: async () => ({
        config: { servers: [{ name: 'projsrv', command: 'p', args: [], env: {} }] },
      }),
    });
    const names = setup.tools.map((t) => t.name).sort();
    expect(names).toContain('mcp__aluysrv__read');
    expect(names).toContain('mcp__projsrv__read');
    expect(names).toContain('mcp__codexsrv__read'); // Codex descoberto.
    await setup.close();
  });

  it('EST-0979 — PRECEDÊNCIA: `.aluy` global VENCE o Codex em colisão de nome', async () => {
    // Codex e global declaram "shared" com COMMANDS diferentes; o global (`.aluy`) vence.
    writeConfig({ mcpServers: { shared: { command: 'ALUY-CMD' } } });
    const seenCommands: string[] = [];
    const setup = await setupMcp({
      aluyHome,
      makeTransport: (server) => {
        seenCommands.push(server.command);
        return fakeTransport([{ name: 'read', description: 'd' }]);
      },
      loadCodexConfig: () => ({
        config: { servers: [{ name: 'shared', command: 'CODEX-CMD', args: [], env: {} }] },
      }),
    });
    expect(seenCommands).toEqual(['ALUY-CMD']); // `.aluy` global venceu o Codex.
    expect(setup.tools.map((t) => t.name)).toEqual(['mcp__shared__read']);
    await setup.close();
  });

  it('EST-0979 — PRECEDÊNCIA: projeto VENCE o Codex em colisão de nome', async () => {
    const seenCommands: string[] = [];
    const setup = await setupMcp({
      aluyHome, // sem global
      makeTransport: (server) => {
        seenCommands.push(server.command);
        return fakeTransport([{ name: 'read', description: 'd' }]);
      },
      loadCodexConfig: () => ({
        config: { servers: [{ name: 'shared', command: 'CODEX-CMD', args: [], env: {} }] },
      }),
      loadProjectConfig: async () => ({
        config: { servers: [{ name: 'shared', command: 'PROJECT-CMD', args: [], env: {} }] },
      }),
    });
    expect(seenCommands).toEqual(['PROJECT-CMD']); // projeto venceu o Codex.
    await setup.close();
  });

  it('EST-0979 — server do CODEX passa pela catraca como EFEITO (ask) — não relaxa', async () => {
    const transport = fakeTransport([{ name: 'read', description: 'd' }]);
    const setup = await setupMcp({
      aluyHome, // sem global, sem projeto
      makeTransport: () => transport,
      loadCodexConfig: () => ({
        config: { servers: [{ name: 'codexsrv', command: 'c', args: [], env: {} }] },
      }),
    });
    const engine = new PolicyPermissionEngine();
    const v = engine.decide({ name: setup.tools[0]!.name, input: { foo: 'bar' } });
    expect(v.decision).toBe('ask'); // usar um server do Codex é ASK.
    await setup.close();
  });

  it('EST-0979 — erro do config.toml do Codex é AGREGADO ao configError (UX avisa)', async () => {
    const setup = await setupMcp({
      aluyHome,
      loadCodexConfig: () => ({
        config: { servers: [] },
        error: 'config.toml: string não fechada.',
      }),
    });
    expect(setup.configError).toContain('config.toml');
    await setup.close();
  });

  // HUNT-CAP (#266) — um server que estoura o teto de tools por server tem o excesso
  // cortado e o aviso SOBE no `McpSetup.warnings` (a UX exibe no boot). Sem segredo.
  it('HUNT-CAP — server com tools demais ⇒ excesso cortado + aviso em McpSetup.warnings', async () => {
    writeConfig({ mcpServers: { fat: { command: 'x' } } });
    const many: McpToolDescriptor[] = Array.from({ length: 200 }, (_, i) => ({
      name: `t${i}`,
      description: 'd',
    }));
    const setup = await setupMcp({ aluyHome, makeTransport: () => fakeTransport(many) });
    // só o teto (128) entra no toolset.
    expect(setup.tools).toHaveLength(128);
    expect(setup.warnings).toBeDefined();
    expect(setup.warnings!.join('\n')).toContain('fat');
    expect(setup.warnings!.join('\n')).toContain('200');
    await setup.close();
  });

  it('HUNT-CAP — caso comum (poucas tools) ⇒ sem warnings (campo ausente)', async () => {
    writeConfig({ mcpServers: { fs: { command: 'x' } } });
    const setup = await setupMcp({
      aluyHome,
      makeTransport: () => fakeTransport([{ name: 'read', description: 'lê' }]),
    });
    expect(setup.warnings).toBeUndefined();
    await setup.close();
  });
});
