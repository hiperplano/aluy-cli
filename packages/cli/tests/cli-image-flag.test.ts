// ADR-0159 — testes do parser `--image <path>` (repetível): flag de boot da CLI,
// açúcar sintático p/ o mesmo `@caminho` de menção (sem mecanismo paralelo).

import { describe, it, expect } from 'vitest';
import { HELP_TEXT, parseArgs } from '../src/cli.js';

describe('--image flag parsing (ADR-0159)', () => {
  it('sem --image ⇒ images undefined', () => {
    const result = parseArgs(['-p', 'oi']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.images).toBeUndefined();
    }
  });

  it('--image <path> (forma separada) ⇒ images=["screenshot.png"]', () => {
    const result = parseArgs(['-p', 'descreva', '--image', 'screenshot.png']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.images).toEqual(['screenshot.png']);
    }
  });

  it('--image=<path> (forma inline) ⇒ images=["a.png"]', () => {
    const result = parseArgs(['-p', 'descreva', '--image=a.png']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.images).toEqual(['a.png']);
    }
  });

  it('--image REPETIDO ⇒ coleta TODAS as ocorrências, na ordem', () => {
    const result = parseArgs([
      '-p',
      'compare',
      '--image',
      'a.png',
      '--image',
      'b.jpg',
      '--image=c.gif',
    ]);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.images).toEqual(['a.png', 'b.jpg', 'c.gif']);
    }
  });

  it('--image NÃO é confundido com o objetivo posicional', () => {
    const result = parseArgs(['minha tarefa', '--image', 'foto.png']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.goal).toBe('minha tarefa');
      expect(result.images).toEqual(['foto.png']);
    }
  });

  it('--image sem valor (próximo token é outra flag) ⇒ ocorrência IGNORADA (tolerante, sem usage-error)', () => {
    const result = parseArgs(['-p', 'oi', '--image', '--tier', 'aluy-flux']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.images).toBeUndefined();
      expect(result.tier).toBe('aluy-flux'); // --tier NÃO foi engolido como valor de --image.
    }
  });

  it('--image no fim do argv sem valor ⇒ ocorrência ignorada, sem quebrar o parse', () => {
    const result = parseArgs(['-p', 'oi', '--image']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.images).toBeUndefined();
      expect(result.printArg).toBe('oi');
    }
  });

  it('--image NÃO é reportado como flag desconhecida (F109)', () => {
    const result = parseArgs(['-p', 'oi', '--image', 'x.png']);
    expect(result.kind).toBe('launch');
    if (result.kind === 'launch') {
      expect(result.unknownFlags ?? []).not.toContain('--image');
    }
  });

  it('HELP_TEXT documenta --image (repetível)', () => {
    expect(HELP_TEXT).toContain('--image <path>');
    expect(HELP_TEXT).toMatch(/repetível/i);
  });
});
