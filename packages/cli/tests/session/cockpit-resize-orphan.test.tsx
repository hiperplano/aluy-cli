// EST-1015 (resize-órfão) — PROVA DE TELA: após `resetDiffer()` (o que o App faz no RESIZE
// dentro do cockpit), o full-paint do differ NÃO pode deixar CAUDA de linha velha quando uma
// linha ENCOLHE. O bug: o full-paint antigo (`home + body + \x1b[J`) só apagava ABAIXO do
// frame, não a cauda POR-LINHA ⇒ "◷ agentes" novo + "server(s)…" velho viravam um híbrido.
//
// Determinístico: dirige `createCockpitDiffer` direto (sem Ink/PTY) e reconstrói a TELA num
// emulador mínimo de grid (CUP/`\x1b[K`/`\x1b[J`). Não-tautológico: o código ANTIGO deixaria
// a cauda e falharia a asserção `line(1)`.

import { describe, expect, it } from 'vitest';
import { createCockpitDiffer } from '../../src/session/synchronized-output.js';

// O `clearTerminal` do Ink no alt-screen (prefixo que o differ reconhece como frame cheio).
const CLEAR_TERMINAL = '\x1b[2J\x1b[3J\x1b[H';

/** Emulador de grid mínimo: aplica os bytes que o differ emite e reconstrói a TELA. */
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

const frame = (...lines: string[]): string => CLEAR_TERMINAL + lines.join('\n');

describe('EST-1015 · ADR-0076 §5 — cockpit resize: full-paint não deixa cauda órfã (prova de tela)', () => {
  it('resetDiffer (resize) + linha que ENCOLHE ⇒ SEM cauda da linha velha', () => {
    const screen = new Screen(40, 5);
    const differ = createCockpitDiffer();

    // Frame ANTES do resize (linha do meio LONGA): pinta na entrada (tela limpa).
    screen.feed(differ.transform(frame('cabecalho', 'MCP: 3 server(s) longa', 'rodape')));
    expect(screen.line(1)).toBe('MCP: 3 server(s) longa');

    // RESIZE dentro do cockpit ⇒ o App chama resetDiffer() ⇒ próximo frame é full-paint, MAS
    // a tela AINDA tem o conteúdo velho (não foi limpa).
    differ.reset();
    screen.feed(differ.transform(frame('cabecalho', 'agentes', 'rodape')));

    // A linha do meio encolheu p/ "agentes" — NÃO pode sobrar "...server(s) longa" como cauda.
    expect(screen.line(1)).toBe('agentes');
    expect(screen.line(0)).toBe('cabecalho');
    expect(screen.line(2)).toBe('rodape');
  });

  it('resetDiffer + frame com MENOS linhas ⇒ linhas órfãs ABAIXO somem', () => {
    const screen = new Screen(40, 6);
    const differ = createCockpitDiffer();
    screen.feed(differ.transform(frame('a', 'b', 'c', 'd')));
    expect(screen.line(3)).toBe('d');

    differ.reset();
    screen.feed(differ.transform(frame('x', 'y'))); // encolheu em ALTURA
    expect(screen.line(0)).toBe('x');
    expect(screen.line(1)).toBe('y');
    expect(screen.line(2)).toBe(''); // a antiga 'c' foi varrida
    expect(screen.line(3)).toBe(''); // a antiga 'd' foi varrida
  });
});
