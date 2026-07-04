// EST-0944 — SELF-CHECK de atenção: a PARTE PURA (config/gating/redatores).
//
// PROVAS (sem modelo, sem I/O — tudo determinístico):
//  - GATING: flag > env > tier fraco; OFF por default (tier forte/ausente, sem flag);
//    ON com a flag; a flag VENCE o tier (força ON e força OFF); env liga/desliga;
//    tier fraco (`custom`) liga sozinho; o default `flux` NÃO é fraco (OFF global);
//  - números (K da re-âncora / cap de verificações): default + override por env,
//    clampados; entrada inválida ⇒ default;
//  - redatores: a re-âncora cita o objetivo e marca o LEMBRETE; o probe pede EVIDÊNCIA
//    e numera a passada; a nota de cap avisa o limite.

import { describe, expect, it } from 'vitest';
import {
  resolveSelfCheck,
  isWeakTier,
  buildReanchor,
  buildSelfCheckProbe,
  buildVerificationCapNote,
  SELF_CHECK_OFF,
  REANCHOR_MARKER,
  SELF_CHECK_MARKER,
  DEFAULT_REANCHOR_EVERY_K,
  DEFAULT_MAX_VERIFICATIONS,
} from '../../src/agent/self-check.js';

describe('EST-0944 · self-check — gating (flag > env > tier fraco), OFF por default', () => {
  it('SEM flag, SEM env, tier FORTE/DEFAULT ⇒ OFF (não onera quem não quer)', () => {
    expect(resolveSelfCheck({ tier: 'aluy-granito' })).toEqual(SELF_CHECK_OFF);
    expect(resolveSelfCheck({}).enabled).toBe(false);
    expect(resolveSelfCheck({ tier: undefined }).enabled).toBe(false);
    // o tier DEFAULT (flux) NÃO é fraco: senão o self-check viraria o default GLOBAL.
    expect(resolveSelfCheck({ tier: 'aluy-flux' }).enabled).toBe(false);
    expect(isWeakTier('aluy-flux')).toBe(false);
  });

  it('tier FRACO (custom) liga SOZINHO (default ON onde compensa)', () => {
    expect(resolveSelfCheck({ tier: 'custom' }).enabled).toBe(true);
    expect(isWeakTier('custom')).toBe(true);
    expect(isWeakTier('CUSTOM')).toBe(true); // case-insensitive
    expect(isWeakTier('meu-custom-model')).toBe(true); // substring
    expect(isWeakTier('aluy-granito')).toBe(false);
    expect(isWeakTier(undefined)).toBe(false);
  });

  it('a FLAG vence o tier: --self-check força ON em tier forte', () => {
    expect(resolveSelfCheck({ flag: '1', tier: 'aluy-granito' }).enabled).toBe(true);
    expect(resolveSelfCheck({ flag: true, tier: 'aluy-granito' }).enabled).toBe(true);
  });

  it('a FLAG vence o tier: --no-self-check força OFF em tier FRACO', () => {
    expect(resolveSelfCheck({ flag: '0', tier: 'aluy-flux' }).enabled).toBe(false);
    expect(resolveSelfCheck({ flag: false, tier: 'custom' }).enabled).toBe(false);
  });

  it('ENV liga/desliga quando não há flag; a flag vence a env', () => {
    expect(resolveSelfCheck({ env: '1', tier: 'aluy-granito' }).enabled).toBe(true);
    expect(resolveSelfCheck({ env: 'true' }).enabled).toBe(true);
    expect(resolveSelfCheck({ env: '0', tier: 'aluy-flux' }).enabled).toBe(false);
    // flag (OFF) vence env (ON):
    expect(resolveSelfCheck({ flag: '0', env: '1' }).enabled).toBe(false);
    // flag (ON) vence env (OFF):
    expect(resolveSelfCheck({ flag: '1', env: '0' }).enabled).toBe(true);
  });

  it('valor de flag/env NÃO reconhecido ⇒ ignorado (cai no próximo da precedência)', () => {
    // 'maybe' não é bool ⇒ cai no tier (forte ⇒ OFF):
    expect(resolveSelfCheck({ flag: 'maybe', tier: 'aluy-granito' }).enabled).toBe(false);
    // env lixo + tier fraco (custom) ⇒ tier decide (ON):
    expect(resolveSelfCheck({ env: 'xyz', tier: 'custom' }).enabled).toBe(true);
    // env lixo + tier DEFAULT (flux, não-fraco) ⇒ OFF:
    expect(resolveSelfCheck({ env: 'xyz', tier: 'aluy-flux' }).enabled).toBe(false);
  });
});

describe('EST-0944 · self-check — números (K / cap) com default e override clampado', () => {
  it('default: K=8, cap=2 quando ligado sem overrides', () => {
    const c = resolveSelfCheck({ flag: '1' });
    expect(c.reanchorEveryK).toBe(DEFAULT_REANCHOR_EVERY_K);
    expect(c.maxVerifications).toBe(DEFAULT_MAX_VERIFICATIONS);
  });

  it('override por env (válido) é respeitado e clampado', () => {
    const c = resolveSelfCheck({ flag: '1', everyKEnv: '3', maxVerificationsEnv: '4' });
    expect(c.reanchorEveryK).toBe(3);
    expect(c.maxVerifications).toBe(4);
    // clamp do cap (teto 10):
    expect(resolveSelfCheck({ flag: '1', maxVerificationsEnv: '999' }).maxVerifications).toBe(10);
  });

  it('override inválido/zero/negativo ⇒ cai no default', () => {
    expect(resolveSelfCheck({ flag: '1', everyKEnv: '0' }).reanchorEveryK).toBe(
      DEFAULT_REANCHOR_EVERY_K,
    );
    expect(resolveSelfCheck({ flag: '1', everyKEnv: 'abc' }).reanchorEveryK).toBe(
      DEFAULT_REANCHOR_EVERY_K,
    );
    expect(resolveSelfCheck({ flag: '1', maxVerificationsEnv: '-1' }).maxVerifications).toBe(
      DEFAULT_MAX_VERIFICATIONS,
    );
  });

  it('DESLIGADO: os números não importam (config é SELF_CHECK_OFF)', () => {
    expect(resolveSelfCheck({ env: '0', everyKEnv: '3' })).toEqual(SELF_CHECK_OFF);
  });

  // ADR-0150 (Tier 2) — config.advanced.selfCheck (nível ENTRE env e default).
  it('ADR-0150 — config (everyKConfig/maxVerificationsConfig) vence o default', () => {
    const c = resolveSelfCheck({ flag: '1', everyKConfig: 5, maxVerificationsConfig: 6 });
    expect(c.reanchorEveryK).toBe(5);
    expect(c.maxVerifications).toBe(6);
  });

  it('ADR-0150 — env AINDA vence o config (config é o nível mais baixo antes do default)', () => {
    const c = resolveSelfCheck({
      flag: '1',
      everyKEnv: '3',
      everyKConfig: 5,
      maxVerificationsEnv: '4',
      maxVerificationsConfig: 6,
    });
    expect(c.reanchorEveryK).toBe(3);
    expect(c.maxVerifications).toBe(4);
  });

  it('ADR-0150 — config CLAMPADO aos MESMOS tetos do env (nenhum teto novo)', () => {
    expect(resolveSelfCheck({ flag: '1', maxVerificationsConfig: 999 }).maxVerifications).toBe(10);
    expect(resolveSelfCheck({ flag: '1', everyKConfig: 0 }).reanchorEveryK).toBe(
      DEFAULT_REANCHOR_EVERY_K,
    );
  });
});

describe('EST-0944 · self-check — redatores (re-âncora / probe / nota de cap)', () => {
  it('re-âncora cita o objetivo, marca o LEMBRETE e resume as ações', () => {
    const txt = buildReanchor('criar um site em ./app', ['usou a ferramenta edit_file']);
    expect(txt).toContain(REANCHOR_MARKER);
    expect(txt).toContain('criar um site em ./app');
    expect(txt).toContain('edit_file');
    expect(txt.toLowerCase()).toContain('falta');
  });

  it('re-âncora sem ações ainda orienta (não quebra)', () => {
    const txt = buildReanchor('objetivo X', []);
    expect(txt).toContain('objetivo X');
    expect(txt).toContain('(ainda nada relevante)');
  });

  it('probe numera a passada e EXIGE evidência (não memória)', () => {
    const txt = buildSelfCheckProbe('objetivo Y', 1, 2);
    expect(txt).toContain(SELF_CHECK_MARKER);
    expect(txt).toContain('1/2');
    expect(txt).toContain('objetivo Y');
    expect(txt.toUpperCase()).toContain('EVIDÊNCIA');
    expect(txt).toMatch(/NÃO pela sua memória/i);
  });

  it('nota de cap avisa o limite atingido', () => {
    const txt = buildVerificationCapNote(2);
    expect(txt).toContain(SELF_CHECK_MARKER);
    expect(txt).toContain('2');
    expect(txt.toLowerCase()).toContain('anti-loop');
  });
});
