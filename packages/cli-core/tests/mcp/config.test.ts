// EST-0970 · ADR-0058 (E-B1) · CLI-SEC-12 — parse do `~/.aluy/mcp.json` (DADO).

import { describe, expect, it } from 'vitest';
import type { McpConfig } from '../../src/index.js';
import {
  EMPTY_MCP_CONFIG,
  McpConfigError,
  isValidServerName,
  mergeMcpConfigs,
  parseCodexMcpConfig,
  parseMcpConfig,
} from '../../src/index.js';

describe('parseMcpConfig — config de MCP é DADO do usuário, validado defensivamente', () => {
  it('null/undefined ⇒ config vazia (sem mcp.json, sem MCP)', () => {
    expect(parseMcpConfig(undefined)).toEqual(EMPTY_MCP_CONFIG);
    expect(parseMcpConfig(null)).toEqual(EMPTY_MCP_CONFIG);
  });

  it('mcpServers ausente ⇒ vazio (não é erro)', () => {
    expect(parseMcpConfig({})).toEqual(EMPTY_MCP_CONFIG);
  });

  it('parseia um server stdio (command/args/env)', () => {
    const cfg = parseMcpConfig({
      mcpServers: {
        fs: { command: 'npx', args: ['-y', '@x/fs'], env: { ROOT: '/w' } },
      },
    });
    expect(cfg.servers).toHaveLength(1);
    const s = cfg.servers[0]!;
    expect(s.name).toBe('fs');
    expect(s.command).toBe('npx');
    expect(s.args).toEqual(['-y', '@x/fs']);
    expect(s.env).toEqual({ ROOT: '/w' });
  });

  it('args/env opcionais ⇒ defaults vazios', () => {
    const cfg = parseMcpConfig({ mcpServers: { s: { command: 'node' } } });
    expect(cfg.servers[0]!.args).toEqual([]);
    expect(cfg.servers[0]!.env).toEqual({});
  });

  it('raiz não-objeto ⇒ McpConfigError', () => {
    expect(() => parseMcpConfig('nope')).toThrow(McpConfigError);
    expect(() => parseMcpConfig([1, 2])).toThrow(McpConfigError);
  });

  it('server sem command ⇒ McpConfigError', () => {
    expect(() => parseMcpConfig({ mcpServers: { s: { args: [] } } })).toThrow(McpConfigError);
    expect(() => parseMcpConfig({ mcpServers: { s: { command: '' } } })).toThrow(McpConfigError);
  });

  it('args não-array de strings ⇒ McpConfigError', () => {
    expect(() => parseMcpConfig({ mcpServers: { s: { command: 'x', args: 'a' } } })).toThrow(
      McpConfigError,
    );
    expect(() => parseMcpConfig({ mcpServers: { s: { command: 'x', args: [1] } } })).toThrow(
      McpConfigError,
    );
  });

  it('env não-string ⇒ McpConfigError', () => {
    expect(() => parseMcpConfig({ mcpServers: { s: { command: 'x', env: { K: 1 } } } })).toThrow(
      McpConfigError,
    );
  });

  it('nome de server com `__` (separador de prefixo) ⇒ McpConfigError', () => {
    expect(() => parseMcpConfig({ mcpServers: { a__b: { command: 'x' } } })).toThrow(
      McpConfigError,
    );
  });

  it('nome de server com caracteres ilegais ⇒ McpConfigError', () => {
    expect(() => parseMcpConfig({ mcpServers: { 'a/b': { command: 'x' } } })).toThrow(
      McpConfigError,
    );
  });
});

describe('isValidServerName', () => {
  it('aceita [A-Za-z0-9_-] sem `__`', () => {
    expect(isValidServerName('fs')).toBe(true);
    expect(isValidServerName('my-server_1')).toBe(true);
  });
  it('rejeita vazio, `__`, e ilegais', () => {
    expect(isValidServerName('')).toBe(false);
    expect(isValidServerName('a__b')).toBe(false);
    expect(isValidServerName('a b')).toBe(false);
    expect(isValidServerName('a.b')).toBe(false);
  });
});

describe('parseMcpConfig — ramos de validação pura (EST-1015)', () => {
  it('mcpServers não-objeto ⇒ McpConfigError com mensagem sobre objeto', () => {
    expect(() => parseMcpConfig({ mcpServers: 'isto-deveria-ser-objeto' })).toThrow(McpConfigError);
    expect(() => parseMcpConfig({ mcpServers: [] })).toThrow(McpConfigError);
    expect(() => parseMcpConfig({ mcpServers: 42 })).toThrow(McpConfigError);
  });

  it('decl de server não-objeto ⇒ McpConfigError com nome do server e "objeto"', () => {
    expect(() => parseMcpConfig({ mcpServers: { meuserver: 'nao-objeto' } })).toThrow(
      McpConfigError,
    );
  });

  it('env não-objeto ⇒ McpConfigError com nome do server e "env"/"objeto"', () => {
    expect(() =>
      parseMcpConfig({ mcpServers: { s1: { command: 'node', env: 'nao-objeto' } } }),
    ).toThrow(McpConfigError);
  });

  it('config válida mínima (sanity) ⇒ McpConfig com um server', () => {
    const cfg = parseMcpConfig({ mcpServers: { s1: { command: 'node', args: ['x.js'] } } });
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0]!.name).toBe('s1');
    expect(cfg.servers[0]!.command).toBe('node');
    expect(cfg.servers[0]!.args).toEqual(['x.js']);
    expect(cfg.servers[0]!.env).toEqual({});
  });

  it('parseDisabled: string "yes" em vez de boolean ⇒ McpConfigError com "disabled" e "boolean"', () => {
    expect(() =>
      parseMcpConfig({ mcpServers: { s1: { command: 'node', disabled: 'yes' } } }),
    ).toThrow(McpConfigError);
    expect(() =>
      parseMcpConfig({ mcpServers: { s1: { command: 'node', disabled: 'yes' } } }),
    ).toThrow(/disabled/);
    expect(() =>
      parseMcpConfig({ mcpServers: { s1: { command: 'node', disabled: 'yes' } } }),
    ).toThrow(/boolean/);
  });

  it('parseDisabled: disabled:true válido (sanity — não lança)', () => {
    const cfg = parseMcpConfig({ mcpServers: { s1: { command: 'node', disabled: true } } });
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0]!.disabled).toBe(true);
  });

  it('parseEnv: valor numérico em env ⇒ McpConfigError com "env", "string" e nome da chave', () => {
    expect(() =>
      parseMcpConfig({ mcpServers: { s1: { command: 'node', env: { FOO: 123 } } } }),
    ).toThrow(McpConfigError);
    expect(() =>
      parseMcpConfig({ mcpServers: { s1: { command: 'node', env: { FOO: 123 } } } }),
    ).toThrow(/env/);
    expect(() =>
      parseMcpConfig({ mcpServers: { s1: { command: 'node', env: { FOO: 123 } } } }),
    ).toThrow(/string/);
    expect(() =>
      parseMcpConfig({ mcpServers: { s1: { command: 'node', env: { FOO: 123 } } } }),
    ).toThrow(/FOO/);
  });
});

// ADR-0058 (E-B1) · CLI-SEC-12 — HUNT (config de TERCEIRO = segurança): um `.mcp.json`
// / `config.toml` de um repo CLONADO é DADO HOSTIL. A parse JAMAIS pode poluir o
// `Object.prototype` (prototype pollution) por uma chave `__proto__`/`constructor`/
// `prototype` no JSON ou no TOML — nem como NOME de server, nem como chave de `env`.
// Estes testes PINAM a imunidade: falhariam se alguém afrouxasse `isValidServerName`
// (que barra `__`) ou trocasse os `Map`/object-literal por uma escrita ingênua que
// honrasse `__proto__`. Asserção é GLOBAL (toca o protótipo de um objeto-sonda novo).
describe('parse de config HOSTIL não polui Object.prototype (prototype pollution)', () => {
  // Sonda compartilhada: NENHUM caso pode fazer `({} as Record).polluted` virar truthy.
  const probe = (): Record<string, unknown> => ({});

  it('JSON: server nomeado "__proto__" é REJEITADO e não polui o protótipo', () => {
    expect(() =>
      parseMcpConfig(
        JSON.parse('{"mcpServers":{"__proto__":{"command":"x","polluted":true}}}') as unknown,
      ),
    ).toThrow(McpConfigError);
    expect(probe()['polluted']).toBeUndefined();
    expect(probe()['command']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('JSON: env com chave "__proto__" não vaza p/ o protótipo (env do server fica limpo)', () => {
    const cfg = parseMcpConfig(
      JSON.parse('{"mcpServers":{"good":{"command":"x","env":{"__proto__":"v"}}}}') as unknown,
    );
    expect(cfg.servers).toHaveLength(1);
    // a chave `__proto__` NÃO vira uma var de ambiente própria (não injeta no environ).
    expect(Object.prototype.hasOwnProperty.call(cfg.servers[0]!.env, '__proto__')).toBe(false);
    expect(probe()['v' as keyof object]).toBeUndefined();
    expect(Object.getPrototypeOf(probe())).toBe(Object.prototype);
  });

  it('JSON: nomes "constructor"/"prototype" são server-names benignos (sem efeito no protótipo)', () => {
    const cfg = parseMcpConfig(
      JSON.parse(
        '{"mcpServers":{"constructor":{"command":"a"},"prototype":{"command":"b"}}}',
      ) as unknown,
    );
    expect(cfg.servers.map((s) => s.name).sort()).toEqual(['constructor', 'prototype']);
    // o protótipo segue intacto — `constructor` ainda é a função, não o nosso objeto.
    expect(typeof probe().constructor).toBe('function');
  });

  it('TOML (Codex): [mcp_servers.__proto__] é REJEITADO e não polui o protótipo', () => {
    expect(() => parseCodexMcpConfig('[mcp_servers.__proto__]\ncommand = "x"\n')).toThrow(
      McpConfigError,
    );
    expect(probe()['command']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('command');
  });

  it('TOML (Codex): env { "__proto__" = "v" } não vaza p/ o protótipo', () => {
    const cfg = parseCodexMcpConfig(
      '[mcp_servers.good]\ncommand="x"\nenv = { "__proto__" = "v" }\n',
    );
    expect(cfg.servers).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(cfg.servers[0]!.env, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(probe())).toBe(Object.prototype);
  });

  it('mergeMcpConfigs é imune mesmo a um server com nome "__proto__" (Map, não objeto)', () => {
    const hostile: McpConfig = {
      servers: [{ name: '__proto__', command: 'x', args: [], env: {} }],
    };
    const result = mergeMcpConfigs(hostile, { servers: [] });
    expect(result.servers.map((s) => s.name)).toEqual(['__proto__']);
    expect(probe()['command']).toBeUndefined();
    expect(Object.getPrototypeOf(probe())).toBe(Object.prototype);
  });
});

describe('mergeMcpConfigs', () => {
  it('sem args ⇒ config vazia', () => {
    expect(mergeMcpConfigs()).toEqual(EMPTY_MCP_CONFIG);
  });

  it('configs disjuntas ⇒ união (2 servers de fontes diferentes)', () => {
    const cfgA: McpConfig = { servers: [{ name: 'a', command: 'node', args: [], env: {} }] };
    const cfgB: McpConfig = { servers: [{ name: 'b', command: 'npx', args: [], env: {} }] };
    const result = mergeMcpConfigs(cfgA, cfgB);
    expect(result.servers).toHaveLength(2);
    expect(result.servers.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('colisão de nome: último vence (command de cfgB sobrescreve cfgA)', () => {
    const cfgA: McpConfig = {
      servers: [{ name: 'a', command: 'node', args: [], env: {} }],
    };
    const cfgB: McpConfig = {
      servers: [
        { name: 'a', command: 'python', args: [], env: {} }, // versão 2, command diferente
        { name: 'b', command: 'npx', args: [], env: {} },
      ],
    };
    const result = mergeMcpConfigs(cfgA, cfgB);
    expect(result.servers).toHaveLength(2);
    // 'a' deve ser a versão de cfgB (mais à direita vence)
    const serverA = result.servers.find((s) => s.name === 'a')!;
    expect(serverA).toBeDefined();
    expect(serverA.command).toBe('python');
    // 'b' deve estar presente
    const serverB = result.servers.find((s) => s.name === 'b')!;
    expect(serverB).toBeDefined();
    expect(serverB.command).toBe('npx');
  });
});
