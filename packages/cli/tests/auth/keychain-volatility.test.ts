// F165 — detecção do cofre VOLÁTIL (keyring do KERNEL via keyutils). Sem Secret
// Service (VPS headless — a box do dono), o `@napi-rs/keyring` grava no keyring do
// kernel: memória, some no reboot, e o CLI gravava EM SILÊNCIO ("perde o login e
// tenho que rodar o onboard de novo"). Aqui provamos a sonda pura (via /proc/keys)
// e o formato do aviso.

import { describe, expect, it } from 'vitest';
import { keychainIsVolatile, volatileKeychainWarning } from '../../src/auth/keychain-volatility.js';

// Trecho REAL de /proc/keys da box do dono (F165): a entrada do keyutils aparece
// como `keyring:<conta>@<serviço>` (tipo `user`) — a evidência do backend volátil.
const PROC_KEYS_VOLATILE = [
  '03758953 I--Q---   137 perm 3f030000  1000  1000 keyring   _ses: 3',
  '1bcd11fd I--Q---     2 perm 3f010000  1000  1000 user      keyring:tokenrouter:apikey@aluy-cli-local: 51',
  '30770281 I------     2   2d 1f030000  1000 65534 keyring   _persistent.1000: 1',
].join('\n');

const PROC_KEYS_CLEAN = [
  '03758953 I--Q---   137 perm 3f030000  1000  1000 keyring   _ses: 3',
  '30770281 I------     2   2d 1f030000  1000 65534 keyring   _persistent.1000: 1',
].join('\n');

describe('keychainIsVolatile — sonda do keyring do kernel (F165)', () => {
  it('entrada do serviço em /proc/keys ⇒ VOLÁTIL (o write caiu no kernel)', () => {
    expect(
      keychainIsVolatile({
        service: 'aluy-cli-local',
        platform: 'linux',
        readProcKeys: () => PROC_KEYS_VOLATILE,
      }),
    ).toBe(true);
  });

  it('sem entrada do serviço (Secret Service ativo) ⇒ não-volátil', () => {
    expect(
      keychainIsVolatile({
        service: 'aluy-cli-local',
        platform: 'linux',
        readProcKeys: () => PROC_KEYS_CLEAN,
      }),
    ).toBe(false);
  });

  it('fora do Linux ⇒ sempre false (cofre do SO é persistente)', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(
        keychainIsVolatile({
          service: 'aluy-cli-local',
          platform,
          readProcKeys: () => PROC_KEYS_VOLATILE,
        }),
      ).toBe(false);
    }
  });

  it('/proc/keys ilegível ⇒ false (best-effort, sem alarme sem evidência)', () => {
    expect(
      keychainIsVolatile({
        service: 'aluy-cli-local',
        platform: 'linux',
        readProcKeys: () => {
          throw new Error('EACCES');
        },
      }),
    ).toBe(false);
  });

  it('serviço é casado EXATO com o @ (outro serviço não dispara)', () => {
    expect(
      keychainIsVolatile({
        service: 'aluy-cli',
        platform: 'linux',
        readProcKeys: () => PROC_KEYS_VOLATILE.replace('@aluy-cli-local', '@outro-servico'),
      }),
    ).toBe(false);
  });
});

describe('volatileKeychainWarning — aviso honesto pós-gravação (F165)', () => {
  it('explica a volatilidade e cita a ENV exata que o resolvedor lê (nunca a credencial)', () => {
    const lines = volatileKeychainWarning('ALUY_TOKENROUTER_API_KEY');
    const all = lines.join('\n');
    expect(all).toContain('NÃO sobrevive a um reboot');
    expect(all).toContain('gnome-keyring');
    expect(all).toContain('ALUY_TOKENROUTER_API_KEY');
    expect(all).not.toMatch(/sk-/); // nunca cita segredo.
  });
});
