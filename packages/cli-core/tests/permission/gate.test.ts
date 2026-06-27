import { describe, expect, it } from 'vitest';
import { denyAllEngine, decide } from '../../src/permission/gate.js';

describe('denyAllEngine — deny-by-default (CLI-SEC-H1)', () => {
  describe('(A) denyAllEngine.decide() retorna deny para qualquer tool', () => {
    it('nega write_file com reason mencionando o nome', () => {
      const verdict = denyAllEngine.decide({ name: 'write_file', input: {} });
      expect(verdict.decision).toBe('deny');
      expect(verdict.reason).toContain('write_file');
    });

    it('nega run_command com reason mencionando o nome', () => {
      const verdict = denyAllEngine.decide({ name: 'run_command', input: {} });
      expect(verdict.decision).toBe('deny');
      expect(verdict.reason).toContain('run_command');
    });
  });

  describe('(B) decide(engine, call) — ponto único de interceptação', () => {
    it('delega ao denyAllEngine e retorna deny', () => {
      const verdict = decide(denyAllEngine, { name: 'read_file', input: {} });
      expect(verdict.decision).toBe('deny');
    });
  });
});
