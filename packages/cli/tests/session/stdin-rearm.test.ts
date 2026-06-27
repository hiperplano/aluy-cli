// EST-1015 (🔴 fix do composer "morto") — guarda a regressão: o stdin é REATADO (resume) em
// QUALQUER TTY, NÃO só win32. O bug real (composer não digita nada no Linux/Mac) era exatamente
// o `resume()` gated por plataforma; este teste FALHA se alguém re-introduzir um gate de SO.

import { describe, expect, it, vi } from 'vitest';
import { rearmStdinForInk } from '../../src/session/stdin-rearm.js';

describe('rearmStdinForInk — reata o stdin pausado antes do Ink (EST-1015)', () => {
  it('TTY ⇒ chama resume() (independente da plataforma — guarda a regressão win32-only)', () => {
    const resume = vi.fn();
    const did = rearmStdinForInk({ isTTY: true, resume });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(did).toBe(true);
  });

  it('NÃO-TTY (pipe/redireção) ⇒ no-op (não há reader a reativar)', () => {
    const resume = vi.fn();
    expect(rearmStdinForInk({ isTTY: false, resume })).toBe(false);
    expect(rearmStdinForInk({ resume })).toBe(false); // isTTY ausente
    expect(resume).not.toHaveBeenCalled();
  });

  it('resume ausente ou que LANÇA ⇒ best-effort (não propaga, devolve false)', () => {
    expect(rearmStdinForInk({ isTTY: true })).toBe(false); // sem resume
    const throwing = vi.fn(() => {
      throw new Error('EBADF');
    });
    expect(rearmStdinForInk({ isTTY: true, resume: throwing })).toBe(false);
    expect(throwing).toHaveBeenCalledTimes(1);
  });
});
