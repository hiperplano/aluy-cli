// EST-1019 · ADR-0062 §Addendum 1 (APR-0086) · BUG-0023 — parser das flags de boot do
// TETO do CICLO headless: `--cycles N` (nº de iterações) e `--cycle-for <dur>` (duração
// total). Espelha o estilo do cli-effort.test.ts. Cobre a forma SEPARADA (`--flag valor`)
// + a forma inline (`--flag=valor`), o guard F10 (flag seguinte não vira valor) e a
// não-colisão com o objetivo posicional / com `--max-iterations` (teto do LOOP, distinto).

import { describe, it, expect } from 'vitest';
import { HELP_TEXT, parseArgs } from '../src/cli.js';

describe('--cycles flag parsing (teto de ITERAÇÕES do ciclo)', () => {
  it('--cycles 2 ⇒ cycles="2"', () => {
    const a = parseArgs(['-p', 'oi', '--cycle', '--cycles', '2']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.cycles).toBe('2');
      expect(a.cycle).toBe(true);
    }
  });

  it('--cycles=3 (forma inline) ⇒ cycles="3"', () => {
    const a = parseArgs(['-p', 'oi', '--cycle', '--cycles=3']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.cycles).toBe('3');
  });

  it('sem --cycles ⇒ cycles undefined', () => {
    const a = parseArgs(['-p', 'oi', '--cycle']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.cycles).toBeUndefined();
  });

  it('--cycles N NÃO engole o objetivo posicional', () => {
    const a = parseArgs(['--cycle', '--cycles', '2', 'rode os testes']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.cycles).toBe('2');
      expect(a.goal).toBe('rode os testes');
    }
  });

  // F10 (dogfooding) — `--cycles` seguido de OUTRA flag não pode engoli-la como valor.
  it('--cycles --tier <x> ⇒ cycles undefined (não engole a flag seguinte)', () => {
    const a = parseArgs(['-p', 'oi', '--cycle', '--cycles', '--tier', 'aluy-flux']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.cycles).toBeUndefined();
      expect(a.tier).toBe('aluy-flux');
    }
  });

  it('--cycles é DISTINTO de --max-iterations (tetos diferentes coexistem)', () => {
    const a = parseArgs(['-p', 'oi', '--cycle', '--cycles', '2', '--max-iterations', '50']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.cycles).toBe('2');
      expect(a.maxIterations).toBe('50');
    }
  });
});

describe('--cycle-for flag parsing (teto de DURAÇÃO total do ciclo)', () => {
  it('--cycle-for 30s ⇒ cycleFor="30s"', () => {
    const a = parseArgs(['-p', 'oi', '--cycle', '--cycle-for', '30s']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.cycleFor).toBe('30s');
  });

  it('--cycle-for=2h (forma inline) ⇒ cycleFor="2h"', () => {
    const a = parseArgs(['-p', 'oi', '--cycle', '--cycle-for=2h']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.cycleFor).toBe('2h');
  });

  it('--cycle-for <dur> NÃO engole o objetivo posicional', () => {
    const a = parseArgs(['--cycle', '--cycle-for', '30m', 'refine os PRs']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.cycleFor).toBe('30m');
      expect(a.goal).toBe('refine os PRs');
    }
  });

  it('--cycle-for --tier <x> ⇒ cycleFor undefined (guard F10)', () => {
    const a = parseArgs(['-p', 'oi', '--cycle', '--cycle-for', '--tier', 'aluy-flux']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.cycleFor).toBeUndefined();
      expect(a.tier).toBe('aluy-flux');
    }
  });

  it('--cycles e --cycle-for coexistem', () => {
    const a = parseArgs(['-p', 'oi', '--cycle', '--cycles', '5', '--cycle-for', '10m']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.cycles).toBe('5');
      expect(a.cycleFor).toBe('10m');
    }
  });
});

describe('HELP_TEXT documenta as flags de teto do ciclo (descobríveis)', () => {
  it('lista --cycles', () => {
    expect(HELP_TEXT).toContain('--cycles N');
  });
  it('lista --cycle-for', () => {
    expect(HELP_TEXT).toContain('--cycle-for <dur>');
  });
  // CA-3 (guard anti-F10) — o help NÃO sugere `--max-iter` embutido no goal como teto de
  // ciclo. (A menção a `--max-iterations` existe como teto do LOOP — distinta e correta.)
  it('o help do --cycle aponta p/ as flags de boot, não p/ teto embutido no goal', () => {
    expect(HELP_TEXT).toContain('--cycles e/ou --cycle-for');
  });
});
