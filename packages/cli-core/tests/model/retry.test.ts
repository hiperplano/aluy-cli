// F-RETRY — política PURA de retentativa.
//
// O que importa provar aqui não é só "retenta", é **o que NÃO retenta**: o pedido do dono
// foi "quando o provider não responde OU NEGA a resposta, deveria retentar". As duas
// coisas são diferentes — negar (401/404/400) é determinístico, e no backend LOCAL/BYO
// cada tentativa que chega ao provider CUSTA DINHEIRO. Retentar recusa é queimar saldo.

import { describe, expect, it } from 'vitest';
import {
  decideRetry,
  isTransient,
  resolveRetry,
  RETRY_OFF,
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_WAIT_MS,
  MAX_RETRY_ATTEMPTS,
  MAX_RETRY_WAIT_MS,
} from '../../src/model/retry.js';
import {
  BrokerError,
  BrokerTransportError,
  ModelCallAbortedError,
} from '../../src/model/errors.js';

const CFG = { attempts: 3, waitMs: 5_000 };

function httpErr(status: number, extra: Record<string, unknown> = {}): BrokerError {
  return new BrokerError({ status, code: 'X', title: 't', ...extra } as never);
}

describe('F-RETRY · isTransient — o que vale re-tentar', () => {
  it('RETENTA falha de transporte (rede/DNS/timeout/stream cortado)', () => {
    expect(isTransient(new BrokerTransportError('conexão recusada'))).toBe(true);
  });

  it('RETENTA 429 e 5xx (o provider pediu p/ voltar depois, ou caiu)', () => {
    expect(isTransient(httpErr(429))).toBe(true);
    expect(isTransient(httpErr(500))).toBe(true);
    expect(isTransient(httpErr(502))).toBe(true);
    expect(isTransient(httpErr(503))).toBe(true);
  });

  it('NÃO retenta o provider NEGANDO — é determinístico e custa dinheiro repetir', () => {
    expect(isTransient(httpErr(401))).toBe(false); // chave inválida
    expect(isTransient(httpErr(403))).toBe(false); // sem permissão
    expect(isTransient(httpErr(404))).toBe(false); // modelo/baseURL errado
    expect(isTransient(httpErr(400))).toBe(false); // input inválido
    expect(isTransient(httpErr(422))).toBe(false); // não suportado
  });

  it('NUNCA retenta CANCELAMENTO — é ordem do dono, não falha', () => {
    expect(isTransient(new ModelCallAbortedError())).toBe(false);
    const ab = new Error('abortado');
    ab.name = 'AbortError';
    expect(isTransient(ab)).toBe(false);
  });

  it('erro DESCONHECIDO ⇒ não retenta (fail-safe conservador)', () => {
    expect(isTransient(new Error('sei lá'))).toBe(false);
    expect(isTransient('string solta')).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});

describe('F-RETRY · decideRetry — veredito e espera', () => {
  it('transitório e com tentativas sobrando ⇒ retenta com a espera base', () => {
    const v = decideRetry(new BrokerTransportError('x'), 1, CFG);
    expect(v.retry).toBe(true);
    expect(v.waitMs).toBe(5_000);
    expect(v.reason).toContain('rede');
  });

  it('honra o `Retry-After` do provider (ignorá-lo é receita p/ tomar ban)', () => {
    const v = decideRetry(httpErr(429, { retry_after: 12 }), 1, CFG);
    expect(v.retry).toBe(true);
    expect(v.waitMs).toBe(12_000); // vence a espera base de 5s
    expect(v.reason).toContain('Retry-After');
  });

  it('CLAMPA um `Retry-After` hostil (não pendura a sessão por horas)', () => {
    const v = decideRetry(httpErr(429, { retry_after: 99_999 }), 1, CFG);
    expect(v.waitMs).toBe(MAX_RETRY_WAIT_MS);
  });

  it('para no TETO de tentativas (anti-runaway)', () => {
    expect(decideRetry(new BrokerTransportError('x'), 2, CFG).retry).toBe(true);
    const v = decideRetry(new BrokerTransportError('x'), 3, CFG);
    expect(v.retry).toBe(false);
    expect(v.reason).toContain('teto');
  });

  it('DESLIGADO (attempts:0) ⇒ nunca retenta, nem transitório', () => {
    const v = decideRetry(new BrokerTransportError('x'), 1, RETRY_OFF);
    expect(v.retry).toBe(false);
    expect(v.reason).toContain('desligado');
  });

  it('cancelamento tem motivo PRÓPRIO (não se confunde com erro definitivo)', () => {
    const v = decideRetry(new ModelCallAbortedError(), 1, CFG);
    expect(v.retry).toBe(false);
    expect(v.reason).toContain('cancelado');
  });
});

describe('F-RETRY · resolveRetry — precedência env > config > default (ADR-0150)', () => {
  // DESLIGADO por default de propósito: o invariante CA-5 do `streaming-caller`
  // ("erro estruturado SOBE, sem virar uma 2ª rota/retry") é documentado E testado.
  // Ligar por default muda o comportamento de toda sessão ⇒ é decisão de ADR, não um
  // default trocado de lado. A capacidade fica a 1 env de distância.
  it('sem nada ⇒ DESLIGADO (preserva o invariante CA-5 até um ADR decidir)', () => {
    expect(resolveRetry({})).toEqual(RETRY_OFF);
  });

  it('`on`/`true`/`1` liga no default recomendado (sem escolher número)', () => {
    expect(resolveRetry({ attemptsEnv: 'on' }).attempts).toBe(DEFAULT_RETRY_ATTEMPTS);
    expect(resolveRetry({ attemptsEnv: 'on' }).waitMs).toBe(DEFAULT_RETRY_WAIT_MS);
    expect(resolveRetry({ attemptsEnv: 'true' }).attempts).toBe(DEFAULT_RETRY_ATTEMPTS);
  });

  it('`off`/`0`/`false` no env DESLIGA', () => {
    expect(resolveRetry({ attemptsEnv: 'off' })).toEqual(RETRY_OFF);
    expect(resolveRetry({ attemptsEnv: '0' })).toEqual(RETRY_OFF);
    expect(resolveRetry({ attemptsEnv: 'false' })).toEqual(RETRY_OFF);
  });

  it('env vence config, config vence default', () => {
    expect(resolveRetry({ attemptsEnv: '7', attemptsConfig: 9 }).attempts).toBe(7);
    expect(resolveRetry({ attemptsConfig: 9 }).attempts).toBe(9);
    // `waitMs` só é observável com o retry LIGADO (desligado ⇒ RETRY_OFF canônico).
    expect(resolveRetry({ attemptsEnv: '3', waitMsEnv: '2000', waitMsConfig: 8000 }).waitMs).toBe(
      2_000,
    );
    expect(resolveRetry({ attemptsEnv: '3', waitMsConfig: 8000 }).waitMs).toBe(8_000);
  });

  it('CLAMPA nos tetos duros (anti-runaway) e ignora lixo', () => {
    expect(resolveRetry({ attemptsEnv: '9999' }).attempts).toBe(MAX_RETRY_ATTEMPTS);
    expect(resolveRetry({ attemptsEnv: '3', waitMsEnv: '99999999' }).waitMs).toBe(
      MAX_RETRY_WAIT_MS,
    );
    expect(resolveRetry({ attemptsEnv: 'abc' })).toEqual(RETRY_OFF); // lixo ⇒ default (off)
  });
});
