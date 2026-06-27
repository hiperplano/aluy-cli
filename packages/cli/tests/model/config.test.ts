import { describe, expect, it } from 'vitest';
import { loadBrokerConfig } from '../../src/model/config.js';

describe('loadBrokerConfig', () => {
  it('usa ALUY_BROKER_URL quando presente, sem barra final', () => {
    const cfg = loadBrokerConfig({ ALUY_BROKER_URL: 'https://broker.staging.aluy.app/' });
    expect(cfg.brokerBaseUrl).toBe('https://broker.staging.aluy.app');
  });

  it('cai no default de dev quando a env não está setada', () => {
    const cfg = loadBrokerConfig({});
    expect(cfg.brokerBaseUrl).toMatch(/^https:\/\//);
  });

  it('não lê nenhum segredo do ambiente (só o endpoint)', () => {
    const cfg = loadBrokerConfig({
      ALUY_BROKER_URL: 'https://b.test',
      ALUY_TOKEN: 'pat_deadbeef_secret', // deve ser IGNORADO aqui
    });
    expect(Object.values(cfg)).not.toContain('pat_deadbeef_secret');
    expect(cfg).toEqual({ brokerBaseUrl: 'https://b.test' });
  });
});
