// BUG (relato do dono) — "troquei o modelo no onboard e ele não fixou o novo".
//
// MEDIDO no TTY antes do conserto: o campo do modelo vem pré-preenchido com o default do
// provider; digitar `meu/modelo-NOVO` produzia, no config,
// `anthropic/claude-3.5-sonnetmeu/modelo-NOVO`. Não era "não fixa" — fixava um slug
// COLADO, que provider nenhum conhece, e o dono não tinha pista do porquê.
import { describe, expect, it } from 'vitest';
import { digitarNoCampo, resolveOnboardLocalModel } from '../../src/session/onboard.js';

describe('campo pré-preenchido — a sugestão é substituída, não concatenada', () => {
  it('A ORIGEM — a 1ª tecla sobre a sugestão SUBSTITUI', () => {
    const r = digitarNoCampo({ buf: 'anthropic/claude-3.5-sonnet', ehSugestao: true }, 'm');
    expect(r).toEqual({ buf: 'm', ehSugestao: false });
  });

  it('as teclas SEGUINTES concatenam normalmente', () => {
    let e = { buf: 'anthropic/claude-3.5-sonnet', ehSugestao: true };
    for (const t of 'meu/modelo') e = digitarNoCampo(e, t);
    expect(e.buf).toBe('meu/modelo'); // ANTES: 'anthropic/claude-3.5-sonnetmeu/modelo'
  });

  it('campo que NÃO é sugestão (digitado do zero) concatena desde a 1ª tecla', () => {
    let e = { buf: '', ehSugestao: false };
    for (const t of 'abc') e = digitarNoCampo(e, t);
    expect(e.buf).toBe('abc');
  });

  it('digitar sobre texto já editado nunca apaga o que o usuário escreveu', () => {
    const r = digitarNoCampo({ buf: 'meu/mode', ehSugestao: false }, 'l');
    expect(r.buf).toBe('meu/model');
  });

  it('o slug colado chegaria ao config — é o que o conserto impede', () => {
    // Prova o elo: o valor do campo é o que `resolveOnboardLocalModel` grava.
    let e = { buf: 'anthropic/claude-3.5-sonnet', ehSugestao: true };
    for (const t of 'meu/modelo') e = digitarNoCampo(e, t);
    expect(
      resolveOnboardLocalModel({ providerId: 'openrouter', model: e.buf, customModel: '' }),
    ).toBe('meu/modelo');
  });
});
