// EST-0979 (FU-S3-CODEX-TOML) · ADR-0058 (E-B1) · CLI-SEC-12 — parser TOML CONFINADO
// do subconjunto `[mcp_servers]` do `~/.codex/config.toml`. Produz o MESMO `McpConfig`
// das fontes JSON. DEFENSIVO: rejeita o subconjunto malformado; ignora o resto.

import { describe, expect, it } from 'vitest';
import { EMPTY_MCP_CONFIG, McpConfigError, parseCodexMcpConfig } from '../../src/index.js';

describe('parseCodexMcpConfig — subconjunto [mcp_servers] do config.toml do Codex', () => {
  it('vazio / sem [mcp_servers] ⇒ config vazia (caso comum: Codex sem MCP)', () => {
    expect(parseCodexMcpConfig('')).toEqual(EMPTY_MCP_CONFIG);
    expect(parseCodexMcpConfig('model = "gpt-5"\n[ui]\ntheme = "dark"\n')).toEqual(
      EMPTY_MCP_CONFIG,
    );
  });

  it('um server básico (command/args/env tabela inline) — mesmo shape do mcp.json', () => {
    const toml = `
[mcp_servers.everything]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-everything"]
env = { API_KEY = "x", "FOO" = "bar" }
`;
    const cfg = parseCodexMcpConfig(toml);
    expect(cfg.servers).toEqual([
      {
        name: 'everything',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
        env: { API_KEY: 'x', FOO: 'bar' },
      },
    ]);
  });

  it('env como SUB-TABELA [mcp_servers.<nome>.env] (chaves soltas)', () => {
    const toml = `
[mcp_servers.fs]
command = "python"
args = ["-m", "server"]

[mcp_servers.fs.env]
ROOT = "."
LEVEL = "debug"
`;
    const cfg = parseCodexMcpConfig(toml);
    expect(cfg.servers).toEqual([
      { name: 'fs', command: 'python', args: ['-m', 'server'], env: { ROOT: '.', LEVEL: 'debug' } },
    ]);
  });

  it('múltiplos servers, ordem de 1ª aparição preservada', () => {
    const toml = `
[mcp_servers.alpha]
command = "a"
[mcp_servers.beta]
command = "b"
`;
    expect(parseCodexMcpConfig(toml).servers.map((s) => s.name)).toEqual(['alpha', 'beta']);
  });

  it('IGNORA seções/chaves fora de [mcp_servers] (config.toml do Codex é grande)', () => {
    const toml = `
# config global do Codex
model = "gpt-5"
approval_policy = "on-request"

[tui]
theme = "dark"

[mcp_servers.git]
command = "uvx"
args = ["mcp-server-git"]

[profiles.work]
model = "gpt-5-codex"
`;
    const cfg = parseCodexMcpConfig(toml);
    expect(cfg.servers).toEqual([
      { name: 'git', command: 'uvx', args: ['mcp-server-git'], env: {} },
    ]);
  });

  it('IGNORA chaves desconhecidas DENTRO de um server (ex.: startup_timeout_ms)', () => {
    const toml = `
[mcp_servers.x]
command = "c"
startup_timeout_ms = 20000
tool_timeout_sec = 60
`;
    expect(parseCodexMcpConfig(toml).servers).toEqual([
      { name: 'x', command: 'c', args: [], env: {} },
    ]);
  });

  it('comentários inline e linhas de comentário são respeitados (# fora de string)', () => {
    const toml = `
[mcp_servers.x]  # abre o server x
command = "npx"  # o comando
args = ["-y", "pkg#hash"]  # '#' DENTRO da string não é comentário
`;
    const cfg = parseCodexMcpConfig(toml);
    expect(cfg.servers[0]!.command).toBe('npx');
    expect(cfg.servers[0]!.args).toEqual(['-y', 'pkg#hash']);
  });

  it('string literal (aspas simples) não interpreta escapes', () => {
    const toml = `
[mcp_servers.x]
command = 'C:\\tools\\node'
`;
    expect(parseCodexMcpConfig(toml).servers[0]!.command).toBe('C:\\tools\\node');
  });

  it('nome de server inválido ⇒ McpConfigError (vira prefixo de tool)', () => {
    expect(() => parseCodexMcpConfig('[mcp_servers."a b"]\ncommand = "c"\n')).toThrow(
      McpConfigError,
    );
  });

  it('server sem command ⇒ McpConfigError (via parseMcpConfig)', () => {
    expect(() => parseCodexMcpConfig('[mcp_servers.x]\nargs = ["a"]\n')).toThrow(McpConfigError);
  });

  it('args não-array ⇒ McpConfigError', () => {
    expect(() => parseCodexMcpConfig('[mcp_servers.x]\ncommand = "c"\nargs = "nope"\n')).toThrow(
      McpConfigError,
    );
  });

  it('item de args não-string ⇒ McpConfigError', () => {
    expect(() => parseCodexMcpConfig('[mcp_servers.x]\ncommand = "c"\nargs = ["a", 3]\n')).toThrow(
      McpConfigError,
    );
  });

  it('env inline com valor não-string ⇒ McpConfigError', () => {
    expect(() => parseCodexMcpConfig('[mcp_servers.x]\ncommand = "c"\nenv = { K = 3 }\n')).toThrow(
      McpConfigError,
    );
  });

  it('string não fechada ⇒ McpConfigError (não confia cegamente)', () => {
    expect(() => parseCodexMcpConfig('[mcp_servers.x]\ncommand = "npx\n')).toThrow(McpConfigError);
  });

  it('sub-tabela não suportada do server ⇒ McpConfigError', () => {
    expect(() => parseCodexMcpConfig('[mcp_servers.x.weird]\nk = "v"\n')).toThrow(McpConfigError);
  });

  it('cabeçalho de tabela malformado ⇒ McpConfigError', () => {
    expect(() => parseCodexMcpConfig('[mcp_servers.x\ncommand = "c"\n')).toThrow(McpConfigError);
  });

  it('args vazio e env vazio normalizam p/ default', () => {
    const cfg = parseCodexMcpConfig('[mcp_servers.x]\ncommand = "c"\nargs = []\nenv = {}\n');
    expect(cfg.servers).toEqual([{ name: 'x', command: 'c', args: [], env: {} }]);
  });

  it('env.KEY = "v" (chave pontilhada no corpo do server) vira env do server', () => {
    const cfg = parseCodexMcpConfig('[mcp_servers.x]\ncommand = "c"\nenv.ROOT = "."\n');
    expect(cfg.servers[0]!.env).toEqual({ ROOT: '.' });
  });

  it('escapes básicos comuns (\\n \\t \\") desempacotam', () => {
    const cfg = parseCodexMcpConfig('[mcp_servers.x]\ncommand = "a\\tb"\n');
    expect(cfg.servers[0]!.command).toBe('a\tb');
  });

  it('NÃO executa nada do arquivo — TOML é DADO, não código (sem efeito colateral)', () => {
    // Um "comando" no arquivo é só texto: vira o campo `command` (lançado depois ATRÁS
    // da catraca), nunca executado pelo parser.
    const cfg = parseCodexMcpConfig('[mcp_servers.x]\ncommand = "rm -rf /"\n');
    expect(cfg.servers[0]!.command).toBe('rm -rf /'); // dado inerte, não rodou nada.
  });

  // ── EST-1015: endurecimento de cobertura (ramos de erro do inline-table e splitTopLevel) ──

  it('(1) inline-table de env sem "=" (item sem K = "v") ⇒ McpConfigError', () => {
    // env = { FOO } — falta '=' no item da inline-table, o `findTopLevelEquals` retorna -1
    // e o parser lança o erro de "esperava K = "v"".
    const toml = `[mcp_servers.x]\ncommand = "c"\nenv = { FOO }\n`;
    expect(() => parseCodexMcpConfig(toml)).toThrow(McpConfigError);
    // Verifica a mensagem específica do ramo (linha 364 do codex-toml.ts)
    expect(() => parseCodexMcpConfig(toml)).toThrow(/esperava K = "v"/);
  });

  it('(2) chave pontilhada no inline-table (a.b = "x") ⇒ McpConfigError', () => {
    // env = { a.b = "x" } — keySegs.length !== 1, dispara "chave inválida"
    const toml = `[mcp_servers.x]\ncommand = "c"\nenv = { a.b = "x" }\n`;
    expect(() => parseCodexMcpConfig(toml)).toThrow(McpConfigError);
    expect(() => parseCodexMcpConfig(toml)).toThrow(/chave inválida/);
  });

  it('(3) valor não-string no inline-table (FOO = 123) ⇒ McpConfigError', () => {
    // env = { FOO = 123 } — parseTomlString retorna undefined, dispara "deve ser string"
    const toml = `[mcp_servers.x]\ncommand = "c"\nenv = { FOO = 123 }\n`;
    expect(() => parseCodexMcpConfig(toml)).toThrow(McpConfigError);
    expect(() => parseCodexMcpConfig(toml)).toThrow(/deve ser string/);
  });

  it('(4) splitTopLevel respeita string/colchete — args com "," DENTRO de string', () => {
    // args = ["a,b", "c"] — a vírgula dentro de "a,b" NÃO deve dividir; o array final
    // deve ter exatamente 2 elementos: "a,b" e "c".
    const toml = `[mcp_servers.x]\ncommand = "c"\nargs = ["a,b", "c"]\n`;
    const cfg = parseCodexMcpConfig(toml);
    expect(cfg.servers[0]!.args).toEqual(['a,b', 'c']);
  });

  it('(4b) splitTopLevel respeita string/colchete — env inline-table com "," em valor', () => {
    // env = { KEY = "a,b" } — a vírgula dentro do valor não divide a tabela
    const toml = `[mcp_servers.x]\ncommand = "c"\nenv = { KEY = "a,b" }\n`;
    const cfg = parseCodexMcpConfig(toml);
    expect(cfg.servers[0]!.env).toEqual({ KEY: 'a,b' });
  });
});
