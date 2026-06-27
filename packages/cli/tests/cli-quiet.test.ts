import { describe, expect, it } from 'vitest';
import { HELP_TEXT, parseArgs } from '../src/cli.js';

describe('parseArgs — --quiet', () => {
  it('sem --quiet ⇒ quiet é undefined (progresso visível por padrão)', () => {
    const a = parseArgs([]);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.quiet).toBeUndefined();
    }
  });

  it('--quiet com -p ⇒ quiet:true (cala o progresso do stderr)', () => {
    const a = parseArgs(['-p', 'x', '--quiet']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.print).toBe(true);
      expect(a.quiet).toBe(true);
    }
  });

  it('--quiet sem -p ⇒ quiet:true (mas sem efeito — só vale sob print)', () => {
    const a = parseArgs(['--quiet']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.print).toBe(false);
      expect(a.quiet).toBe(true);
    }
  });

  it('--quiet não engole o objetivo posicional', () => {
    const a = parseArgs(['--quiet', 'faça algo']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.quiet).toBe(true);
      expect(a.goal).toBe('faça algo');
    }
  });

  it('--quiet + -p + objetivo posicional convivem', () => {
    const a = parseArgs(['-p', 'prompt', '--quiet', '--output-format', 'json']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.print).toBe(true);
      expect(a.printArg).toBe('prompt');
      expect(a.quiet).toBe(true);
      expect(a.outputFormat).toBe('json');
    }
  });

  it('HELP_TEXT documenta o --quiet', () => {
    expect(HELP_TEXT).toContain('--quiet');
    expect(HELP_TEXT).toContain('Cala o progresso');
  });
});
