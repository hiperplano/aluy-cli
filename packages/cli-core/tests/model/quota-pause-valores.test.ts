// Auditoria — valores literais da pausa por cota que os testes comparavam com a PRÓPRIA constante
// (tautologia) e o flag `manual` do orçamento.

import { describe, expect, it } from 'vitest';
import { BrokerError } from '../../src/model/errors.js';
import {
  BALANCE_LADDER_MS,
  BALANCE_MAX_WAIT_MS,
  DEFAULT_QUOTA_MAX_WAIT_MS,
  MAX_QUOTA_MAX_WAIT_MS,
  PROBE_LADDER_MS,
  classifyQuota,
  probeDelayMs,
} from '../../src/model/quota-pause.js';

const NOW = 1_800_000_000_000;
const err = (status: number, code: string, extra: Record<string, unknown> = {}): BrokerError =>
  new BrokerError({ status, code, ...extra });

describe('valores fixos da pausa por cota', () => {
  it('espera total default de 6h, teto configurável de 7 dias, saldo esgotado espera no máximo 30min', () => {
    expect(DEFAULT_QUOTA_MAX_WAIT_MS).toBe(6 * 3_600_000);
    expect(MAX_QUOTA_MAX_WAIT_MS).toBe(7 * 24 * 3_600_000);
    expect(BALANCE_MAX_WAIT_MS).toBe(30 * 60_000);
  });

  it('escada de sondagem: 1m,2m,5m,10m,15m,30m; saldo esgotado: 5m,10m,20m', () => {
    expect(PROBE_LADDER_MS).toEqual([60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000]);
    expect(BALANCE_LADDER_MS).toEqual([300_000, 600_000, 1_200_000]);
    expect(probeDelayMs(99)).toBe(1_800_000);
    expect(probeDelayMs(99, true)).toBe(1_200_000);
    expect(probeDelayMs(0, true)).toBe(300_000);
    expect(probeDelayMs(-3)).toBe(60_000);
  });
});

describe('flag `manual` (só recarga/ação do dono resolve)', () => {
  it('crédito/saldo é sempre manual', () => {
    expect(classifyQuota(err(402, 'INSUFFICIENT_CREDIT'), NOW)?.manual).toBe(true);
  });

  it('orçamento SEM horário de reset é manual; COM horário (>1min) não é', () => {
    expect(classifyQuota(err(429, 'BUDGET_EXHAUSTED'), NOW)?.manual).toBe(true);
    const comReset = classifyQuota(
      err(429, 'BUDGET_EXHAUSTED', { reset_at_ms: NOW + 3_600_000 }),
      NOW,
    );
    expect(comReset?.manual).toBe(false);
    expect(comReset?.resetAtMs).toBe(NOW + 3_600_000);
  });

  it('janela e semanal não são manuais (o tempo resolve)', () => {
    expect(classifyQuota(err(429, 'USAGE_WINDOW_EXHAUSTED'), NOW)?.manual).toBe(false);
    expect(classifyQuota(err(429, 'WEEKLY_CAP_EXHAUSTED'), NOW)?.manual).toBe(false);
  });
});
