// EST-1009 · ADR-0065 §D-SB-4 — FAIL-MODE do sandbox (3 ramos), PURO/sem-SO.
//
// Critério (e) do gate `seguranca`: bwrap/userns ausente ⇒
//   - dev/staging DEGRADA com aviso inequívoco não-suprimível + não-promovível;
//   - prod RECUSA por default;
//   - prod + `--unsafe-no-sandbox` RODA SEM PISO mas NÃO relaxa sempre-ask/write-deny.
//   - NUNCA finge confinamento, nunca silencioso.
// E o caminho feliz: piso disponível ⇒ confina + promovível, sem aviso.

import { describe, expect, it } from 'vitest';
import {
  floorAvailable,
  resolveFailMode,
  resolveSandboxEnv,
  resolveUnsafeNoSandbox,
  type SandboxCapability,
} from '../../src/index.js';

/** Capability com PISO disponível (linux + bwrap + userns + seccomp). */
const FLOOR: SandboxCapability = {
  platform: 'linux',
  bwrap: true,
  userns: true,
  seccomp: true,
  landlock: true,
};

/** Capability SEM piso (faltam bwrap+userns) — com motivo legível. */
const NO_FLOOR: SandboxCapability = {
  platform: 'linux',
  bwrap: false,
  userns: false,
  seccomp: true,
  landlock: false,
  unavailableReason: 'bwrap ausente; userns desativado',
};

describe('floorAvailable — o piso exige linux + bwrap + userns + seccomp', () => {
  it('linux com bwrap+userns+seccomp ⇒ disponível', () => {
    expect(floorAvailable(FLOOR)).toBe(true);
  });
  it('Landlock NÃO é necessário p/ o piso (é aditivo)', () => {
    expect(floorAvailable({ ...FLOOR, landlock: false })).toBe(true);
  });
  it.each([
    ['sem bwrap', { ...FLOOR, bwrap: false }],
    ['sem userns', { ...FLOOR, userns: false }],
    ['sem seccomp', { ...FLOOR, seccomp: false }],
    ['plataforma macOS (Fase 2)', { ...FLOOR, platform: 'darwin' }],
    ['plataforma Windows (FU)', { ...FLOOR, platform: 'win32' }],
  ])('%s ⇒ piso indisponível', (_label, cap) => {
    expect(floorAvailable(cap as SandboxCapability)).toBe(false);
  });
});

describe('resolveFailMode — caminho feliz (piso disponível)', () => {
  it.each(['dev', 'staging', 'prod'] as const)(
    'env=%s + piso ⇒ confine, confinado, promovível, SEM aviso',
    (env) => {
      const d = resolveFailMode(FLOOR, env, false);
      expect(d.action).toBe('confine');
      expect(d.confined).toBe(true);
      expect(d.allowed).toBe(true);
      expect(d.promotable).toBe(true);
      expect(d.warning).toBeUndefined();
    },
  );

  it('o flag --unsafe-no-sandbox é INERTE quando há piso (não desliga o piso)', () => {
    const d = resolveFailMode(FLOOR, 'prod', true);
    expect(d.action).toBe('confine');
    expect(d.confined).toBe(true);
  });
});

describe('resolveFailMode — RAMO dev/staging sem piso ⇒ DEGRADE (e)', () => {
  it.each(['dev', 'staging'] as const)('env=%s ⇒ degrade + aviso + não-promovível', (env) => {
    const d = resolveFailMode(NO_FLOOR, env, false);
    expect(d.action).toBe('degrade');
    expect(d.confined).toBe(false);
    expect(d.allowed).toBe(true); // roda, mas avisado
    expect(d.promotable).toBe(false); // máquina marcada NÃO-promovível
    expect(d.warning).toBeTruthy();
    expect(d.warning).toContain('SEM PISO DE SO'); // aviso inequívoco
    expect(d.warning).toContain('NÃO é promovível');
    expect(d.warning).toContain('bwrap ausente'); // motivo concreto embutido
  });

  it('o aviso de degrade NÃO depende do flag (não-suprimível por config)', () => {
    const semFlag = resolveFailMode(NO_FLOOR, 'dev', false);
    const comFlag = resolveFailMode(NO_FLOOR, 'dev', true);
    // dev ignora o flag (o flag é p/ prod); ambos degradam com aviso.
    expect(semFlag.action).toBe('degrade');
    expect(comFlag.action).toBe('degrade');
    expect(comFlag.warning).toBeTruthy();
  });
});

describe('resolveFailMode — RAMO prod sem piso (e)', () => {
  it('sem flag ⇒ REFUSE por default (não roda, não-promovível, com aviso/instrução)', () => {
    const d = resolveFailMode(NO_FLOOR, 'prod', false);
    expect(d.action).toBe('refuse');
    expect(d.allowed).toBe(false); // NÃO executa o efeito
    expect(d.confined).toBe(false);
    expect(d.promotable).toBe(false);
    expect(d.warning).toBeTruthy();
    expect(d.warning).toContain('RECUSADO');
    expect(d.warning).toContain('--unsafe-no-sandbox'); // mostra como forçar conscientemente
  });

  it('COM --unsafe-no-sandbox ⇒ UNSAFE (roda sem piso, avisa, não-promovível)', () => {
    const d = resolveFailMode(NO_FLOOR, 'prod', true);
    expect(d.action).toBe('unsafe');
    expect(d.allowed).toBe(true);
    expect(d.confined).toBe(false);
    expect(d.promotable).toBe(false);
    expect(d.warning).toBeTruthy();
    expect(d.warning).toContain('SEM PISO DE SO');
    // O aviso deixa explícito que sempre-ask + write-deny de ~/.aluy/ CONTINUAM
    // (o flag NÃO relaxa a catraca — só aceita a ausência do piso de SO).
    expect(d.warning).toContain('~/.aluy/');
  });

  it('NUNCA finge confinamento: nenhum ramo sem piso reporta confined=true', () => {
    for (const env of ['dev', 'staging', 'prod'] as const) {
      for (const flag of [false, true]) {
        const d = resolveFailMode(NO_FLOOR, env, flag);
        expect(d.confined).toBe(false);
      }
    }
  });
});

describe('resolveSandboxEnv — DADO via ALUY_ENV, default seguro=dev (avisa, não recusa)', () => {
  it.each([
    ['prod', 'prod'],
    ['production', 'prod'],
    ['PROD', 'prod'],
    ['staging', 'staging'],
    ['dev', 'dev'],
    ['', 'dev'],
    ['lixo', 'dev'],
    [undefined, 'dev'],
  ] as const)('ALUY_ENV=%s ⇒ %s', (raw, expected) => {
    const env = raw === undefined ? {} : { ALUY_ENV: raw };
    expect(resolveSandboxEnv(env as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe('resolveUnsafeNoSandbox — flag > env, default false', () => {
  it('flag true vence tudo', () => {
    expect(resolveUnsafeNoSandbox(true, {})).toBe(true);
  });
  it.each(['1', 'true', 'yes'])('ALUY_UNSAFE_NO_SANDBOX=%s ⇒ true', (v) => {
    expect(resolveUnsafeNoSandbox(false, { ALUY_UNSAFE_NO_SANDBOX: v })).toBe(true);
  });
  it.each(['0', 'false', '', 'lixo'])('ALUY_UNSAFE_NO_SANDBOX=%s ⇒ false', (v) => {
    expect(resolveUnsafeNoSandbox(false, { ALUY_UNSAFE_NO_SANDBOX: v })).toBe(false);
  });
  it('sem flag e sem env ⇒ false (conservador)', () => {
    expect(resolveUnsafeNoSandbox(false, {})).toBe(false);
  });
});
