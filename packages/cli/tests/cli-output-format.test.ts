// F175 — testes do parser `--output-format` (headless). Valida: os 3 formatos
// aceitos passam; um valor INVÁLIDO vira usage-error (exit 2) ANTES de qualquer
// turno — antes era aceito silenciosamente e o headless rodava o modelo sem
// imprimir nada (nem text, nem json).

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('--output-format flag parsing (F175)', () => {
  for (const fmt of ['text', 'json', 'stream-json'] as const) {
    it(`-p + --output-format ${fmt} ⇒ launch (aceito)`, () => {
      const r = parseArgs(['-p', 'oi', '--output-format', fmt]);
      expect(r.kind).toBe('launch');
      if (r.kind === 'launch') expect(r.outputFormat).toBe(fmt);
    });
  }

  it('--output-format xml (inválido) ⇒ usage-error (exit 2), NÃO roda o turno', () => {
    const r = parseArgs(['-p', 'oi', '--output-format', 'xml']);
    expect(r.kind).toBe('usage-error');
    if (r.kind === 'usage-error') {
      expect(r.exitCode).toBe(2);
      expect(r.message).toContain('output-format');
      expect(r.message).toContain('xml');
    }
  });

  it('--output-format=json (forma com =) ⇒ aceito', () => {
    const r = parseArgs(['-p', 'oi', '--output-format=json']);
    expect(r.kind).toBe('launch');
    if (r.kind === 'launch') expect(r.outputFormat).toBe('json');
  });

  it('sem -p: --output-format é ignorado (só vale no headless) ⇒ não vira usage-error', () => {
    const r = parseArgs(['--output-format', 'xml']);
    // fora do headless o outputFormat nem é lido ⇒ não há o que validar (launch normal).
    expect(r.kind).toBe('launch');
  });
});
