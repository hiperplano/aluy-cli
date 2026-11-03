// PAUSA POR COTA — classificação de erros/headers e resolução de config.
import { describe, expect, it } from 'vitest';
import {
  BrokerError,
  BrokerTransportError,
  ModelCallAbortedError,
} from '../../src/model/errors.js';
import {
  classifyQuota,
  exceedsShortRetry,
  parseDurationMs,
  parseMaxWait,
  parseResetValue,
  probeDelayMs,
  resetAtFromHeaders,
  resetAtFromMessage,
  resolveQuotaPause,
  DEFAULT_QUOTA_MAX_WAIT_MS,
  MAX_QUOTA_HORIZON_MS,
} from '../../src/model/quota-pause.js';
import { decideRetry, isTransient } from '../../src/model/retry.js';

const NOW = 1_800_000_000_000;
const err = (status: number, code: string, extra: Record<string, unknown> = {}): BrokerError =>
  new BrokerError({ status, code, ...extra });
const headers = (h: Record<string, string>): { get(n: string): string | null } => ({
  get: (n) => h[n.toLowerCase()] ?? null,
});

describe('parse de tempo', () => {
  it('duração estilo OpenAI', () => {
    expect(parseDurationMs('6m0s')).toBe(360_000);
    expect(parseDurationMs('1h2m3s')).toBe(3_723_000);
    expect(parseDurationMs('20ms')).toBe(20);
    expect(parseDurationMs('1.5s')).toBe(1500);
    expect(parseDurationMs('lixo')).toBeUndefined();
  });
  it('valor de reset: relativo, RFC3339, epoch s/ms', () => {
    expect(parseResetValue('6m0s', NOW)).toBe(NOW + 360_000);
    expect(parseResetValue('2026-11-03T18:00:00Z', NOW)).toBe(Date.parse('2026-11-03T18:00:00Z'));
    expect(parseResetValue('1800003600', NOW)).toBe(1_800_003_600_000);
    expect(parseResetValue('1800003600000', NOW)).toBe(1_800_003_600_000);
    expect(parseResetValue('30', NOW)).toBe(NOW + 30_000);
    expect(parseResetValue('', NOW)).toBeUndefined();
  });
  it('headers: Retry-After vence; senão o maior reset', () => {
    expect(
      resetAtFromHeaders(headers({ 'retry-after': '120', 'x-ratelimit-reset-tokens': '1h' }), NOW),
    ).toBe(NOW + 120_000);
    expect(
      resetAtFromHeaders(
        headers({ 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-reset-tokens': '6m0s' }),
        NOW,
      ),
    ).toBe(NOW + 360_000);
    expect(
      resetAtFromHeaders(
        headers({ 'anthropic-ratelimit-tokens-reset': '2026-11-03T18:00:00Z' }),
        NOW,
      ),
    ).toBe(Date.parse('2026-11-03T18:00:00Z'));
    expect(resetAtFromHeaders(headers({}), NOW)).toBeUndefined();
  });
  it('dica no texto', () => {
    expect(resetAtFromMessage('Rate limit. Please try again in 6m0s.', NOW)).toBe(NOW + 360_000);
    expect(resetAtFromMessage('retry after 20 seconds', NOW)).toBe(NOW + 20_000);
    expect(resetAtFromMessage('resets in 3 hours', NOW)).toBe(NOW + 3 * 3_600_000);
    expect(resetAtFromMessage('nada aqui', NOW)).toBeUndefined();
  });
});

describe('classifyQuota', () => {
  it('códigos do broker', () => {
    expect(classifyQuota(err(429, 'USAGE_WINDOW_EXHAUSTED'), NOW)?.scope).toBe('janela');
    expect(classifyQuota(err(429, 'WEEKLY_CAP_EXHAUSTED'), NOW)?.scope).toBe('semanal');
    expect(classifyQuota(err(429, 'BUDGET_EXHAUSTED'), NOW)?.scope).toBe('orcamento');
    expect(classifyQuota(err(402, 'INSUFFICIENT_CREDIT'), NOW)?.scope).toBe('credito');
    expect(classifyQuota(err(402, 'HTTP_402'), NOW)?.scope).toBe('credito');
  });
  it('reset: resetAtMs > retry_after > texto; clamp no horizonte', () => {
    expect(
      classifyQuota(err(429, 'RATE_LIMITED', { reset_at_ms: NOW + 5000 }), NOW)?.resetAtMs,
    ).toBe(NOW + 5000);
    expect(classifyQuota(err(429, 'RATE_LIMITED', { retry_after: 90 }), NOW)?.resetAtMs).toBe(
      NOW + 90_000,
    );
    expect(
      classifyQuota(err(429, 'RATE_LIMITED', { detail: 'try again in 10m' }), NOW)?.resetAtMs,
    ).toBe(NOW + 600_000);
    expect(
      classifyQuota(err(429, 'RATE_LIMITED', { retry_after: 99_999_999 }), NOW)?.resetAtMs,
    ).toBe(NOW + MAX_QUOTA_HORIZON_MS);
  });
  it('insufficient_quota (OpenAI 429) e saldo zerado Anthropic (400) viram crédito', () => {
    expect(
      classifyQuota(err(429, 'RATE_LIMITED', { detail: 'You exceeded your current quota' }), NOW)
        ?.scope,
    ).toBe('credito');
    expect(
      classifyQuota(
        err(400, 'VALIDATION_FAILED', { detail: 'Your credit balance is too low' }),
        NOW,
      )?.scope,
    ).toBe('credito');
  });
  it('429 simples vira taxa', () => {
    expect(classifyQuota(err(429, 'RATE_LIMITED'), NOW)?.scope).toBe('taxa');
  });
  it('definitivos NUNCA são cota', () => {
    expect(classifyQuota(err(401, 'UNAUTHENTICATED', { detail: 'quota' }), NOW)).toBeNull();
    expect(classifyQuota(err(404, 'HTTP_404'), NOW)).toBeNull();
    expect(classifyQuota(err(400, 'VALIDATION_FAILED', { detail: 'bad request' }), NOW)).toBeNull();
    expect(classifyQuota(err(422, 'VALIDATION_FAILED'), NOW)).toBeNull();
    expect(classifyQuota(err(503, 'PROVIDER_ERROR', { detail: 'quota exceeded' }), NOW)).toBeNull();
    expect(classifyQuota(new BrokerTransportError('x'), NOW)).toBeNull();
    expect(classifyQuota(new ModelCallAbortedError(), NOW)).toBeNull();
    expect(classifyQuota(new Error('x'), NOW)).toBeNull();
  });
});

describe('integração com o retry curto', () => {
  it('janela/semanal/crédito não são retentados; 429 curto continua sendo', () => {
    expect(isTransient(err(429, 'USAGE_WINDOW_EXHAUSTED'))).toBe(false);
    expect(isTransient(err(402, 'INSUFFICIENT_CREDIT'))).toBe(false);
    expect(isTransient(err(429, 'RATE_LIMITED'))).toBe(true);
    expect(isTransient(err(429, 'RATE_LIMITED', { retry_after: 5 }))).toBe(true);
    expect(isTransient(err(429, 'RATE_LIMITED', { retry_after: 3600 }))).toBe(false);
    expect(isTransient(err(503, 'PROVIDER_ERROR'))).toBe(true);
    expect(exceedsShortRetry(err(429, 'RATE_LIMITED'), Date.now())).toBe(false);
    expect(
      decideRetry(err(429, 'WEEKLY_CAP_EXHAUSTED'), 1, { attempts: 5, waitMs: 100 }).retry,
    ).toBe(false);
  });
});

describe('sondagem e config', () => {
  it('escada satura', () => {
    expect(probeDelayMs(0)).toBe(60_000);
    expect(probeDelayMs(99)).toBe(1_800_000);
  });
  it('parseMaxWait', () => {
    expect(parseMaxWait('90')).toBe(90 * 60_000);
    expect(parseMaxWait('6h')).toBe(6 * 3_600_000);
    expect(parseMaxWait('99d')).toBe(7 * 86_400_000);
    expect(parseMaxWait('0')).toBeUndefined();
    expect(parseMaxWait('xx')).toBeUndefined();
  });
  it('resolveQuotaPause: default ligado, env desliga, env > config', () => {
    expect(resolveQuotaPause({})).toEqual({ enabled: true, maxWaitMs: DEFAULT_QUOTA_MAX_WAIT_MS });
    expect(resolveQuotaPause({ pauseEnv: 'off' }).enabled).toBe(false);
    expect(resolveQuotaPause({ maxWaitEnv: '30m', maxWaitConfig: '2h' }).maxWaitMs).toBe(1_800_000);
    expect(resolveQuotaPause({ maxWaitConfig: '2h' }).maxWaitMs).toBe(7_200_000);
  });
});

describe('Z.ai GLM Coding Plan (zai-coding)', () => {
  const MSG = 'Usage limit reached for 5 hour. Your limit will reset at 2026-11-03 05:00:00';
  it('data/hora sem fuso é lida como UTC+8 (Pequim); com fuso explícito vale o explícito', () => {
    expect(resetAtFromMessage(MSG, NOW)).toBe(Date.parse('2026-11-02T21:00:00Z'));
    expect(resetAtFromMessage('limit will reset at 2026-11-03 05:00:00 UTC', NOW)).toBe(
      Date.parse('2026-11-03T05:00:00+08:00'),
    ); // "UTC" solto não é fuso reconhecido
    expect(resetAtFromMessage('reset at 2026-11-03T05:00:00Z', NOW)).toBe(
      Date.parse('2026-11-03T05:00:00Z'),
    );
    expect(resetAtFromMessage('reset at 2026-11-03 05:00:00+02:00', NOW)).toBe(
      Date.parse('2026-11-03T05:00:00+02:00'),
    );
  });
  it('429 + error.code 1308/1310 + mensagem de limite ⇒ cota (janela), com o reset do texto', () => {
    const now = Date.parse('2026-11-02T18:00:00Z');
    const e = err(429, 'RATE_LIMITED', { detail: MSG, type: 'provider_code:1308' });
    const v = classifyQuota(e, now);
    expect(v?.scope).toBe('janela');
    expect(v?.resetAtMs).toBe(Date.parse('2026-11-02T21:00:00Z'));
    expect(
      classifyQuota(err(429, 'RATE_LIMITED', { type: 'provider_code:1310', detail: 'limit' }), now)
        ?.scope,
    ).toBe('credito');
    expect(isTransient(e)).toBe(false); // não é retry curto
  });
  it('429 simples e códigos de rate (1302/1303) seguem como taxa; 1301 (filtro de conteúdo) não é cota', () => {
    expect(
      classifyQuota(err(429, 'RATE_LIMITED', { type: 'provider_code:1302' }), NOW)?.scope,
    ).toBe('taxa');
    expect(
      classifyQuota(
        err(400, 'VALIDATION_FAILED', { type: 'provider_code:1301', detail: 'unsafe' }),
        NOW,
      ),
    ).toBeNull();
  });
  it('horário já vencido (fuso divergente) vira desconhecido — nunca sondagem imediata em laço', () => {
    const v = classifyQuota(
      err(429, 'RATE_LIMITED', { detail: MSG, type: 'provider_code:1308' }),
      Date.parse('2026-11-03T00:00:00Z'),
    );
    expect(v?.resetAtMs).toBeUndefined();
  });
});
