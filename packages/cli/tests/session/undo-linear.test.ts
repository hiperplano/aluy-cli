// EST-0960b — `/undo`/`/redo` em modo NÃO-TTY (linear, §9/DoD). Sem TTY não há
// prompt: a forma é linear (`[undo] …`), e em edição concorrente NÃO sobrescreve
// (fail-safe — confirmar exige um TTY). O aviso de barreira já vem REDIGIDO (R9).

import { describe, expect, it } from 'vitest';
import { runUndoLinear, type LinearOut, type LinearUndoControl } from '../../src/session/linear.js';
import type { UndoOutcome } from '../../src/session/undo-controller.js';

function makeOut(): { out: LinearOut; text: () => string } {
  let buf = '';
  return { out: { write: (c) => (buf += c) }, text: () => buf };
}

/** Controle fake que devolve outcomes pré-roteirizados. */
function control(undoOutcome: UndoOutcome, redoOutcome?: UndoOutcome): LinearUndoControl {
  return {
    undo: async () => undoOutcome,
    redo: async () => redoOutcome ?? undoOutcome,
  };
}

const noteUndo: UndoOutcome = {
  kind: 'note',
  note: { title: 'undo', lines: ['revertido: `a.ts`', 'pilha: 0 edição(ões) · 1 para refazer.'] },
};
const noteRedo: UndoOutcome = {
  kind: 'note',
  note: { title: 'redo', lines: ['reaplicado: `a.ts`'] },
};

describe('runUndoLinear — /undo /redo sem TTY', () => {
  it('linha que não é /undo|/redo ⇒ não trata (false)', async () => {
    const { out } = makeOut();
    expect(await runUndoLinear('explique o repo', out, control(noteUndo))).toBe(false);
    expect(await runUndoLinear('/model', out, control(noteUndo))).toBe(false);
  });

  it('/undo emite o feedback linear rotulado e TRATA (true)', async () => {
    const { out, text } = makeOut();
    const handled = await runUndoLinear('/undo', out, control(noteUndo));
    expect(handled).toBe(true);
    expect(text()).toContain('[undo] revertido: `a.ts`');
  });

  it('/redo emite o feedback linear rotulado', async () => {
    const { out, text } = makeOut();
    await runUndoLinear('/redo', out, control(noteUndo, noteRedo));
    expect(text()).toContain('[redo] reaplicado: `a.ts`');
  });

  it('edição concorrente sem TTY: AVISA e NÃO confirma (nada alterado)', async () => {
    const confirmOutcome: UndoOutcome = {
      kind: 'confirm',
      note: { title: 'undo — confirmar', lines: ['o arquivo `a.ts` mudou desde a edição'] },
      proceed: async () => noteUndo,
    };
    const { out, text } = makeOut();
    await runUndoLinear('/undo', out, control(confirmOutcome));
    const t = text();
    expect(t).toContain('mudou desde a edição');
    expect(t).toContain('nada foi alterado');
  });

  it('o aviso de barreira já chega REDIGIDO (R9) — o linear só repassa', async () => {
    const barrierOutcome: UndoOutcome = {
      kind: 'note',
      note: {
        title: 'undo',
        lines: [
          '⚠ aqui rodou `curl -H "Authorization: Bearer ‹redigido›"` — efeito de shell NÃO é reversível (não desfeito).',
        ],
      },
    };
    const { out, text } = makeOut();
    await runUndoLinear('/undo', out, control(barrierOutcome));
    expect(text()).toContain('‹redigido›');
    expect(text()).not.toContain('Bearer sk-');
  });
});
