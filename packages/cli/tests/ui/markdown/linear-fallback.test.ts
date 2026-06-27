// EST · acabamento TUI — FALLBACK não-TTY/linear (DoD obrigatório): quando a fala
// do agente traz markdown + bloco de código, a saída LINEAR (piped/CI, sem TTY)
// continua TEXTO CRU LEGÍVEL e SEM ANSI. O markdown/realce é acabamento da TUI
// (Ink); o caminho linear nunca o aciona — `linearize` só concatena strings.

import { describe, expect, it } from 'vitest';
import { linearize } from '../../../src/session/linear.js';
import type { SessionBlock } from '../../../src/session/model.js';

// Detecta QUALQUER sequência ANSI (CSI/OSC) — prova "sem ANSI".
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]|${ESC}\\][^]*`);

describe('não-TTY/linear — markdown vira texto cru sem ANSI', () => {
  it('fala com **negrito**, lista e ```ts``` sai legível e sem escape', () => {
    const text = [
      'Plano: trocar o **httpClient** por broker.',
      '- passo um',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');
    const block: SessionBlock = { kind: 'aluy', text, streaming: false };
    const line = linearize(block);
    expect(line).toMatch(/^\[aluy\] /); // rótulo de texto plano
    expect(line).not.toMatch(ANSI); // NENHUM código de escape
    expect(line).toContain('httpClient'); // conteúdo preservado, legível
    expect(line).toContain('const x = 1;');
  });
});
