// EST-0970 · ADR-0058 (E-B1) · CLI-SEC-7 — A CREDENCIAL DO CLI NUNCA NO ENVIRON
// DO SERVER MCP. Prova do escopo MÍNIMO de env: o environ do processo-server parte
// de um conjunto seguro de SO + o `env` DECLARADO por-server, e BARRA a credencial
// headless do CLI e segredos óbvios. (Gate FORTE do `seguranca` reconfere.)

import { describe, expect, it } from 'vitest';
import { buildServerEnv } from '../../src/mcp/stdio-transport.js';
import type { McpServerConfig } from '@aluy/cli-core';

const server: McpServerConfig = {
  name: 'fs',
  command: 'node',
  args: [],
  env: { MY_SERVER_OPT: 'ok' },
};

describe('buildServerEnv — environ MÍNIMO, sem credencial do CLI (CLI-SEC-7)', () => {
  it('NÃO repassa ALUY_TOKEN/refresh do environ do pai', () => {
    const parent = {
      ALUY_TOKEN: 'svc_secret_credential',
      ALUY_REFRESH_TOKEN: 'refresh_xyz',
      PATH: '/usr/bin',
      HOME: '/home/u',
    } as NodeJS.ProcessEnv;
    const env = buildServerEnv(server, parent);
    expect(env['ALUY_TOKEN']).toBeUndefined();
    expect(env['ALUY_REFRESH_TOKEN']).toBeUndefined();
    // chaves de SO seguras SÃO herdadas (o server precisa de PATH/HOME).
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/u');
  });

  it('NÃO repassa segredos óbvios de provider (OPENAI/ANTHROPIC/…_KEY/…SECRET)', () => {
    const parent = {
      OPENAI_API_KEY: 'sk-x',
      ANTHROPIC_API_KEY: 'sk-y',
      SOME_SECRET: 'z',
      DB_PASSWORD: 'p',
      PATH: '/b',
    } as NodeJS.ProcessEnv;
    const env = buildServerEnv(server, parent);
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['SOME_SECRET']).toBeUndefined();
    expect(env['DB_PASSWORD']).toBeUndefined();
  });

  it('passa o `env` DECLARADO por-server (escopo mínimo, DADO de config)', () => {
    const env = buildServerEnv(server, { PATH: '/b' } as NodeJS.ProcessEnv);
    expect(env['MY_SERVER_OPT']).toBe('ok');
  });

  it('um mcp.json que tente injetar ALUY_TOKEN via `env` é BARRADO (defesa-em-profundidade)', () => {
    const sneaky: McpServerConfig = {
      name: 's',
      command: 'node',
      args: [],
      env: { ALUY_TOKEN: 'stolen', GOOD: '1' },
    };
    const env = buildServerEnv(sneaky, { PATH: '/b' } as NodeJS.ProcessEnv);
    expect(env['ALUY_TOKEN']).toBeUndefined();
    expect(env['GOOD']).toBe('1');
  });

  it('environ inteiro do pai NÃO vaza (só as chaves de SO seguras)', () => {
    const parent = {
      PATH: '/b',
      HOME: '/h',
      RANDOM_USER_VAR: 'leak?',
      AWS_SESSION_TOKEN: 'tok',
    } as NodeJS.ProcessEnv;
    const env = buildServerEnv(server, parent);
    // var arbitrária do usuário NÃO é herdada (allowlist, não denylist, p/ herança).
    expect(env['RANDOM_USER_VAR']).toBeUndefined();
    expect(env['AWS_SESSION_TOKEN']).toBeUndefined();
  });
});
