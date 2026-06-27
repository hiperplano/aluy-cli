// EST-0962 — testes do parser `--effort` (flag de boot da CLI).
// Valida: parseArgs com --effort minimal/high, sem valor, >32 chars.

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('--effort flag parsing', () => {
  it('--effort minimal ⇒ effort="minimal"', () => {
    const result = parseArgs(['--effort', 'minimal']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.effort).toBe('minimal');
    }
  });

  it('--effort high ⇒ effort="high"', () => {
    const result = parseArgs(['--effort', 'high']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.effort).toBe('high');
    }
  });

  it('--effort com valor custom (qualquer string ≤32) ⇒ effort="my-custom-effort"', () => {
    const result = parseArgs(['--effort', 'my-custom-effort']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.effort).toBe('my-custom-effort');
    }
  });

  it('--effort="" (vazio) ⇒ usage-error', () => {
    const result = parseArgs(['--effort', '']);
    expect(result.kind).toBe('usage-error');
  });

  it('--effort sem valor (ausente no próximo token) ⇒ usage-error', () => {
    const result = parseArgs(['--effort']);
    expect(result.kind).toBe('usage-error');
  });

  it('--effort com >32 caracteres ⇒ usage-error', () => {
    const long = 'a'.repeat(33);
    const result = parseArgs(['--effort', long]);
    expect(result.kind).toBe('usage-error');
  });

  it('--effort com exatamente 32 caracteres ⇒ ok', () => {
    const ok = 'a'.repeat(32);
    const result = parseArgs(['--effort', ok]);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.effort).toBe(ok);
    }
  });

  it('sem --effort ⇒ effort undefined', () => {
    const result = parseArgs([]);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.effort).toBeUndefined();
    }
  });

  it('--effort=<value> (form inline) ⇒ effort ok', () => {
    const result = parseArgs(['--effort=low']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.effort).toBe('low');
    }
  });

  it('--effort NÃO exige --model (sem tier-gate)', () => {
    const result = parseArgs(['--effort', 'low']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.effort).toBe('low');
    }
  });

  // F10 (dogfooding) — `--effort` seguido de OUTRA flag não pode engoli-la como valor.
  // Antes: `--effort --tier x` virava effort="--tier" (lixo no broker) + --tier perdia
  // o valor. Agora: o token `--…` não é valor ⇒ effort ausente ⇒ usage-error.
  it('--effort --tier <x> ⇒ usage-error (não engole a flag seguinte como valor)', () => {
    const result = parseArgs(['-p', 'oi', '--effort', '--tier', 'aluy-flux']);
    expect(result.kind).toBe('usage-error');
  });

  it('--tier NÃO é engolido por --effort sem valor: --tier mantém o seu valor', () => {
    // Ordem inversa: --tier ANTES, com valor próprio; --effort por último sem valor
    // (cai no caminho de last-arg, também usage-error — mas --tier foi parseado certo).
    const result = parseArgs(['--tier', 'aluy-flux', '-p', 'oi', '--effort']);
    expect(result.kind).toBe('usage-error');
  });

  // EST-1015 (irmã do F10) — `--effort` seguido de uma SHORT flag (`-p`) também não pode
  // engoli-la: antes o guard só pegava `--`, então `--effort -p` virava effort="-p" (lixo) e
  // o `-p` headless se PERDIA. Agora o `-p` é preservado e o effort cai em valor-ausente.
  it('--effort -p <prompt> ⇒ NÃO engole o -p (headless preservado, effort sem valor)', () => {
    const result = parseArgs(['--effort', '-p', 'oi']);
    // effort sem valor ⇒ usage-error (não vira effort="-p").
    expect(result.kind).toBe('usage-error');
  });

  it('--tier -p <prompt> ⇒ -p (headless) preservado, NÃO engolido como valor de --tier', () => {
    const result = parseArgs(['--tier', '-p', 'explique algo']);
    // --tier sem valor cai no DEFAULT (não usage-error); o que importa: o -p NÃO foi engolido
    // como valor do --tier — o headless é detectado e o prompt vem do -p.
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.print).toBe(true);
      expect(result.printArg).toBe('explique algo');
      expect(result.tier).not.toBe('-p'); // antes do fix, tier="-p" (lixo).
    }
  });

  it('print/exec PRESERVAM prompt que começa com "-" (allowDashValue): --print "-v ..."', () => {
    // O prompt do headless PODE começar com `-`; o guard de print/exec só desqualifica `--`.
    const result = parseArgs(['--print', '-v é verbose']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.print).toBe(true);
      expect(result.printArg).toBe('-v é verbose');
    }
  });
});
