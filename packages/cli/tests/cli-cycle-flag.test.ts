import { describe, expect, it } from 'vitest';
import { HELP_TEXT, parseArgs } from '../src/cli.js';

describe('parseArgs — --cycle', () => {
  it('sem --cycle ⇒ cycle é undefined (comportamento headless normal)', () => {
    const a = parseArgs([]);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.cycle).toBeUndefined();
    }
  });

  it('--cycle com -p ⇒ cycle:true', () => {
    const a = parseArgs(['-p', 'x', '--cycle']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.print).toBe(true);
      expect(a.cycle).toBe(true);
    }
  });

  it('--cycle sem -p ⇒ cycle:true (mas sem efeito — só vale sob print)', () => {
    const a = parseArgs(['--cycle']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.print).toBe(false);
      expect(a.cycle).toBe(true);
    }
  });

  it('--cycle não engole o objetivo posicional', () => {
    const a = parseArgs(['--cycle', 'faça algo']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.cycle).toBe(true);
      expect(a.goal).toBe('faça algo');
    }
  });

  it('--cycle + -p + objetivo posicional convivem', () => {
    const a = parseArgs(['-p', 'prompt', '--cycle', '--yolo']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.print).toBe(true);
      expect(a.printArg).toBe('prompt');
      expect(a.cycle).toBe(true);
      expect(a.mode).toBe('unsafe');
    }
  });

  it('--cycle + --quiet + -p convivem', () => {
    const a = parseArgs(['-p', 'teste', '--cycle', '--quiet']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.print).toBe(true);
      expect(a.cycle).toBe(true);
      expect(a.quiet).toBe(true);
    }
  });

  it('HELP_TEXT documenta o --cycle', () => {
    expect(HELP_TEXT).toContain('--cycle');
    expect(HELP_TEXT).toContain('CICLOS autônomos');
  });
});
