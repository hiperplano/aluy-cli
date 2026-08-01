import { describe, it, expect } from 'vitest';
import { parseDaemonManifest, isDaemonManifestError } from '@hiperplano/aluy-cli-core';

describe('parseDaemonManifest', () => {
  it('parseia command/port/health com cerca frontmatter', () => {
    const raw = `---\ncommand: python3 bridge.py\nport: 8765\nhealth: http://127.0.0.1:8765/health\n---\n`;
    const p = parseDaemonManifest(raw);
    expect(isDaemonManifestError(p)).toBe(false);
    if (!isDaemonManifestError(p)) {
      expect(p.command).toBe('python3 bridge.py');
      expect(p.port).toBe(8765);
      expect(p.health).toBe('http://127.0.0.1:8765/health');
    }
  });

  it('tolera chave-valor cru sem cerca ---', () => {
    const raw = `command: node bridge.js\n`;
    const p = parseDaemonManifest(raw);
    expect(isDaemonManifestError(p)).toBe(false);
    if (!isDaemonManifestError(p)) expect(p.command).toBe('node bridge.js');
  });

  it('command ausente ⇒ erro fail-closed', () => {
    const p = parseDaemonManifest('port: 8765\n');
    expect(isDaemonManifestError(p)).toBe(true);
  });

  it('command vazio ⇒ erro', () => {
    const p = parseDaemonManifest('command:\n');
    expect(isDaemonManifestError(p)).toBe(true);
  });

  it('port inválida ⇒ erro', () => {
    const p = parseDaemonManifest('command: x\nport: 99999\n');
    expect(isDaemonManifestError(p)).toBe(true);
  });

  it('port não-numérica ⇒ erro', () => {
    const p = parseDaemonManifest('command: x\nport: abc\n');
    expect(isDaemonManifestError(p)).toBe(true);
  });

  it('port nos limites EXATOS (1 e 65535) ⇒ ACEITA (faixa é inclusiva)', () => {
    // A validação é `n < 1 || n > 65535` — os outros testes só cobrem um valor
    // bem no meio (8765) ou bem fora (99999), nunca o limite exato; sem este
    // teste, um mutante que troca por `<=`/`>=` (limite EXCLUSIVO) passaria
    // despercebido.
    const pMin = parseDaemonManifest('command: x\nport: 1\n');
    expect(isDaemonManifestError(pMin)).toBe(false);
    if (!isDaemonManifestError(pMin)) expect(pMin.port).toBe(1);

    const pMax = parseDaemonManifest('command: x\nport: 65535\n');
    expect(isDaemonManifestError(pMax)).toBe(false);
    if (!isDaemonManifestError(pMax)) expect(pMax.port).toBe(65535);
  });

  it('sem port/health ⇒ campos ausentes (informativos, opcionais)', () => {
    const p = parseDaemonManifest('command: x\n');
    expect(isDaemonManifestError(p)).toBe(false);
    if (!isDaemonManifestError(p)) {
      expect(p.port).toBeUndefined();
      expect(p.health).toBeUndefined();
    }
  });
});
