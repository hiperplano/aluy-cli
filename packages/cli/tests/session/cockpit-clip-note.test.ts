// EST-1015 (fix fullscreen "texto embaralhado" — bug #1 do dono) — `clipNoteToFit` clipa
// as linhas de um bloco `note` p/ caber em `maxLines` ANTES do render, eliminando o gatilho
// do mis-clip do Ink 5.2.1 (um bloco alto — ex.: o /help, ~30 linhas — na conversa de altura
// fixa fazia o overflow:hidden MESCLAR caudas de linhas escondidas nas visíveis). PROVADO
// end-to-end por captura de PTY + emulador VT contra o binário real (corrupção sumiu).

import { describe, expect, it } from 'vitest';
import { clipNoteToFit } from '../../src/session/Cockpit.js';
import type { SessionBlock } from '../../src/session/model.js';

function note(n: number): SessionBlock {
  return { kind: 'note', title: 'comandos', lines: Array.from({ length: n }, (_, i) => `l${i}`) };
}

describe('clipNoteToFit (EST-1015)', () => {
  it('nota que CABE (linhas <= budget) passa INALTERADA', () => {
    const b = note(5);
    expect(clipNoteToFit(b, 20)).toBe(b); // mesma ref (sem cópia)
  });

  it('nota ALTA é clipada p/ caber ESTRITAMENTE abaixo de maxLines (reserva título+pad+folga)', () => {
    const b = note(40);
    const out = clipNoteToFit(b, 14);
    if (out.kind !== 'note') throw new Error('esperava note');
    // budget = max(1, 14-3) = 11; mostra 10 linhas + 1 indicador = 11 ⇒ +título+pad = 13 < 14.
    expect(out.lines.length).toBe(11);
    expect(out.lines.length).toBeLessThan(14 - 2); // título+pad ainda cabem sob maxLines
    expect(out.lines[out.lines.length - 1]).toMatch(/…\(\+30 linhas/); // 40 - 10 mostradas
    // as linhas mostradas são as PRIMEIRAS (ordem preservada).
    expect(out.lines.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `l${i}`));
  });

  it('maxLines minúsculo ⇒ ao menos 1 linha + indicador (não quebra)', () => {
    const out = clipNoteToFit(note(40), 2);
    if (out.kind !== 'note') throw new Error('esperava note');
    expect(out.lines.length).toBeGreaterThanOrEqual(1);
    expect(out.lines.at(-1)).toMatch(/…\(\+/);
  });

  it('bloco NÃO-note passa inalterado', () => {
    const you: SessionBlock = { kind: 'you', text: 'oi' } as SessionBlock;
    expect(clipNoteToFit(you, 5)).toBe(you);
  });
});
