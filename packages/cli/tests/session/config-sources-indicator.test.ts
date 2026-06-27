// EST-0979 — INDICADOR DISCRETO de quais FONTES de config carregaram (instruções
// nativo/compat, comandos global/projeto, MCP global/projeto). `describeConfigSources`
// é puro; aqui provamos as linhas formatadas e o silêncio quando nada carrega.

import { describe, expect, it } from 'vitest';
import { describeConfigSources } from '../../src/session/run.js';

describe('EST-0979 · describeConfigSources — indicador de fontes', () => {
  it('nada carregado ⇒ [] (sem nota; prompt baseline)', () => {
    expect(
      describeConfigSources({
        instructionSources: [],
        globalCommands: 0,
        projectCommands: 0,
        mcpServers: 0,
        projectMcp: false,
      }),
    ).toEqual([]);
  });

  it('instruções nativo+compat ⇒ lista as fontes na ordem de precedência', () => {
    const lines = describeConfigSources({
      instructionSources: ['AGENT.md', 'CLAUDE.md'],
      globalCommands: 0,
      projectCommands: 0,
      mcpServers: 0,
      projectMcp: false,
    });
    expect(lines.some((l) => l.includes('AGENT.md + CLAUDE.md'))).toBe(true);
  });

  it('comandos global + projeto ⇒ ambas as origens com contagem', () => {
    const lines = describeConfigSources({
      instructionSources: [],
      globalCommands: 2,
      projectCommands: 3,
      mcpServers: 0,
      projectMcp: false,
    });
    const cmd = lines.find((l) => l.startsWith('comandos:'))!;
    expect(cmd).toContain('~/.aluy/commands (2)');
    expect(cmd).toContain('.claude/commands (3)');
  });

  it('MCP com .mcp.json do projeto ⇒ indica ambas as fontes', () => {
    const lines = describeConfigSources({
      instructionSources: [],
      globalCommands: 0,
      projectCommands: 0,
      mcpServers: 2,
      projectMcp: true,
    });
    const mcp = lines.find((l) => l.startsWith('MCP:'))!;
    expect(mcp).toContain('~/.aluy/mcp.json + .mcp.json');
  });

  it('MCP só global ⇒ não menciona .mcp.json', () => {
    const lines = describeConfigSources({
      instructionSources: [],
      globalCommands: 0,
      projectCommands: 0,
      mcpServers: 1,
      projectMcp: false,
    });
    const mcp = lines.find((l) => l.startsWith('MCP:'))!;
    expect(mcp).toContain('~/.aluy/mcp.json');
    expect(mcp).not.toContain('.mcp.json');
  });

  // EST-0979 (FU-S3-CODEX-TOML) — o `~/.codex/config.toml` aparece nas fontes quando presente.
  it('MCP com Codex ⇒ lista ~/.codex/config.toml (compat Codex)', () => {
    const lines = describeConfigSources({
      instructionSources: [],
      globalCommands: 0,
      projectCommands: 0,
      mcpServers: 3,
      projectMcp: true,
      codexMcp: true,
    });
    const mcp = lines.find((l) => l.startsWith('MCP:'))!;
    expect(mcp).toContain('~/.aluy/mcp.json');
    expect(mcp).toContain('.mcp.json');
    expect(mcp).toContain('~/.codex/config.toml');
  });

  it('MCP sem Codex ⇒ não menciona ~/.codex/config.toml', () => {
    const lines = describeConfigSources({
      instructionSources: [],
      globalCommands: 0,
      projectCommands: 0,
      mcpServers: 1,
      projectMcp: false,
      codexMcp: false,
    });
    const mcp = lines.find((l) => l.startsWith('MCP:'))!;
    expect(mcp).not.toContain('~/.codex/config.toml');
  });
});
