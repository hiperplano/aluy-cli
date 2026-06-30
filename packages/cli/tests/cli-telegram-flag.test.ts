// ADR-0134/0135 — `--telegram` ATIVA a bridge no boot. Prova o parsing (não a ativação,
// que é testada em telegram-activation.test.ts). Default OFF (não-regressão: inerte como hoje).

import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('parseArgs — --telegram', () => {
  it('sem --telegram ⇒ telegram:false (bridge inerte, como hoje)', () => {
    const a = parseArgs([]);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.telegram).toBe(false);
  });

  it('--telegram ⇒ telegram:true', () => {
    const a = parseArgs(['--telegram']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') expect(a.telegram).toBe(true);
  });

  it('--telegram NÃO é tratado como flag desconhecida (sem aviso de typo)', () => {
    const a = parseArgs(['--telegram']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.unknownFlags ?? []).not.toContain('--telegram');
    }
  });

  it('`aluy telegram <sub>` (subcomando) NÃO colide com a flag de launch', () => {
    // O subcomando `telegram` é uma AÇÃO distinta (login/status/…), não um launch.
    const a = parseArgs(['telegram', 'status']);
    expect(a.kind).toBe('telegram');
  });
});
