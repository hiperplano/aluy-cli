// EST-1015 (resíduo do #304) — PROVA DE TELA: o caminho `clearTerminal` do transform INLINE
// (`overwriteInPlace`, que dispara quando a região viva enche `rows` — saída grande/`bash`
// enorme) NÃO pode deixar cauda de linha velha quando uma linha ENCOLHE entre frames. O #304
// trocou o `\x1b[2J` (que apagava a tela toda) por `home + body`, matando o flicker MAS
// reintroduzindo a cauda órfã por-linha (a mesma classe do #340 no cockpit).
//
// Determinístico: dirige `overwriteInPlace` direto e reconstrói a TELA num emulador mínimo de
// grid. Não-tautológico: o código ANTERIOR (sem `\x1b[K` por linha) deixaria a cauda e falharia.

import { describe, expect, it } from 'vitest';
import { overwriteInPlace } from '../../src/session/synchronized-output.js';

// O `clearTerminal` do Ink (caminho `outputHeight>=rows`, inclusive no inline em saída grande).
const CLEAR_TERMINAL = '\x1b[2J\x1b[3J\x1b[H';

/** Emulador de grid mínimo: aplica os bytes que o transform emite e reconstrói a TELA. */
class Screen {
  cols: number;
  rows: number;
  grid: string[][];
  r = 0;
  c = 0;
  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
  }
  feed(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\x1b' && s[i + 1] === '[') {
        let j = i + 2;
        let num = '';
        while (j < s.length && /[0-9;?]/.test(s[j]!)) {
          num += s[j];
          j += 1;
        }
        const cmd = s[j];
        const args = num.split(';').map((x) => (x === '' ? undefined : parseInt(x, 10)));
        if (cmd === 'H' || cmd === 'f') {
          this.r = (args[0] ?? 1) - 1;
          this.c = (args[1] ?? 1) - 1;
        } else if (cmd === 'A') {
          this.r = Math.max(0, this.r - (args[0] ?? 1));
        } else if (cmd === 'G') {
          this.c = (args[0] ?? 1) - 1;
        } else if (cmd === 'K') {
          const row = this.grid[this.r];
          if (row) for (let x = this.c; x < this.cols; x++) row[x] = ' ';
        } else if (cmd === 'J') {
          const row = this.grid[this.r];
          if (row) for (let x = this.c; x < this.cols; x++) row[x] = ' ';
          for (let y = this.r + 1; y < this.rows; y++) this.grid[y]!.fill(' ');
        }
        i = j + 1;
        continue;
      }
      if (ch === '\n') {
        this.r = Math.min(this.rows - 1, this.r + 1);
        this.c = 0;
        i += 1;
        continue;
      }
      if (ch === '\r') {
        this.c = 0;
        i += 1;
        continue;
      }
      if (this.r < this.rows && this.c < this.cols) {
        this.grid[this.r]![this.c] = ch;
        this.c += 1;
      }
      i += 1;
    }
  }
  line(r: number): string {
    return this.grid[r]!.join('').replace(/\s+$/, '');
  }
}

const clearFrame = (...lines: string[]): string => CLEAR_TERMINAL + lines.join('\n');

describe('EST-1015 — inline clearTerminal (saída grande): SEM cauda órfã quando linha encolhe (prova de tela)', () => {
  it('frame grande → linha que ENCOLHE no frame seguinte ⇒ SEM rabo da velha', () => {
    const screen = new Screen(40, 5);

    // Frame 1 (região viva enche rows ⇒ Ink usa clearTerminal): linha 0 LONGA.
    screen.feed(overwriteInPlace(clearFrame('saída do comando bash AAAAA', 'meio', 'rodapé')));
    expect(screen.line(0)).toBe('saída do comando bash AAAAA');

    // Frame 2 (mesmo caminho clearTerminal): a linha 0 ENCOLHEU. NÃO pode sobrar a cauda.
    screen.feed(overwriteInPlace(clearFrame('curta', 'meio', 'rodapé')));
    expect(screen.line(0)).toBe('curta');
    expect(screen.line(1)).toBe('meio');
    expect(screen.line(2)).toBe('rodapé');
  });

  it('o transform NÃO emite \\x1b[2J (sem branqueamento — não regride o #304/#150)', () => {
    const out = overwriteInPlace(clearFrame('a longa AAAA', 'b'));
    expect(out.includes('\x1b[2J')).toBe(false);
    expect(out.startsWith('\x1b[H')).toBe(true); // abre com home (full-overwrite no lugar).
  });
});
