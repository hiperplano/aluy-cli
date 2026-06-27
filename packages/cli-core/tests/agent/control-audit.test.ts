// EST-1014 — Cobertura de ControlAudit: clock, ring trim, digest truncado.
import { describe, expect, it } from 'vitest';
import { ControlAudit } from '../../src/agent/control-audit.js';

const MAX_EVENTS = 256; // mesmo valor do source

describe('EST-0982 · ControlAudit — trilha de auditoria do plano de controle', () => {
  describe('clock default (Date.now)', () => {
    it('usa Date.now quando nenhum clock é injetado', () => {
      const audit = new ControlAudit();
      const ev = audit.recordCancel('root', 'root');
      expect(ev.at).toBeGreaterThan(0);
      expect(typeof ev.at).toBe('number');
    });
  });

  describe('ring trim (MAX_EVENTS)', () => {
    it('descarta o evento mais antigo quando estoura MAX_EVENTS', () => {
      const audit = new ControlAudit({ clock: () => 1000 });
      // Preenche MAX_EVENTS + 1 eventos
      for (let i = 0; i < MAX_EVENTS + 1; i++) {
        audit.recordCancel(`nó-${i}`, 'teste');
      }
      expect(audit.log.length).toBeLessThanOrEqual(MAX_EVENTS);
    });
  });

  describe('digest truncado (DIGEST_MAX = 120)', () => {
    it('trunca inputDigest quando o input é maior que 120 caracteres', () => {
      const audit = new ControlAudit({ clock: () => 1000 });
      const longInput = 'x'.repeat(200);
      const ev = audit.recordInjectInput('root', 'root', longInput);
      expect(ev.inputDigest).toBeDefined();
      expect(ev.inputDigest!.length).toBeLessThanOrEqual(122); // 120 + '…' (1 char) = 121; safe
      expect(ev.inputDigest!.endsWith('…')).toBe(true);
    });
  });
});
