// ADR-0120 / EST-1113 — resolução da config do backend local (flag>env>config>default).
import { describe, expect, it } from 'vitest';
import {
  resolveModelBackend,
  resolveLocalProviderConfig,
} from '../../../src/model/local/config.js';
import { buildLocalCatalog } from '@hiperplano/aluy-cli-core';
import type { UserConfig } from '../../../src/io/user-config.js';

describe('resolveModelBackend', () => {
  it('default local (BYO); env ALUY_BACKEND e config respeitados', () => {
    expect(resolveModelBackend({ env: {}, config: {} })).toBe('local');
    expect(resolveModelBackend({ env: { ALUY_BACKEND: 'broker' }, config: {} })).toBe('broker');
    expect(resolveModelBackend({ env: {}, config: { backend: 'broker' } })).toBe('broker');
  });
  it('flag vence env e config', () => {
    expect(
      resolveModelBackend({
        flag: 'local',
        env: { ALUY_BACKEND: 'broker' },
        config: { backend: 'broker' },
      }),
    ).toBe('local');
  });
});

describe('resolveLocalProviderConfig — provider/model/auth/base_url', () => {
  it('defaults: anthropic + claude-opus-4-8 + apikey', () => {
    const c = resolveLocalProviderConfig({ env: {}, config: {} });
    expect(c).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8', auth: 'apikey' });
  });

  it('flags vencem env e config', () => {
    const c = resolveLocalProviderConfig({
      flags: {
        localProvider: 'openrouter',
        localModel: 'anthropic/claude-3.5-sonnet',
        localAuth: 'apikey',
      },
      env: { ALUY_LOCAL_PROVIDER: 'openai', ALUY_LOCAL_MODEL: 'gpt-4o' },
      config: { localProvider: 'anthropic' },
    });
    expect(c.provider).toBe('openrouter');
    expect(c.model).toBe('anthropic/claude-3.5-sonnet');
  });

  it('env vence config no provider; sem model em env/flag, default do provider escolhido', () => {
    const c = resolveLocalProviderConfig({
      env: { ALUY_LOCAL_PROVIDER: 'openrouter' },
      config: { localProvider: 'openai' }, // sem localModel na config
    });
    expect(c.provider).toBe('openrouter');
    expect(c.model).toBe('anthropic/claude-3.5-sonnet'); // default do openrouter.
  });

  it('model da config aplica quando não há env/flag de model (campo independente do provider)', () => {
    const c = resolveLocalProviderConfig({
      env: { ALUY_LOCAL_PROVIDER: 'openrouter' },
      config: { localModel: 'x/y' },
    });
    expect(c.provider).toBe('openrouter');
    expect(c.model).toBe('x/y');
  });

  it('oauth e base_url via env', () => {
    const c = resolveLocalProviderConfig({
      env: {
        ALUY_BACKEND: 'local',
        ALUY_LOCAL_AUTH: 'oauth',
        ALUY_LOCAL_BASE_URL: 'https://gw.test/v1',
      },
      config: {},
    });
    expect(c.auth).toBe('oauth');
    expect(c.baseUrl).toBe('https://gw.test/v1');
  });

  it('config persistida é respeitada quando não há flag/env', () => {
    const config: UserConfig = {
      localProvider: 'openai',
      localModel: 'gpt-4o',
      localAuth: 'apikey',
    };
    const c = resolveLocalProviderConfig({ env: {}, config });
    expect(c).toEqual({ provider: 'openai', model: 'gpt-4o', auth: 'apikey' });
  });

  // ADR-0118 — provider do catálogo embutido (config-driven), além dos 3 antigos.
  it('provider do catálogo embutido (deepseek) ⇒ default model do catálogo', () => {
    const c = resolveLocalProviderConfig({
      env: { ALUY_LOCAL_PROVIDER: 'deepseek' },
      config: {},
    });
    expect(c.provider).toBe('deepseek');
    expect(c.model).toBe('deepseek-chat'); // default do deepseek vem do catálogo
  });

  it('provider desconhecido (fora do catálogo) ⇒ cai no default anthropic', () => {
    const c = resolveLocalProviderConfig({
      env: { ALUY_LOCAL_PROVIDER: 'nao-existe' },
      config: {},
    });
    expect(c.provider).toBe('anthropic');
  });

  // ADR-0118 — catálogo INJETADO (override do usuário) governa provider/default model.
  it('catálogo injetado com provider do usuário ⇒ resolve provider + default model dele', () => {
    const catalog = buildLocalCatalog([
      {
        id: 'myvendor',
        wireFormat: 'openai-compat',
        baseUrl: 'https://my.vendor/v1',
        auth: 'apikey',
        defaultModel: 'my-default',
      },
    ]);
    const c = resolveLocalProviderConfig({
      env: { ALUY_LOCAL_PROVIDER: 'myvendor' },
      config: {},
      catalog,
    });
    expect(c.provider).toBe('myvendor');
    expect(c.model).toBe('my-default');
  });
});
